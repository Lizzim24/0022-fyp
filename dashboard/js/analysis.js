/* analysis.js — Tab 2: Analysis
   Features: 2.1 Usage Heatmap · 2.2 Utilisation Trend ·
             2.3 Machine Leaderboard · 2.4 Health Score ·
             2.5 Filament Usage · 2.6 Filament Type Distribution     */

let analysisInited = false;

// ── ECharts light theme base ──────────────────────────────────────────────────
const LIGHT_OPTS = {
  backgroundColor: 'transparent',
  textStyle: { color: '#111' },
};

const CHART_COLORS = ['#E84800','#2563eb','#16a34a','#9333ea','#ea580c','#0891b2','#4f46e5','#db2777'];

function makeChart(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  const c = echarts.init(el, null, { renderer: 'canvas' });
  window.addEventListener('resize', () => c.resize());
  return c;
}

// ── 2.1 Heatmap ───────────────────────────────────────────────────────────────
async function initHeatmap() {
  const chart = makeChart('chart-heatmap');
  if (!chart) return;

  const since = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();
  const { data } = await db
    .from('machine_status_logs')
    .select('timestamp, active')
    .gte('timestamp', since)
    .limit(50000);

  if (!data || !data.length) {
    chart.setOption({ ...LIGHT_OPTS, graphic: [{type:'text',left:'center',top:'middle',style:{text:'Not enough data yet',fill:'#999',fontSize:14}}] });
    return;
  }

  // Build [weekday][hour] buckets
  const total = Array.from({length:7}, ()=>Array(24).fill(0));
  const active_count = Array.from({length:7}, ()=>Array(24).fill(0));
  for (const row of data) {
    const d = new Date(row.timestamp);
    const wd = d.getDay(); // 0=Sun
    const hr = d.getHours();
    total[wd][hr]++;
    if (row.active) active_count[wd][hr]++;
  }

  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const seriesData = [];
  let maxRate = 0;
  for (let wd = 0; wd < 7; wd++) {
    for (let hr = 0; hr < 24; hr++) {
      const rate = total[wd][hr] > 0 ? active_count[wd][hr] / total[wd][hr] : 0;
      seriesData.push([hr, wd, parseFloat((rate * 100).toFixed(1))]);
      if (rate > maxRate) maxRate = rate;
    }
  }

  chart.setOption({
    ...LIGHT_OPTS,
    tooltip: { formatter: p => `${days[p.data[1]]} ${p.data[0]}:00 — ${p.data[2]}% utilisation` },
    grid: { left: 55, right: 20, top: 16, bottom: 30 },
    xAxis: { type: 'category', data: Array.from({length:24}, (_,i) => `${i}:00`), axisLabel: { color:'#888', fontSize:10, interval:1 }, splitLine:{show:false} },
    yAxis: { type: 'category', data: days, axisLabel: { color:'#666', fontSize:11 }, splitLine:{show:false} },
    visualMap: { min:0, max:Math.max(maxRate*100,1), calculable:false, orient:'horizontal', left:'right', bottom:'bottom', show:false,
      inRange: { color: ['#EFEFEC','#fca5a5','#ef4444','#991b1b'] } },
    series: [{ type:'heatmap', data:seriesData, itemStyle:{borderRadius:3,borderWidth:1,borderColor:'#EFEFEC'}, emphasis:{itemStyle:{shadowBlur:6,shadowColor:'rgba(0,0,0,0.3)'}} }],
  });
}

// ── 2.2 Utilisation Rate Trend ─────────────────────────────────────────────────
async function initUtilTrend() {
  const chart = makeChart('chart-util');
  if (!chart) return;

  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString().split('T')[0];
  const { data } = await db
    .from('machine_daily_summary')
    .select('summary_date, machine_id, utilisation_rate, machines(name, lab)')
    .gte('summary_date', since)
    .order('summary_date', { ascending: true });

  if (!data || !data.length) {
    chart.setOption({ ...LIGHT_OPTS, graphic:[{type:'text',left:'center',top:'middle',style:{text:'No daily summary data yet — check if daily_summary.py is running',fill:'#999',fontSize:13}}] });
    return;
  }

  // Group by lab for aggregated lines
  const byDate = {};
  const labCount = {};
  for (const row of data) {
    const lab = row.machines?.lab || 'Unknown';
    const key = `${row.summary_date}|${lab}`;
    if (!byDate[key]) { byDate[key] = { sum: 0, count: 0 }; }
    byDate[key].sum   += (row.utilisation_rate || 0);
    byDate[key].count += 1;
    labCount[lab] = true;
  }

  const labs = Object.keys(labCount);
  const dates = [...new Set(data.map(r => r.summary_date))].sort();

  const series = labs.map((lab, i) => ({
    name: lab,
    type: 'line',
    smooth: true,
    symbol: 'circle',
    symbolSize: 5,
    lineStyle: { width: 2 },
    itemStyle: { color: CHART_COLORS[i] },
    areaStyle: { color: CHART_COLORS[i], opacity: 0.07 },
    data: dates.map(date => {
      const entry = byDate[`${date}|${lab}`];
      return entry ? parseFloat(((entry.sum / entry.count) * 100).toFixed(1)) : null;
    }),
    connectNulls: true,
  }));

  chart.setOption({
    ...LIGHT_OPTS,
    tooltip: { trigger:'axis', axisPointer:{type:'cross'}, formatter: params => {
      return params[0].name + '<br>' + params.map(p => `${p.marker}${p.seriesName}: ${p.value ?? '—'}%`).join('<br>');
    }},
    legend: { data: labs, textStyle:{color:'#444'}, top: 0 },
    grid: { left:50, right:20, top:36, bottom:30 },
    xAxis: { type:'category', data:dates, axisLabel:{color:'#888',fontSize:10,rotate:30} },
    yAxis: { type:'value', min:0, max:100, axisLabel:{color:'#888',fontSize:10,formatter:'{value}%'}, splitLine:{lineStyle:{color:'rgba(0,0,0,0.06)'}} },
    series,
  });
}

// ── 2.3 Machine Leaderboard ────────────────────────────────────────────────────
async function initLeaderboard() {
  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString().split('T')[0];
  const { data } = await db
    .from('machine_daily_summary')
    .select('machine_id, utilisation_rate, number_of_offline_events, number_of_possible_failures, machines(name)')
    .gte('summary_date', since);

  if (!data || !data.length) {
    ['lb-util','lb-offline','lb-fail'].forEach(id => {
      document.getElementById(id).innerHTML = '<p style="color:#999;font-size:12px">No data yet</p>';
    });
    return;
  }

  // Aggregate per machine
  const agg = {};
  for (const row of data) {
    const name = row.machines?.name || row.machine_id;
    if (!agg[name]) agg[name] = { util: 0, offline: 0, fail: 0, n: 0 };
    agg[name].util    += (row.utilisation_rate || 0);
    agg[name].offline += (row.number_of_offline_events || 0);
    agg[name].fail    += (row.number_of_possible_failures || 0);
    agg[name].n++;
  }

  const machines = Object.entries(agg).map(([name, v]) => ({
    name,
    util:    parseFloat(((v.util / v.n) * 100).toFixed(1)),
    offline: v.offline,
    fail:    v.fail,
  }));

  function renderLB(id, sorted, valFn) {
    document.getElementById(id).innerHTML = sorted.slice(0,5).map((m,i) =>
      `<div class="lb-row">
         <span class="lb-rank">${i+1}</span>
         <span>${m.name}</span>
         <span class="lb-val">${valFn(m)}</span>
       </div>`
    ).join('');
  }

  renderLB('lb-util',    [...machines].sort((a,b) => b.util    - a.util),    m => m.util + '%');
  renderLB('lb-offline', [...machines].sort((a,b) => b.offline - a.offline), m => m.offline + ' times');
  renderLB('lb-fail',    [...machines].sort((a,b) => b.fail    - a.fail),    m => m.fail + ' events');
}

// ── 2.4 Machine Health Score ───────────────────────────────────────────────────
async function initHealthScores() {
  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString().split('T')[0];
  const { data } = await db
    .from('machine_daily_summary')
    .select('machine_id, number_of_possible_failures, number_of_offline_events, number_of_pauses, machines(name)')
    .gte('summary_date', since);

  const grid = document.getElementById('health-grid');

  if (!data || !data.length) {
    grid.innerHTML = '<p style="color:#999;font-size:12px">No data yet</p>';
    return;
  }

  // Aggregate per machine — 30-day totals
  const agg = {};
  for (const row of data) {
    const name = row.machines?.name || row.machine_id;
    if (!agg[name]) agg[name] = { fail: 0, offline: 0, pauses: 0 };
    agg[name].fail    += (row.number_of_possible_failures || 0);
    agg[name].offline += (row.number_of_offline_events || 0);
    agg[name].pauses  += (row.number_of_pauses || 0);
  }

  // Score = 100 − (failures×10) − (offline×3) − (pauses×2), floor 0
  const cards = Object.entries(agg).map(([name, v]) => {
    const score = Math.max(0, Math.min(100, 100 - v.fail * 10 - v.offline * 3 - v.pauses * 2));
    const cls = score >= 80 ? 'good' : score >= 60 ? 'ok' : 'bad';
    const fillColor = cls === 'good' ? '#16a34a' : cls === 'ok' ? '#ea580c' : '#dc2626';
    return `<div class="health-card">
      <div class="health-name">${name}</div>
      <div class="health-score ${cls}">${score}</div>
      <div class="health-bar"><div class="health-fill" style="width:${score}%;background:${fillColor}"></div></div>
    </div>`;
  });

  grid.innerHTML = cards.join('') ||
    '<p style="color:#999;font-size:12px">No data yet</p>';
}

// ── 2.5 Filament Usage Bar ─────────────────────────────────────────────────────
async function initFilamentUsage() {
  const chart = makeChart('chart-filament-usage');
  if (!chart) return;

  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString().split('T')[0];
  const { data } = await db
    .from('machine_daily_summary')
    .select('machine_id, total_active_minutes, machines(name)')
    .gte('summary_date', since);

  if (!data || !data.length) {
    chart.setOption({ ...LIGHT_OPTS, graphic:[{type:'text',left:'center',top:'middle',style:{text:'No daily summary data yet',fill:'#999',fontSize:13}}] });
    return;
  }

  // Sum total_active_minutes per machine
  const totals = {};
  for (const row of data) {
    const name = row.machines?.name || row.machine_id;
    totals[name] = (totals[name] || 0) + (row.total_active_minutes || 0);
  }

  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const names  = sorted.map(([n]) => n);
  const values = sorted.map(([, v]) => Math.round(v));

  chart.setOption({
    ...LIGHT_OPTS,
    tooltip: { trigger:'axis', formatter: p => `${p[0].name}: ${p[0].value} min (relative filament use)` },
    grid: { left:110, right:20, top:16, bottom:30 },
    xAxis: { type:'value', axisLabel:{color:'#888',fontSize:10,formatter:v=>v+'m'}, splitLine:{lineStyle:{color:'rgba(0,0,0,0.06)'}} },
    yAxis: { type:'category', data:names, axisLabel:{color:'#555',fontSize:11} },
    series: [{
      type:'bar', data:values,
      barMaxWidth:22,
      itemStyle:{ color:p => CHART_COLORS[p.dataIndex % CHART_COLORS.length], borderRadius:[0,4,4,0] },
      label:{ show:true, position:'right', color:'#666', fontSize:10, formatter:p=>`${p.value}m` },
    }],
  });
}

// ── 2.6 Filament Type Distribution ────────────────────────────────────────────
async function initFilamentType() {
  const chart = makeChart('chart-filament-type');
  if (!chart) return;

  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const { data } = await db
    .from('machine_status_logs')
    .select('filament_type')
    .gte('timestamp', since)
    .not('filament_type', 'is', null);

  if (!data || !data.length) {
    chart.setOption({ ...LIGHT_OPTS, graphic:[{type:'text',left:'center',top:'middle',style:{text:'No filament type data yet — will populate as machines run',fill:'#999',fontSize:13}}] });
    return;
  }

  // Count by type
  const counts = {};
  for (const row of data) {
    const t = (row.filament_type || 'Unknown').toUpperCase();
    counts[t] = (counts[t] || 0) + 1;
  }

  const pieData = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, value], i) => ({ name, value, itemStyle:{ color: CHART_COLORS[i % CHART_COLORS.length] } }));

  chart.setOption({
    ...LIGHT_OPTS,
    tooltip: { trigger:'item', formatter: p => `${p.name}<br>${p.value} records (${p.percent}%)` },
    legend: { orient:'vertical', right:20, top:'middle', textStyle:{color:'#444',fontSize:12} },
    series: [{
      type:'pie',
      radius:['38%','70%'],
      center:['38%','50%'],
      data:pieData,
      label:{ show:false },
      emphasis:{ label:{show:true,fontSize:13,fontWeight:'bold'}, itemStyle:{shadowBlur:10,shadowOffsetX:0,shadowColor:'rgba(0,0,0,0.15)'} },
    }],
  });
}

// ── Init all ──────────────────────────────────────────────────────────────────
async function initAnalysis() {
  if (analysisInited) return;
  analysisInited = true;

  await Promise.all([
    initHeatmap(),
    initUtilTrend(),
    initLeaderboard(),
    initHealthScores(),
    initFilamentUsage(),
    initFilamentType(),
  ]);
}

window.addEventListener('tab-analysis', initAnalysis);
