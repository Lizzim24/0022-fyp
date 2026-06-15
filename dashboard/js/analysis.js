// ── Tab 2: Analysis (placeholder — will fill in next) ─
// Charts are initialised when the tab becomes visible

let heatmapChart = null
let utilChart    = null

async function initAnalysis() {
  if (heatmapChart) return  // already loaded

  const { data, error } = await db
    .from('machine_status_logs')
    .select('timestamp, active')
    .gte('timestamp', new Date(Date.now() - 14 * 86400000).toISOString())
    .limit(5000)

  if (error || !data) return

  // Build heatmap: [weekday 0-6, hour 0-23] → usage rate
  const counts  = Array.from({length: 7}, () => new Array(24).fill(0))
  const totals  = Array.from({length: 7}, () => new Array(24).fill(0))

  for (const row of data) {
    const d = new Date(row.timestamp)
    const w = d.getDay()   // 0=Sun
    const h = d.getHours()
    totals[w][h]++
    if (row.active) counts[w][h]++
  }

  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
  const heatmapData = []
  for (let w = 0; w < 7; w++) {
    for (let h = 0; h < 24; h++) {
      const rate = totals[w][h] > 0 ? counts[w][h] / totals[w][h] : 0
      heatmapData.push([h, w, +(rate * 100).toFixed(1)])
    }
  }

  heatmapChart = echarts.init(document.getElementById('chart-heatmap'))
  heatmapChart.setOption({
    backgroundColor: 'transparent',
    tooltip: { formatter: p => `${days[p.data[1]]} ${p.data[0]}:00 — ${p.data[2]}%` },
    grid: { left: 48, right: 16, top: 16, bottom: 40 },
    xAxis: {
      type: 'category',
      data: Array.from({length:24}, (_,i) => `${i}:00`),
      axisLabel: { color: '#8892a4', fontSize: 10 },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'category',
      data: days,
      axisLabel: { color: '#8892a4', fontSize: 11 },
    },
    visualMap: {
      min: 0, max: 100,
      calculable: true,
      orient: 'horizontal',
      left: 'center', bottom: 0,
      inRange: { color: ['#1a1d27','#3b82f6','#22c55e'] },
      textStyle: { color: '#8892a4' },
    },
    series: [{
      type: 'heatmap',
      data: heatmapData,
      emphasis: { itemStyle: { shadowBlur: 6 } },
    }],
  })
}

// Trigger on tab click
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'analysis') initAnalysis()
  })
})
