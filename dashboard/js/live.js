/* live.js — Tab 1: Live View
   Features: 1.1 Machine Wall · 1.2 ETA · 1.3 Summary Bar ·
             1.4 Lab Split · 1.5 Stuck Detection · 1.6 Uncollected Alert ·
             1.7 Available Now · 1.8 Manual-stop badge · 1.9 Task name ·
             1.10 Filament colour / remaining                                */

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

function fmt_ago(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  return `${h}h ago`;
}

// Real states seen in machine_status_logs (verified against Supabase):
// FINISHED, IDLE, PRINTING, ERROR, PAUSED, ATTENTION, UNKNOWN, STOPPED, BUSY, PREPARING, null
function state_class(row) {
  if (!row.online) return 'offline';
  const s = (row.state || '').toUpperCase();
  if (s === 'PRINTING' || s === 'BUSY')  return 'printing';
  if (s === 'PAUSED')                    return 'paused';
  if (s === 'ERROR')                     return 'error';
  if (s === 'ATTENTION')                 return 'attention'; // needs human intervention (e.g. Bambu AMS/filament runout)
  if (s === 'FINISHED')                  return 'finished';  // done, likely awaiting collection
  if (s === 'STOPPED')                   return 'stopped';
  if (s === 'PREPARING')                 return 'preparing';
  return 'idle'; // IDLE, UNKNOWN, null
}

// Label shows the *real* reported state, not the CSS bucket name — a BUSY
// machine should say BUSY, not "PRINTING", even though it's styled the same.
function state_label(row) {
  if (!row.online) return 'OFFLINE';
  return (row.state || 'UNKNOWN').toUpperCase();
}

// Parse Pi-agent job filenames like
// "Soap+Dish_0.4n_0.2mm_PLA_COREONE_1h31m.bgcode" into a readable task name.
function humanizeFilename(fn) {
  if (!fn) return null;
  const base = fn.replace(/\.[a-z0-9]+$/i, '');
  const parts = base.split('_');
  const metaPattern = /^(\d+(\.\d+)?(mm|n)|PLA|PETG|ABS|TPU|ASA|PC|NYLON|COREONE|H2D|X1C|XL|\d+h\d+m|\d+m)$/i;
  const nameParts = [];
  let i = 0;
  for (; i < parts.length; i++) {
    if (metaPattern.test(parts[i])) break;
    nameParts.push(parts[i]);
  }
  const name = (nameParts.join(' ').replace(/\+/g, ' ').trim()) || base.replace(/\+/g, ' ');
  const rest = parts.slice(i);
  const durPart      = rest.find(x => /^\d+h\d+m$/i.test(x) || /^\d+m$/i.test(x));
  const layerPart    = rest.find(x => /^\d*\.\d+mm$/i.test(x));
  const materialPart = rest.find(x => /^(PLA|PETG|ABS|TPU|ASA|PC|NYLON)$/i.test(x));
  const bits = [];
  if (layerPart) bits.push(layerPart);
  if (materialPart) bits.push(materialPart.toUpperCase());
  if (durPart) bits.push('~' + durPart);
  return bits.length ? `${name} (${bits.join(' · ')})` : name;
}

// ── Fetch latest status ───────────────────────────────────────────────────────
async function fetchLatest() {
  // Get the most recent row per machine
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: logs, error } = await db
    .from('machine_status_logs')
    .select('*, machines(name, lab, machine_type)')
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

// ── 1.8 Manual-stop lookup (uses the print_stopped_manual event added 22 June) ─
async function fetchManualStops(latest) {
  const ids = latest.map(r => r.machine_id);
  if (!ids.length) return {};

  const sixHrsAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { data } = await db
    .from('machine_events')
    .select('machine_id, start_time, progress_at_stop')
    .in('machine_id', ids)
    .eq('event_type', 'print_stopped_manual')
    .gte('start_time', sixHrsAgo)
    .order('start_time', { ascending: false });

  if (!data || !data.length) return {};

  const byMachine = {};
  for (const row of data) {
    if (!byMachine[row.machine_id]) byMachine[row.machine_id] = row; // first = most recent
  }
  return byMachine;
}

// ── 1.9 Current task name lookup (from machine_events.metadata.filename) ──────
async function fetchTaskNames(latest) {
  const printingIds = latest
    .filter(r => ['PRINTING', 'BUSY'].includes((r.state || '').toUpperCase()))
    .map(r => r.machine_id);
  if (!printingIds.length) return {};

  const { data } = await db
    .from('machine_events')
    .select('machine_id, start_time, metadata')
    .in('machine_id', printingIds)
    .eq('event_type', 'print_started')
    .order('start_time', { ascending: false })
    .limit(200);

  if (!data || !data.length) return {};

  const byMachine = {};
  for (const row of data) {
    if (byMachine[row.machine_id]) continue; // keep most recent only
    const fn = row.metadata?.filename;
    if (fn) byMachine[row.machine_id] = humanizeFilename(fn);
  }
  return byMachine;
}

// ── Render machine card ────────────────────────────────────────────────────────
function renderCard(r, stuckNames, manualStops, taskNames) {
  const name  = r.machines?.name || r.machine_id;
  const cls   = state_class(r);
  const label = state_label(r);
  const prog  = r.job_progress ?? 0;
  const stuck = stuckNames.includes(name);
  const manualStop = manualStops[r.machine_id];
  const taskName   = taskNames[r.machine_id];

  // Meta lines
  const metaLines = [];
  if (cls === 'printing' && taskName) metaLines.push(`🖨 ${taskName}`);
  if (r.filament_type) {
    const swatch = r.filament_color
      ? `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#${String(r.filament_color).trim()};border:1px solid rgba(0,0,0,0.2);margin-right:4px;vertical-align:middle"></span>`
      : '';
    metaLines.push(`${swatch}🧵 ${r.filament_type}${r.filament_brand ? ' · ' + r.filament_brand : ''}`);
  }
  if (r.filament_remain != null) {
    const low = r.filament_remain <= 15;
    metaLines.push(`<span${low ? ' style="color:var(--red);font-weight:600"' : ''}>${low ? '⚠ ' : ''}Filament ${Math.round(r.filament_remain)}% left${low ? ' — low' : ''}</span>`);
  }
  if (r.nozzle_diameter) metaLines.push(`⌀ ${Number(r.nozzle_diameter).toFixed(2)} mm nozzle`);
  const remaining = fmt_remaining(r.job_remaining);
  if (remaining && cls === 'printing') metaLines.push(`⏱ ${remaining} left`);
  if (r.temp_nozzle) metaLines.push(`🌡 ${Math.round(r.temp_nozzle)}°C nozzle`);
  if (manualStop) metaLines.push(`<span style="color:var(--orange)">⏸ Manually stopped at ${Math.round(manualStop.progress_at_stop ?? 0)}% · ${fmt_ago(manualStop.start_time)}</span>`);

  const lab = r.machines?.lab || '';
  const mtype = r.machines?.machine_type || '';
  return `
    <div class="machine-card ${cls}${stuck ? ' stuck' : ''}" data-mid="${r.machine_id}" data-mname="${name}" data-mtype="${mtype}" data-mlab="${lab}">
      <div class="card-name">${name}${stuck ? ' ⚠️' : ''}</div>
      <div class="card-state ${cls}">${label}${stuck ? ' — may be stuck' : ''}</div>
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

// ── 1.10 Dynamic machine count (was hardcoded to 13 across the site) ──────────
async function refreshMachineCount() {
  const { count } = await db.from('machines').select('id', { count: 'exact', head: true });
  if (count == null) return;
  window.LAB_MACHINE_COUNT = count; // consumed by planner.js too
  const homeMachines = document.getElementById('home-machines');
  if (homeMachines) homeMachines.textContent = count;
  const homeMachinesInline = document.getElementById('home-machines-inline');
  if (homeMachinesInline) homeMachinesInline.textContent = count;
  window.dispatchEvent(new CustomEvent('machine-count', { detail: count }));
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
  const [stuckNames, uncollectedNames, manualStops, taskNames] = await Promise.all([
    fetchStuckJobs(latest),
    fetchUncollected(latest),
    fetchManualStops(latest),
    fetchTaskNames(latest),
  ]);

  renderAlerts(stuckNames, uncollectedNames);

  // 1.3 Summary bar
  const online   = latest.filter(r => r.online).length;
  const printing = latest.filter(r => ['PRINTING', 'BUSY'].includes((r.state||'').toUpperCase())).length;
  const idle     = latest.filter(r => r.online && (r.state||'').toUpperCase() === 'IDLE').length;
  document.getElementById('count-online').textContent   = online;
  document.getElementById('count-printing').textContent = printing;
  document.getElementById('count-idle').textContent     = idle;

  // 1.7 Soonest free / available now
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
      .map(r => renderCard(r, stuckNames, manualStops, taskNames)).join('');
  document.getElementById('grid-celab').innerHTML =
    celab.map(r => renderCard(r, stuckNames, manualStops, taskNames)).join('') ||
    '<p style="color:var(--muted);font-size:12px">No CELab data yet.</p>';

  // Timestamp
  document.getElementById('last-updated').textContent = `Updated ${fmt_time(new Date().toISOString())}`;

  // Name → {id, type, lab} lookup, so the 3D hero view (which only knows a
  // machine's printed label like "H2D-01") can open the same trading card
  // that clicking a Live View card does.
  window.MACHINE_LOOKUP = window.MACHINE_LOOKUP || {};
  latest.forEach(r => {
    if (r.machines?.name) {
      window.MACHINE_LOOKUP[r.machines.name] = {
        id: r.machine_id, type: r.machines.machine_type, lab: r.machines.lab,
      };
    }
  });
}

// ── Machine trading card ───────────────────────────────────────────────────────
// Click any Live View card for a game-card-style summary — cumulative print
// time, most-printed material, longest single continuous print. Backed by
// the machine_card_stats() RPC (added 5 July) so the heavy per-machine
// streak calculation runs server-side instead of pulling raw logs.
function fmt_hours(totalSeconds) {
  const h = totalSeconds / 3600;
  if (h < 1) return `${Math.round(totalSeconds / 60)} min`;
  if (h < 100) return `${h.toFixed(1)} h`;
  return `${Math.round(h)} h`;
}

async function openTradingCard(mid, mname, mtype, mlab) {
  const overlay = document.getElementById('tc-overlay');
  const card = document.getElementById('tc-card');
  const brand = (mtype || '').toLowerCase().includes('bambu') ? 'brand-bambu'
              : (mtype || '').toLowerCase().includes('prusa') ? 'brand-prusa' : '';
  card.className = 'tc-card ' + brand;
  document.getElementById('tc-lab').textContent = mlab || ' ';
  document.getElementById('tc-name').textContent = mname;
  document.getElementById('tc-type').textContent = mtype || 'Unknown model';
  document.getElementById('tc-stat-time').textContent = '…';
  document.getElementById('tc-stat-filament').textContent = '…';
  document.getElementById('tc-stat-streak').textContent = '…';
  overlay.classList.add('active');

  const { data, error } = await db.rpc('machine_card_stats', { p_machine_id: mid });
  if (error) console.error('machine_card_stats error', error);
  const stats = (data && data[0]) || {};

  document.getElementById('tc-stat-time').textContent =
    stats.total_print_seconds ? fmt_hours(stats.total_print_seconds) : 'No data yet';
  document.getElementById('tc-stat-filament').textContent = stats.top_filament_type || '—';
  document.getElementById('tc-stat-streak').textContent =
    stats.longest_streak_seconds ? fmt_hours(stats.longest_streak_seconds) : '—';
}

function closeTradingCard() {
  document.getElementById('tc-overlay').classList.remove('active');
}

// Exposed so the 3D hero/VR scene can open a trading card when a visitor
// clicks a machine model directly (looked up via window.MACHINE_LOOKUP).
window.openTradingCard = openTradingCard;

document.getElementById('tc-close').addEventListener('click', closeTradingCard);
document.getElementById('tc-overlay').addEventListener('click', e => {
  if (e.target.id === 'tc-overlay') closeTradingCard();
});
window.addEventListener('keydown', e => { if (e.key === 'Escape') closeTradingCard(); });

['grid-lfl', 'grid-celab'].forEach(gridId => {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  grid.addEventListener('click', e => {
    const card = e.target.closest('.machine-card');
    if (!card) return;
    openTradingCard(card.dataset.mid, card.dataset.mname, card.dataset.mtype, card.dataset.mlab);
  });
});

// Boot + auto-refresh
refreshMachineCount();
renderLive();
setInterval(renderLive, REFRESH_MS);
