/* planner.js — Tab 3: Scenario Planner
   Features: 3.1 Best Time · 3.2 Capacity Simulator ·
             3.3 Maintenance Window · 3.4 Average Wait Time     */

let plannerInited = false;
let plannerHeatmap = null; // weekday×hour usage rates, cached for reuse

// ── Build usage table from logs ────────────────────────────────────────────────
async function fetchUsageTable() {
  if (plannerHeatmap) return plannerHeatmap;

  const since = new Date(Date.now() - 28 * 24 * 3600_000).toISOString();
  const { data } = await db
    .from('machine_status_logs')
    .select('timestamp, active, job_remaining, machine_id')
    .gte('timestamp', since)
    .limit(80000);

  if (!data || !data.length) return null;

  const total = Array.from({length:7}, () => Array(24).fill(0));
  const active_cnt = Array.from({length:7}, () => Array(24).fill(0));
  const rem_sum = Array.from({length:7}, () => Array(24).fill(0));
  const rem_cnt = Array.from({length:7}, () => Array(24).fill(0));

  for (const row of data) {
    const d  = new Date(row.timestamp);
    const wd = d.getDay();
    const hr = d.getHours();
    total[wd][hr]++;
    if (row.active) active_cnt[wd][hr]++;
    if (row.job_remaining > 0) {
      rem_sum[wd][hr] += row.job_remaining;
      rem_cnt[wd][hr]++;
    }
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
    .select('total_active_minutes, summary_date')
    .gte('summary_date', since);

  // Fallback demand if no daily_summary data
  let avgDailyDemandMins = 120; // conservative fallback: 2h/machine/day
  if (data && data.length) {
    // Sum total_active_minutes across all machines per day, then average
    const byDate = {};
    for (const row of data) {
      byDate[row.summary_date] = (byDate[row.summary_date] || 0) + (row.total_active_minutes || 0);
    }
    const days = Object.values(byDate);
    avgDailyDemandMins = days.reduce((a, b) => a + b, 0) / days.length;
  }

  const AVAILABLE_MINS_PER_DAY = 9 * 60; // 9am–6pm = 9h per machine

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
async function initMaintenanceWindow() {
  const select = document.getElementById('maintenance-select');
  const result = document.getElementById('maintenance-result');

  // Populate machine list
  const { data: machines } = await db
    .from('machines')
    .select('id, name, lab')
    .order('name');

  if (machines) {
    machines.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.name} (${m.lab})`;
      select.appendChild(opt);
    });
  }

  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  select.addEventListener('change', async () => {
    const mid = select.value;
    if (!mid) { result.textContent = 'Select a machine to see the best maintenance window.'; return; }
    result.textContent = 'Analysing…';

    const since = new Date(Date.now() - 28 * 24 * 3600_000).toISOString();
    const { data } = await db
      .from('machine_status_logs')
      .select('timestamp, active')
      .eq('machine_id', mid)
      .gte('timestamp', since)
      .limit(30000);

    if (!data || data.length < 10) {
      result.textContent = 'Not enough data for this machine yet.';
      return;
    }

    // Build weekday × hour usage for this machine
    const total_m = Array.from({length:7}, () => Array(24).fill(0));
    const active_m = Array.from({length:7}, () => Array(24).fill(0));
    for (const row of data) {
      const d = new Date(row.timestamp);
      const wd = d.getDay(), hr = d.getHours();
      total_m[wd][hr]++;
      if (row.active) active_m[wd][hr]++;
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
  const TOTAL_MACHINES = 13;
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

// ── Init ──────────────────────────────────────────────────────────────────────
async function initPlanner() {
  if (plannerInited) return;
  plannerInited = true;

  await Promise.all([
    initBestTime(),
    initCapacitySimulator(),
    initMaintenanceWindow(),
    initWaitTime(),
  ]);
}

window.addEventListener('tab-planner', initPlanner);
