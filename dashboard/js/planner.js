// ── Tab 3: Scenario Planner ───────────────────────────

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

async function initPlanner() {
  const { data, error } = await db
    .from('machine_status_logs')
    .select('timestamp, active')
    .gte('timestamp', new Date(Date.now() - 14 * 86400000).toISOString())
    .limit(5000)

  if (error || !data) return

  // Aggregate: [weekday][hour] → usage rate
  const counts = Array.from({length:7}, () => new Array(24).fill(0))
  const totals = Array.from({length:7}, () => new Array(24).fill(0))

  for (const row of data) {
    const d = new Date(row.timestamp)
    totals[d.getDay()][d.getHours()]++
    if (row.active) counts[d.getDay()][d.getHours()]++
  }

  // Best time: lowest usage rate, Mon-Fri, 9-18
  let bestRate = Infinity, bestDay = 1, bestHour = 10
  for (let w = 1; w <= 5; w++) {
    for (let h = 9; h < 18; h++) {
      if (totals[w][h] > 0) {
        const rate = counts[w][h] / totals[w][h]
        if (rate < bestRate) { bestRate = rate; bestDay = w; bestHour = h }
      }
    }
  }

  document.getElementById('best-time-result').innerHTML =
    `<strong>${DAYS[bestDay]} ${bestHour}:00–${bestHour+1}:00</strong>
     &nbsp;— historically ${Math.round((1-bestRate)*100)}% of machines are free at this time`

  // Capacity simulator
  const totalDemand = counts.flat().reduce((a,b) => a+b, 0)
  const totalSlots  = totals.flat().reduce((a,b) => a+b, 0)
  const demandRate  = totalSlots > 0 ? totalDemand / totalSlots : 0

  function updateSim(n) {
    const simUtil = Math.min(demandRate / (n / 13) * 100, 100)
    document.getElementById('sim-result').innerHTML =
      `With <strong>${n}</strong> machines, estimated utilisation rate: <strong>${simUtil.toFixed(1)}%</strong>`
  }

  const slider = document.getElementById('sim-slider')
  const label  = document.getElementById('sim-count')
  slider.addEventListener('input', () => {
    label.textContent = slider.value
    updateSim(+slider.value)
  })
  updateSim(13)
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'planner') initPlanner()
  })
})

// ── Tab switching logic ───────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'))
    btn.classList.add('active')
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active')
  })
})
