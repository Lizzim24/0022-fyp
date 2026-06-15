// ── Tab 1: Live View ─────────────────────────────────

const STATE_CLASS = {
  PRINTING:   'printing',
  PAUSED:     'paused',
  ERROR:      'error',
  ATTENTION:  'error',
  OFFLINE:    'offline',
  IDLE:       'idle',
  FINISHED:   'idle',
  PREPARING:  'idle',
  SLICING:    'idle',
  UNKNOWN:    'idle',
}

function fmtMinutes(secs) {
  if (!secs) return null
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function renderCard(machine) {
  const cls   = STATE_CLASS[machine.state] || 'idle'
  const prog  = machine.progress ?? 0
  const rem   = fmtMinutes(machine.job_remaining)
  const online = machine.online

  let meta = ''
  if (!online) {
    meta = '<span>Offline</span>'
  } else if (machine.state === 'PRINTING') {
    if (rem)              meta += `<span>⏱ ${rem} remaining</span>`
    if (machine.filament_type) meta += `<span>🎨 ${machine.filament_type}${machine.filament_brand ? ' · ' + machine.filament_brand : ''}</span>`
    if (machine.nozzle_diameter) meta += `<span>⌀ ${machine.nozzle_diameter}mm nozzle</span>`
  } else if (machine.state === 'FINISHED') {
    meta = '<span>Print finished</span>'
  }

  return `
    <div class="machine-card ${online ? cls : 'offline'}">
      <div class="card-name">${machine.name}</div>
      <div class="card-state ${online ? cls : 'offline'}">${online ? (machine.state || 'UNKNOWN') : 'OFFLINE'}</div>
      <div class="card-progress-wrap">
        <div class="card-progress-bar" style="width:${machine.state === 'PRINTING' ? prog : 0}%"></div>
      </div>
      <div class="card-meta">${meta}</div>
    </div>`
}

async function fetchLive() {
  // Get latest row per machine using a window function approach:
  // Fetch recent logs and deduplicate in JS
  const { data: logs, error } = await db
    .from('machine_status_logs')
    .select(`
      machine_id, state, online, active,
      job_progress, job_remaining,
      filament_type, filament_brand, nozzle_diameter,
      timestamp,
      machines!inner(name, lab)
    `)
    .order('timestamp', { ascending: false })
    .limit(200)

  if (error) { console.error(error); return }

  // Deduplicate: keep only the latest row per machine
  const seen = new Set()
  const latest = []
  for (const row of logs) {
    const mid = row.machine_id
    if (!seen.has(mid)) {
      seen.add(mid)
      latest.push({
        id:             mid,
        name:           row.machines.name,
        lab:            row.machines.lab,
        state:          row.state,
        online:         row.online,
        active:         row.active,
        progress:       row.job_progress,
        job_remaining:  row.job_remaining,
        filament_type:  row.filament_type,
        filament_brand: row.filament_brand,
        nozzle_diameter: row.nozzle_diameter,
      })
    }
  }

  // Summary bar
  const online   = latest.filter(m => m.online)
  const printing = latest.filter(m => m.state === 'PRINTING')
  const idle     = latest.filter(m => m.online && m.state !== 'PRINTING')

  document.getElementById('count-online').textContent   = online.length
  document.getElementById('count-printing').textContent = printing.length
  document.getElementById('count-idle').textContent     = idle.length

  // Soonest free
  const remainings = printing.map(m => m.job_remaining).filter(Boolean)
  const soonest = remainings.length ? Math.min(...remainings) : null
  document.getElementById('soonest-free').textContent = soonest ? fmtMinutes(soonest) : (idle.length ? 'Now' : '—')

  // Render grids
  const lfl    = latest.filter(m => m.lab === 'LFL')
  const celab  = latest.filter(m => m.lab === 'CELab')

  document.getElementById('grid-lfl').innerHTML   = lfl.map(renderCard).join('')
  document.getElementById('grid-celab').innerHTML = celab.map(renderCard).join('')

  // Last updated
  document.getElementById('last-updated').textContent =
    'Updated ' + new Date().toLocaleTimeString('en-GB')
}

// Auto-refresh every 10 seconds
fetchLive()
setInterval(fetchLive, 10000)
