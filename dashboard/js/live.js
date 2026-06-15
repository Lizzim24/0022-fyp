/* live.js — Tab 1: Live View
   Features: 1.1 Machine Wall · 1.2 ETA · 1.3 Summary Bar ·
             1.4 Lab Split · 1.5 Stuck Detection · 1.6 Uncollected Alert ·
             1.7 Available Now                                             */

const REFRESH_MS = 10_000;

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmt_remaining(secs) {
  if (secs == null || secs <= 0) return null;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmt_time(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function state_class(row) {
  if (!row.online) return 'offline';
  const s = (row.state || '').toUpperCase();
  if (s === 'PRINTING') return 'printing';
  if (s === 'PAUSED')   return 'paused';
  if (s === 'ERROR')    return 'error';
  return 'idle';
}

// ── Fetch latest status ───────────────────────────────────────────────────────
async function fetchLatest() {
  // Get the most recent row per machine
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: logs, error } = await db
    .from('machine_status_logs')
    .select('*, machines(name, lab)')
    .gte('timestamp', since)
    .order('timestamp', { ascending: false });

  if (error || !logs) return [];

  // Deduplicate: keep first (most recent) row per machine_id
  const seen = new Set();
  return logs.filter(r => {
    if (seen.has(r.machine_id)) return false;
    seen.add(r.machine_id); return true;
  });
}

// ── 1.5 Stuck job detection ───────────────────────────────────────────────────
async function fetchStuckJobs(latest) {
  // Only check machines that are currently PRINTING
  const printing = latest.filter(r => (r.state || '').toUpperCase() === 'PRINTING' && r.job_progress != null);
  if (!printing.length) return [];

  const ago20 = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const ids = printing.map(r => r.machine_id);

  const { data } = await db
    .from('machine_status_logs')
    .select('machine_id, job_progress, timestamp')
    .in('machine_id', ids)
    .gte('timestamp', ago20)
    .order('timestamp', { ascending: true });

  if (!data || !data.length) return [];

  // Group by machine
  const byMachine = {};
  for (const row of data) {
    if (!byMachine[row.machine_id]) byMachine[row.machine_id] = [];
    byMachine[row.machine_id].push(row.job_progress);
  }

  const stuck = [];
  for (const [mid, progList] of Object.entries(byMachine)) {
    if (progList.length < 4) continue; // need enough samples
    const min = Math.min(...progList);
    const max = Math.max(...progList);
    if (max - min < 1) {
      const m = latest.find(r => r.machine_id === mid);
      if (m) stuck.push(m.machines?.name || mid);
    }
  }
  return stuck;
}

// ── 1.6 Uncollected print alert ────────────────────────────────────────────────
async function fetchUncollected(latest) {
  // Find machines that are IDLE and had a print_completed event > 2h ago with no print_started since
  const twoHrsAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const idleMachines = latest
    .filter(r => r.online && (r.state || '').toUpperCase() === 'IDLE')
    .map(r => r.machine_id);

  if (!idleMachines.length) return [];

  const { data: events } = await db
    .from('machine_events')
    .select('machine_id, event_type, start_time, machines(name)')
    .in('machine_id', idleMachines)
    .in('event_type', ['print_completed', 'print_started'])
    .order('start_time', { ascending: false })
    .limit(200);

  if (!events || !events.length) return [];

  const uncollected = [];
  const byMachine = {};
  for (const ev of events) {
    if (!byMachine[ev.machine_id]) byMachine[ev.machine_id] = [];
    byMachine[ev.machine_id].push(ev);
  }

  for (const [mid, evs] of Object.entries(byMachine)) {
    const lastCompleted = evs.find(e => e.event_type === 'print_completed');
    const lastStarted   = evs.find(e => e.event_type === 'print_started');
    if (!lastCompleted) continue;
    const completedAt = new Date(lastCompleted.start_time);
    // If completed > 2h ago AND no print_started after it
    if (completedAt < new Date(twoHrsAgo)) {
      if (!lastStarted || new Date(lastStarted.start_time) < completedAt) {
        const m = latest.find(r => r.machine_id === mid);
        uncollected.push(m?.machines?.name || mid);
      }
    }
  }
  return uncollected;
}

// ── Render machine card ────────────────────────────────────────────────────────
function renderCard(r, stuckNames) {
  const name  = r.machines?.name || r.machine_id;
  const cls   = state_class(r);
  const prog  = r.job_progress ?? 0;
  const stuck = stuckNames.includes(name);

  // Meta lines
  const metaLines = [];
  if (r.filament_type)  metaLines.push(`🧵 ${r.filament_type}${r.filament_brand ? ' · ' + r.filament_brand : ''}`);
  if (r.nozzle_diameter) metaLines.push(`⌀ ${Number(r.nozzle_diameter).toFixed(2)} mm nozzle`);
  const remaining = fmt_remaining(r.job_remaining);
  if (remaining && cls === 'printing') metaLines.push(`⏱ ${remaining} left`);
  if (r.temp_nozzle) metaLines.push(`🌡 ${Math.round(r.temp_nozzle)}°C nozzle`);

  return `
    <div class="machine-card ${cls}${stuck ? ' stuck' : ''}">
      <div class="card-name">${name}${stuck ? ' ⚠️' : ''}</div>
      <div class="card-state ${cls}">${cls.toUpperCase()}${stuck ? ' — may be stuck' : ''}</div>
      <div class="card-progress-wrap">
        <div class="card-progress-bar" style="width:${cls === 'printing' ? prog : 0}%"></div>
      </div>
      <div class="card-meta">
        ${cls === 'printing' ? `<span>${Math.round(prog)}% complete</span>` : ''}
        ${metaLines.map(l => `<span>${l}</span>`).join('')}
        <span style="color:#bbb;font-size:10px">Updated ${fmt_time(r.timestamp)}</span>
      </div>
    </div>`;
}

// ── Render alerts ─────────────────────────────────────────────────────────────
function renderAlerts(stuckNames, uncollectedNames) {
  const area = document.getElementById('alert-area');
  let html = '';
  if (stuckNames.length) {
    html += `<div class="alert-banner warn">
      <span>⚠️</span>
      <span><strong>Possible stuck print${stuckNames.length > 1 ? 's' : ''}:</strong>
        ${stuckNames.join(', ')} — progress unchanged for 20+ min</span>
    </div>`;
  }
  if (uncollectedNames.length) {
    html += `<div class="alert-banner info">
      <span>📦</span>
      <span><strong>Uncollected print${uncollectedNames.length > 1 ? 's' : ''}:</strong>
        ${uncollectedNames.join(', ')} — finished 2+ hours ago</span>
    </div>`;
  }
  area.innerHTML = html;
}

// ── Main render ───────────────────────────────────────────────────────────────
async function renderLive() {
  const latest = await fetchLatest();
  if (!latest.length) {
    document.getElementById('grid-lfl').innerHTML   = '<p style="color:var(--muted);font-size:12px">No data — check agent.</p>';
    document.getElementById('grid-celab').innerHTML = '<p style="color:var(--muted);font-size:12px">No data — check agent.</p>';
    return;
  }

  // Run checks in parallel
  const [stuckNames, uncollectedNames] = await Promise.all([
    fetchStuckJobs(latest),
    fetchUncollected(latest),
  ]);

  renderAlerts(stuckNames, uncollectedNames);

  // 1.3 Summary bar
  const online   = latest.filter(r => r.online).length;
  const printing = latest.filter(r => (r.state||'').toUpperCase() === 'PRINTING').length;
  const idle     = latest.filter(r => r.online && (r.state||'').toUpperCase() === 'IDLE').length;
  document.getElementById('count-online').textContent   = online;
  document.getElementById('count-printing').textContent = printing;
  document.getElementById('count-idle').textContent     = idle;

  // 1.7 Soonest free
  const activeMins = latest
    .filter(r => r.online && r.job_remaining > 0)
    .map(r => r.job_remaining);
  if (idle > 0) {
    document.getElementById('soonest-free').textContent = 'Now';
  } else if (activeMins.length) {
    document.getElementById('soonest-free').textContent = fmt_remaining(Math.min(...activeMins)) || '—';
  } else {
    document.getElementById('soonest-free').textContent = '—';
  }

  // Home page stats
  const homeOnline   = document.getElementById('home-online');
  const homePrinting = document.getElementById('home-printing');
  if (homeOnline)   homeOnline.textContent   = online;
  if (homePrinting) homePrinting.textContent = printing;

  // 1.4 Split by lab
  const lfl   = latest.filter(r => r.machines?.lab === 'LFL');
  const celab = latest.filter(r => r.machines?.lab === 'CELab');

  document.getElementById('grid-lfl').innerHTML =
    (lfl.length ? lfl : latest.filter(r => !r.machines?.lab || r.machines?.lab === 'LFL'))
      .map(r => renderCard(r, stuckNames)).join('');
  document.getElementById('grid-celab').innerHTML =
    celab.map(r => renderCard(r, stuckNames)).join('') ||
    '<p style="color:var(--muted);font-size:12px">No CELab data yet.</p>';

  // Timestamp
  document.getElementById('last-updated').textContent = `Updated ${fmt_time(new Date().toISOString())}`;
}

// Boot + auto-refresh
renderLive();
setInterval(renderLive, REFRESH_MS);
