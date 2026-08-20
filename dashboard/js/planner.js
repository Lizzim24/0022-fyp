/* planner.js — Tab 3: Scenario Planner
   Features: 3.1 Best Time · 3.2 Capacity Simulator ·
             3.3 Maintenance Window · 3.4 Average Wait Time     */

// Was a permanent "only ever run once" flag — meant that if the very first
// tab-planner event happened to hit a transient issue (cold Supabase
// connection, container still mid-layout, etc.), 3.1/3.2/3.4 stayed stuck on
// their "not enough data" empty states forever, since nothing ever retried.
// Now this only prevents two *overlapping* runs; a normal revisit re-fetches.
let plannerRunning = false;
let plannerHeatmap = null; // weekday×hour usage rates, cached for reuse

// Machine count used to be hardcoded to 13 in several places on this site;
// pull it live from Supabase instead (live.js also caches it on window.LAB_MACHINE_COUNT).

// ── Mini printer icons (inline SVG) ───────────────────────────────────────────
// One recognisable silhouette per model family, reused by the capacity
// simulator and the maintenance grid so machines read as machines, not text.
function printerIconSVG(mtype, accent) {
  const t = String(mtype || '').toLowerCase();
  const isBambu = t.includes('x1') || t.includes('carbon') || t.includes('h2d');
  // Brand-true accents: Bambu green, Prusa orange (overridable)
  const c = accent || (isBambu ? '#00AE42' : '#E84800');
  if (t.includes('x1') || t.includes('carbon')) return `
    <svg viewBox="0 0 44 44" width="44" height="44">
      <rect x="6" y="5" width="32" height="36" rx="4" fill="#23272B"/>
      <rect x="10" y="7" width="24" height="5" rx="1.5" fill="#3a4047"/>
      <rect x="10" y="15" width="24" height="20" rx="2" fill="#4a5560"/>
      <path d="M12 33 L30 17 L34 17 L16 33 Z" fill="#5d6a76"/>
      <rect x="10" y="15" width="24" height="20" rx="2" fill="none" stroke="${c}" stroke-width="1.4"/>
      <circle cx="22" cy="39" r="1.5" fill="${c}"/>
    </svg>`;
  if (t.includes('h2d')) return `
    <svg viewBox="0 0 44 44" width="44" height="44">
      <rect x="2" y="6" width="40" height="34" rx="4" fill="#23272B"/>
      <rect x="6" y="8" width="32" height="4" rx="1.5" fill="${c}"/>
      <rect x="7" y="15" width="30" height="19" rx="2" fill="#4a5560"/>
      <path d="M9 32 L26 17 L30 17 L13 32 Z" fill="#5d6a76"/>
      <circle cx="18" cy="38.5" r="1.5" fill="${c}"/>
      <circle cx="26" cy="38.5" r="1.5" fill="${c}"/>
    </svg>`;
  if (t.includes('xl')) return `
    <svg viewBox="0 0 44 44" width="44" height="44"><rect x="5" y="8" width="4" height="30" fill="#1E1E1E"/><rect x="35" y="8" width="4" height="30" fill="#1E1E1E"/><rect x="5" y="8" width="34" height="4" fill="#1E1E1E"/><rect x="9" y="30" width="26" height="4" fill="${c}"/><rect x="18" y="12" width="8" height="8" rx="1" fill="${c}"/></svg>`;
  return `
    <svg viewBox="0 0 44 44" width="44" height="44"><rect x="8" y="4" width="28" height="36" rx="3" fill="#1E1E1E"/><rect x="12" y="10" width="20" height="22" rx="2" fill="#3a4a55"/><rect x="8" y="4" width="4" height="36" rx="2" fill="${c}"/><rect x="32" y="4" width="4" height="36" rx="2" fill="${c}"/></svg>`;
}

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

async function getMachineCount() {
  if (window.LAB_MACHINE_COUNT) return window.LAB_MACHINE_COUNT;
  const { count } = await db.from('machines').select('id', { count: 'exact', head: true });
  return count || 13;
}

// ── Build usage table via the usage_by_weekday_hour() RPC (added 5 July) ──────
// Previously this pulled raw machine_status_logs rows with .limit(80000) and
// no .order() — at current data volume (~24k rows/day system-wide) a 28-day
// window holds 650k+ rows, so the client only ever saw an arbitrary,
// unordered 80k-row slice of it. That's what made 3.1/3.2 look like "not
// enough data" even though the underlying history is there. The RPC
// aggregates server-side and always returns at most 168 rows.
let usageTableInflight = null; // share one in-flight request between 3.1 and 3.3

async function fetchUsageTable() {
  if (plannerHeatmap) return plannerHeatmap;
  // Best-time and Wait-time both call this on tab open; without dedup they
  // fired two identical heavy RPCs in parallel. Share one promise instead.
  if (usageTableInflight) return usageTableInflight;
  usageTableInflight = fetchUsageTableOnce();
  const result = await usageTableInflight;
  usageTableInflight = null;
  return result;
}

async function fetchUsageTableOnce() {
  const since = new Date(Date.now() - 28 * 24 * 3600_000).toISOString();
  let data = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await db.rpc('usage_by_weekday_hour', { since });
    if (!res.error && res.data && res.data.length) { data = res.data; break; }
    console.warn(`fetchUsageTable attempt ${attempt} failed`, res.error);
    if (attempt === 1) await new Promise(r => setTimeout(r, 1500)); // brief pause, then one retry
  }
  if (!data) return null;

  const total = Array.from({length:7}, () => Array(24).fill(0));
  const active_cnt = Array.from({length:7}, () => Array(24).fill(0));
  const rem_sum = Array.from({length:7}, () => Array(24).fill(0));
  const rem_cnt = Array.from({length:7}, () => Array(24).fill(0));

  for (const row of data) {
    total[row.weekday][row.hour]      = row.total;
    active_cnt[row.weekday][row.hour] = row.active_count;
    rem_sum[row.weekday][row.hour]    = row.rem_sum;
    rem_cnt[row.weekday][row.hour]    = row.rem_cnt;
  }

  plannerHeatmap = { total, active_cnt, rem_sum, rem_cnt };
  return plannerHeatmap;
}

// ── 3.1 Best Time to Visit ─────────────────────────────────────────────────────
async function initBestTime() {
  const el = document.getElementById('best-time-result');
  const tbl = await fetchUsageTable();

  if (!tbl) {
    el.textContent = 'Not enough historical data yet. Check back in a few days.';
    return;
  }

  // Find the 3 lowest-usage Mon–Fri 9:00–18:00 slots
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const candidates = [];

  for (let wd = 1; wd <= 5; wd++) { // Mon-Fri
    for (let hr = 9; hr < 18; hr++) {
      const n = tbl.total[wd][hr];
      if (n < 3) continue; // not enough data
      const rate = tbl.active_cnt[wd][hr] / n;
      candidates.push({ wd, hr, rate, n });
    }
  }

  if (!candidates.length) {
    el.textContent = 'Not enough weekday data yet.';
    return;
  }

  candidates.sort((a, b) => a.rate - b.rate);
  const top3 = candidates.slice(0, 3);

  const lines = top3.map((c, i) => {
    const pct = Math.round(c.rate * 100);
    const label = i === 0 ? '🥇 Best' : i === 1 ? '🥈 2nd' : '🥉 3rd';
    return `<div style="margin:6px 0">
      ${label}: <strong>${DAYS[c.wd]} at ${c.hr}:00</strong>
      <span style="color:var(--muted);font-size:12px"> (${pct}% of machines busy at this time historically)</span>
    </div>`;
  });

  el.innerHTML = lines.join('');
}

// ── 3.2 Capacity Simulator ─────────────────────────────────────────────────────
async function initCapacitySimulator() {
  const slider = document.getElementById('sim-slider');
  const countEl = document.getElementById('sim-count');
  const resultEl = document.getElementById('sim-result');

  // Fetch average daily demand (total machine-minutes active across all machines in last 30 days)
  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString().split('T')[0];
  const { data } = await db
    .from('machine_daily_summary')
    .select('total_active_minutes, date')
    .gte('date', since);

  // Fallback demand if no daily_summary data
  let avgDailyDemandMins = 120; // conservative fallback: 2h/machine/day
  if (data && data.length) {
    // Sum total_active_minutes across all machines per day, then average
    const byDate = {};
    for (const row of data) {
      byDate[row.date] = (byDate[row.date] || 0) + (row.total_active_minutes || 0);
    }
    const days = Object.values(byDate);
    avgDailyDemandMins = days.reduce((a, b) => a + b, 0) / days.length;
  }

  const AVAILABLE_MINS_PER_DAY = 9 * 60; // 9am–6pm = 9h per machine

  // Initialise slider from the real machine count instead of a hardcoded 13
  const machineCount = await getMachineCount();
  slider.max = Math.max(20, machineCount + 5);
  slider.value = machineCount;
  countEl.textContent = machineCount;

  const iconsEl = document.getElementById('sim-icons');

  function updateSim() {
    const n = parseInt(slider.value);
    countEl.textContent = n;
    const capacity = n * AVAILABLE_MINS_PER_DAY;
    const util = Math.min(100, (avgDailyDemandMins / capacity) * 100);
    const utilStr = util.toFixed(1);
    const indicator = util >= 85 ? '🔴 High strain' : util >= 60 ? '🟡 Moderate' : '🟢 Comfortable';
    const tone = util >= 85 ? '#dc2626' : util >= 60 ? '#ea580c' : '#16a34a';

    // Visual: solid printers = machines the average demand keeps busy,
    // faded printers = spare headroom at this fleet size.
    if (iconsEl) {
      const busy = Math.min(n, Math.ceil((util / 100) * n));
      iconsEl.innerHTML = Array.from({length: n}, (_, i) =>
        `<span style="opacity:${i < busy ? 1 : 0.22}" title="${i < busy ? 'kept busy by demand' : 'spare capacity'}">${printerIconSVG('coreone', tone)}</span>`
      ).join('');
    }

    resultEl.innerHTML = `
      With <strong>${n} machine${n>1?'s':''}</strong> available 9:00–18:00, estimated utilisation is <strong>${utilStr}%</strong> ${indicator}<br>
      <span style="color:var(--muted);font-size:12px">Solid printers are kept busy by the average demand of the last 30 days (${Math.round(avgDailyDemandMins)} machine-minutes per day). Faded ones are spare capacity.</span>
    `;
  }

  slider.addEventListener('input', updateSim);
  updateSim();
}

// ── 3.3 Maintenance Window Suggestion ─────────────────────────────────────────
async function initMaintenanceWindow() {
  const grid = document.getElementById('maintenance-grid');
  if (!grid || grid.dataset.done) return;

  const { data: machines } = await db.from('machines')
    .select('id, name, lab, machine_type')
    .order('lab').order('name');
  if (!machines || !machines.length) {
    grid.innerHTML = '<p style="color:#999;font-size:12px">No machines registered yet.</p>';
    return;
  }

  // One aggregated call per machine. These hit the hourly matview, so all 13
  // return in well under a second combined.
  const since = new Date(Date.now() - 28 * 24 * 3600_000).toISOString();
  const results = await Promise.all(
    machines.map(m => db.rpc('usage_by_weekday_hour', { since, machine_filter: m.id }))
  );

  const cards = machines.map((m, idx) => {
    const { data } = results[idx] || {};
    const head = `${printerIconSVG(m.machine_type)}<div><div class="m-name">${m.name}</div><div class="m-lab">${m.lab || ''} · ${m.machine_type || ''}</div>`;

    const totalSamples = (data || []).reduce((a, r) => a + Number(r.total), 0);
    if (!data || totalSamples < 10) {
      return `<div class="maint-card">${head}<div class="m-window" style="color:#999">Not enough data yet</div></div></div>`;
    }

    const total_m = Array.from({length:7}, () => Array(24).fill(0));
    const active_m = Array.from({length:7}, () => Array(24).fill(0));
    for (const row of data) {
      total_m[row.weekday][row.hour] = Number(row.total);
      active_m[row.weekday][row.hour] = Number(row.active_count);
    }

    // Lowest-usage 2-hour window, Mon to Fri, 8:00 to 20:00
    let best = null;
    for (let wd = 1; wd <= 5; wd++) {
      for (let hr = 8; hr <= 18; hr++) {
        const t = total_m[wd][hr] + (total_m[wd][hr+1] || 0);
        if (t < 4) continue;
        const rate = (active_m[wd][hr] + (active_m[wd][hr+1] || 0)) / t;
        if (!best || rate < best.rate) best = { wd, hr, rate };
      }
    }
    if (!best) {
      return `<div class="maint-card">${head}<div class="m-window" style="color:#999">Not enough weekday data</div></div></div>`;
    }
    const pct = Math.round(best.rate * 100);
    return `<div class="maint-card">${head}
      <div class="m-window">🔧 <strong>${DAY_NAMES[best.wd].slice(0,3)} ${best.hr}:00–${best.hr+2}:00</strong><br>
      <span style="color:var(--muted);font-size:11px">${pct}% busy at that time historically</span></div>
    </div></div>`;
  });

  grid.innerHTML = cards.join('');
  grid.dataset.done = '1';
}

// ── 3.4 Average Wait Time ─────────────────────────────────────────────────────
async function initWaitTime() {
  const grid = document.getElementById('wait-grid');
  const tbl = await fetchUsageTable();

  if (!tbl) {
    grid.innerHTML = '<p style="color:#999;font-size:12px">Not enough data yet.</p>';
    return;
  }

  // For each working hour 8–20, estimate expected wait:
  // avg_wait ≈ (active_fraction × avg_job_remaining_when_active) or 0 if idle
  const TOTAL_MACHINES = await getMachineCount(); // was hardcoded to 13
  const cells = [];

  for (let hr = 8; hr <= 19; hr++) {
    let sumRate = 0, sumRem = 0, remSamples = 0, n = 0;
    // Average across Mon–Fri (wd 1–5)
    for (let wd = 1; wd <= 5; wd++) {
      const t = tbl.total[wd][hr];
      if (t === 0) continue;
      sumRate += tbl.active_cnt[wd][hr] / t;
      sumRem  += tbl.rem_sum[wd][hr];
      remSamples += tbl.rem_cnt[wd][hr];
      n++;
    }
    if (n === 0) { cells.push(`<div class="wait-cell"><div class="wait-cell-hour">${hr}:00</div><div class="wait-cell-val" style="color:#ccc">—</div></div>`); continue; }

    const avgOccupancy = sumRate / n; // fraction of machines busy
    // usage_by_weekday_hour() normalises vendor-native remaining-time
    // values to MINUTES at the query layer.
    // verified against real print durations. Previously this was divided by 60
    // again down below, making every wait estimate ~60x too short.
    const avgRemMins = remSamples > 0 ? sumRem / remSamples : 0;
    // Probability all machines busy × avg remaining time
    // Simplified: if <80% busy, wait ≈ 0; else scale by occupancy
    let waitMins;
    if (avgOccupancy < 0.5) {
      waitMins = 0;
    } else {
      // Expected wait ≈ avg_remaining × (occupancy)² (heuristic)
      waitMins = Math.round(avgRemMins * Math.pow(avgOccupancy, 2));
    }

    const color = waitMins === 0 ? '#16a34a' : waitMins < 15 ? '#ea580c' : '#dc2626';
    const label = waitMins === 0 ? 'Free' : waitMins + 'm';
    cells.push(`<div class="wait-cell">
      <div class="wait-cell-hour">${hr}:00</div>
      <div class="wait-cell-val" style="color:${color}">${label}</div>
    </div>`);
  }

  grid.innerHTML = cells.join('');
}

// ── 3.2 Guess Who's Next Free — a playful spin on the wait-time estimate ──────
// Shows the machines currently printing (times hidden), visitor picks who
// they think will finish first, then reveals the real remaining times.
function fmt_mins_left(mins) {
  // Query-layer values are normalised to MINUTES.
  const m = Math.round(mins);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m/60)}h ${m%60}m`;
}

async function fetchBusyMachines() {
  const cutoff = Date.now() - 5 * 60 * 1000;

  const { data, error } = await db.rpc('latest_status_per_machine');

  if (error || !data) {
    console.warn('fetchBusyMachines failed', error);
    return [];
  }

  return data
    .filter(r =>
      r.online &&
      r.timestamp &&
      new Date(r.timestamp).getTime() >= cutoff &&
      ['PRINTING', 'BUSY'].includes((r.state || '').toUpperCase()) &&
      Number(r.job_remaining) > 0
    )
    .map(r => ({
      id: r.machine_id,
      name: r.machine_name || r.machine_id,
      remaining: Number(r.job_remaining)   // already normalised to minutes
    }));
}

function renderGuessPrompt(card, machines) {
  let guessId = null;
  card.innerHTML = `
    <div class="planner-result-text" style="margin-bottom:12px">Which of these ${machines.length} machines do you think will free up <strong>first</strong>?</div>
    <div class="wait-grid" id="guess-choices" style="grid-template-columns:repeat(auto-fill,minmax(110px,1fr))">
      ${machines.map(m => `<div class="wait-cell" data-gid="${m.id}" style="cursor:pointer"><div class="wait-cell-hour">${m.name}</div><div class="wait-cell-val" style="color:var(--muted)">?</div></div>`).join('')}
    </div>
    <button class="btn-ghost" id="guess-reveal" style="margin-top:14px;padding:8px 16px;font-size:10px" disabled>Pick a machine first</button>
  `;

  const choiceEls = card.querySelectorAll('#guess-choices .wait-cell');
  const revealBtn = card.querySelector('#guess-reveal');
  choiceEls.forEach(el => el.addEventListener('click', () => {
    guessId = el.dataset.gid;
    choiceEls.forEach(c => c.style.outline = '');
    el.style.outline = '2px solid var(--accent)';
    revealBtn.disabled = false;
    revealBtn.textContent = 'Reveal the answer →';
  }));

  revealBtn.addEventListener('click', () => {
    const ranked = [...machines].sort((a, b) => a.remaining - b.remaining);
    const winner = ranked[0];
    const correct = guessId === winner.id;
    card.innerHTML = `
      <div class="planner-result-text" style="margin-bottom:10px">
        ${correct ? '🎉 Correct!' : '❌ Not quite —'} <strong>${winner.name}</strong> frees up first, in <strong>${fmt_mins_left(winner.remaining)}</strong>.
      </div>
      <div class="wait-grid" style="grid-template-columns:repeat(auto-fill,minmax(110px,1fr))">
        ${ranked.map((m,i) => `<div class="wait-cell"${m.id===guessId ? ' style="outline:2px solid var(--accent)"' : ''}>
          <div class="wait-cell-hour">${i===0?'🥇 ':''}${m.name}</div>
          <div class="wait-cell-val" style="color:${i===0?'var(--green)':'var(--text)'}">${fmt_mins_left(m.remaining)}</div>
        </div>`).join('')}
      </div>
      <button class="btn-ghost" id="guess-again" style="margin-top:14px;padding:8px 16px;font-size:10px">🔄 Play again</button>
    `;
    card.querySelector('#guess-again').addEventListener('click', () => initGuessGame(true));
  });
}

async function initGuessGame(forceRefresh) {
  const card = document.getElementById('guess-game-card');
  if (!card) return;
  if (!forceRefresh) card.innerHTML = '<div class="planner-result-text">Loading current activity…</div>';

  const machines = await fetchBusyMachines();
  if (machines.length < 2) {
    card.innerHTML = `<div class="planner-result-text">Not enough machines printing right now to play. Check back when a few are busy at once.</div>`;
    return;
  }
  // Cap at 6 so the guessing grid stays readable
  const pool = machines.length > 6 ? machines.sort(() => Math.random()-0.5).slice(0,6) : machines;
  renderGuessPrompt(card, pool);
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function initPlanner() {
  if (plannerRunning) return;
  plannerRunning = true;

  try {
    await Promise.all([
      initBestTime(),
      initGuessGame(),
      initCapacitySimulator(),
      initMaintenanceWindow(),
      initWaitTime(),
    ]);
  } finally {
    plannerRunning = false;
  }
}

window.addEventListener('tab-planner', initPlanner);
