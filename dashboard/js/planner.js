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
    el.textContent = 'Not enough historical data yet — check back in a few days.';
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
      ${label} — <strong>${DAYS[c.wd]} at ${c.hr}:00</strong>
      <span style="color:var(--muted);font-size:12px"> (${pct}% of machines busy historically)</span>
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

  function updateSim() {
    const n = parseInt(slider.value);
    countEl.textContent = n;
    const capacity = n * AVAILABLE_MINS_PER_DAY;
    const util = Math.min(100, (avgDailyDemandMins / capacity) * 100);
    const utilStr = util.toFixed(1);
    const indicator = util >= 85 ? '🔴 High strain' : util >= 60 ? '🟡 Moderate' : '🟢 Comfortable';
    resultEl.innerHTML = `
      With <strong>${n} machine${n>1?'s':''}</strong> available 9:00–18:00:<br>
      Estimated utilisation rate <strong>${utilStr}%</strong> ${indicator}<br>
      <span style="color:var(--muted);font-size:12px">Based on last 30 days avg demand: ${Math.round(avgDailyDemandMins)} machine-min/day</span>
    `;
  }

  slider.addEventListener('input', updateSim);
  updateSim();
}

// ── 3.3 Maintenance Window Suggestion ─────────────────────────────────────────
let maintenanceMachines = null; // cached so repeat inits don't re-fetch/re-populate the <select>

async function initMaintenanceWindow() {
  const select = document.getElementById('maintenance-select');
  const result = document.getElementById('maintenance-result');

  // Populate machine list — only once (guard against duplicate <option>s
  // piling up now that initPlanner can legitimately run again on a revisit).
  if (select.options.length <= 1) {
    const { data } = await db
      .from('machines')
      .select('id, name, lab')
      .order('name');
    maintenanceMachines = data;

    if (data) {
      data.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = `${m.name} (${m.lab})`;
        select.appendChild(opt);
      });
    }
  }
  const machines = maintenanceMachines;

  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  if (select.dataset.wired) return; // listener only needs to be attached once
  select.dataset.wired = '1';
  select.addEventListener('change', async () => {
    const mid = select.value;
    if (!mid) { result.textContent = 'Select a machine to see the best maintenance window.'; return; }
    result.textContent = 'Analysing…';

    const since = new Date(Date.now() - 28 * 24 * 3600_000).toISOString();
    const { data, error } = await db.rpc('usage_by_weekday_hour', { since, machine_filter: mid });
    if (error) console.error('initMaintenanceWindow RPC error', error);

    const totalSamples = (data || []).reduce((a, r) => a + Number(r.total), 0);
    if (!data || totalSamples < 10) {
      result.textContent = 'Not enough data for this machine yet.';
      return;
    }

    // Build weekday × hour usage for this machine from the aggregated rows
    const total_m = Array.from({length:7}, () => Array(24).fill(0));
    const active_m = Array.from({length:7}, () => Array(24).fill(0));
    for (const row of data) {
      total_m[row.weekday][row.hour] = row.total;
      active_m[row.weekday][row.hour] = row.active_count;
    }

    // Find lowest-usage 2-hour window Mon–Fri 8:00–20:00
    let best = null;
    for (let wd = 1; wd <= 5; wd++) {
      for (let hr = 8; hr <= 18; hr++) {
        const t1 = total_m[wd][hr], t2 = total_m[wd][hr+1] || 0;
        if (t1 + t2 < 4) continue;
        const rate = (active_m[wd][hr] + (active_m[wd][hr+1]||0)) / (t1 + t2 || 1);
        if (!best || rate < best.rate) best = { wd, hr, rate };
      }
    }

    if (!best) {
      result.textContent = 'Could not determine a maintenance window (insufficient data).';
      return;
    }

    const pct = Math.round(best.rate * 100);
    const machineName = machines?.find(m => m.id === mid)?.name || mid;
    result.innerHTML = `
      Recommended maintenance window for <strong>${machineName}</strong>:<br>
      🔧 <strong>${DAYS[best.wd]} ${best.hr}:00–${best.hr+2}:00</strong>
      <span style="color:var(--muted);font-size:12px"> (only ${pct}% busy historically — lowest disruption)</span>
    `;
  });
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
    const avgRemSecs = remSamples > 0 ? sumRem / remSamples : 0;
    // Probability all machines busy × avg remaining time
    // Simplified: if <80% busy, wait ≈ 0; else scale by occupancy
    let waitMins;
    if (avgOccupancy < 0.5) {
      waitMins = 0;
    } else {
      // Expected wait ≈ avg_remaining × (occupancy)² (heuristic)
      waitMins = Math.round((avgRemSecs / 60) * Math.pow(avgOccupancy, 2));
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
function fmt_mins_left(secs) {
  const m = Math.round(secs / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m/60)}h ${m%60}m`;
}

async function fetchBusyMachines() {
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data } = await db
    .from('machine_status_logs')
    .select('machine_id, job_remaining, state, online, timestamp, machines(name)')
    .gte('timestamp', since)
    .order('timestamp', { ascending: false });

  if (!data) return [];
  const seen = new Set(), busy = [];
  for (const row of data) {
    if (seen.has(row.machine_id)) continue;
    seen.add(row.machine_id);
    if (row.online && ['PRINTING','BUSY'].includes((row.state||'').toUpperCase()) && row.job_remaining > 0) {
      busy.push({ id: row.machine_id, name: row.machines?.name || row.machine_id, remaining: row.job_remaining });
    }
  }
  return busy;
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
    card.innerHTML = `<div class="planner-result-text">Not enough machines printing right now to play — check back when a few are busy at once.</div>`;
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
