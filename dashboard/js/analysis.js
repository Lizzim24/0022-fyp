/* analysis.js — Tab 2: Analysis
   Features: 2.1 Usage Heatmap · 2.2 Utilisation Trend ·
             2.3 Machine Leaderboard · 2.4 Health Score ·
             2.5 Filament Usage · 2.6 Filament Type Distribution     */

// Was a permanent "only ever run once" flag — if the very first attempt hit
// any transient issue (slow first Supabase round-trip, tab container still
// mid-layout, etc.) every chart on this tab stayed stuck on its empty/error
// state forever, since nothing ever ran again. Now this only guards against
// two *overlapping* runs (e.g. rapidly re-clicking the tab); a normal
// revisit re-fetches, which both retries after a bad first load and keeps
// the data reasonably fresh. echarts.init() on an already-initialised
// container just returns the existing instance, so re-running is safe.
let analysisRunning = false;

// ── ECharts light theme base ──────────────────────────────────────────────────
const LIGHT_OPTS = {
  backgroundColor: 'transparent',
  textStyle: { color: '#111' },
};

const CHART_COLORS = ['#E84800','#2563eb','#16a34a','#9333ea','#ea580c','#0891b2','#4f46e5','#db2777'];

// Charts that live inside the Staff-only wrapper (2.7/2.8/2.9) get
// initialised while their container is display:none in the default Visitor
// mode — echarts reads 0x0 dimensions at init time and never repaints on
// its own once the wrapper becomes visible. Keep every instance here so we
// can force a resize() when the mode toggle reveals them.
const allCharts = [];
const chartsById = {}; // reuse instances across repeat tab visits instead of re-initialising + re-registering a resize listener each time

function makeChart(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (chartsById[id]) return chartsById[id];
  const c = echarts.init(el, null, { renderer: 'canvas' });
  window.addEventListener('resize', () => c.resize());
  allCharts.push(c);
  chartsById[id] = c;
  return c;
}

window.addEventListener('dash-mode-changed', () => {
  // Let the [data-audience] display toggle apply first, then resize.
  setTimeout(() => allCharts.forEach(c => { try { c.resize(); } catch (e) {} }), 30);
});

// ── 2.1 Heatmap ───────────────────────────────────────────────────────────────
// Uses the usage_by_weekday_hour() RPC (added 5 July) instead of pulling raw
// machine_status_logs rows to the browser. The old approach did
// .limit(50000) with no .order() — at ~24k rows/day system-wide, a 14-day
// window already holds 300k+ rows, so the client was silently seeing an
// arbitrary unordered slice of it (often showing as a mostly-blank heatmap).
// The RPC aggregates server-side and always returns at most 7*24=168 rows.
async function initHeatmap() {
  const chart = makeChart('chart-heatmap');
  if (!chart) return;

  const since = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();
  const { data, error } = await db.rpc('usage_by_weekday_hour', { since });

  if (error) console.error('initHeatmap RPC error', error);

  if (!data || !data.length) {
    chart.setOption({ ...LIGHT_OPTS, graphic: [{type:'text',left:'center',top:'middle',style:{text:'Not enough data yet',fill:'#999',fontSize:14}}] });
    return;
  }

  // Build [weekday][hour] buckets directly from the aggregated rows
  const total = Array.from({length:7}, ()=>Array(24).fill(0));
  const active_count = Array.from({length:7}, ()=>Array(24).fill(0));
  for (const row of data) {
    total[row.weekday][row.hour] = row.total;
    active_count[row.weekday][row.hour] = row.active_count;
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
    visualMap: { min:0, max:Math.max(maxRate*100,1), calculable:false, orient:'horizontal', left:'right', bottom:'bottom', show:true,
      text:[Math.round(Math.max(maxRate*100,1)) + '% busy', 'quiet'], textStyle:{color:'#888',fontSize:10}, itemWidth:10, itemHeight:80,
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
    .select('date, machine_id, utilisation_rate, machines(name, lab)')
    .gte('date', since)
    .order('date', { ascending: true });

  if (!data || !data.length) {
    chart.setOption({ ...LIGHT_OPTS, graphic:[{type:'text',left:'center',top:'middle',style:{text:'No daily summary data yet — check if daily_summary.py is running',fill:'#999',fontSize:13}}] });
    return;
  }

  // Group by lab for aggregated lines
  const byDate = {};
  const labCount = {};
  for (const row of data) {
    const lab = row.machines?.lab || 'Unknown';
    const key = `${row.date}|${lab}`;
    if (!byDate[key]) { byDate[key] = { sum: 0, count: 0 }; }
    byDate[key].sum   += (row.utilisation_rate || 0);
    byDate[key].count += 1;
    labCount[lab] = true;
  }

  const labs = Object.keys(labCount);
  const dates = [...new Set(data.map(r => r.date))].sort();

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

  // Annotate known data-collection gaps so a missing stretch reads as
  // "agent offline", not "zero utilisation" (incident log, 4–7 Jul 2026).
  const DATA_GAPS = [
    { start:'2026-07-04', end:'2026-07-07', label:'LFL agent offline' },
  ];
  const gapAreas = DATA_GAPS.map(g => {
    const inRange = dates.filter(d => d >= g.start && d <= g.end);
    if (!inRange.length) return null;
    return [
      { name:g.label, xAxis:inRange[0],
        itemStyle:{color:'rgba(120,120,120,0.10)'},
        label:{show:true, position:'insideTop', color:'#8a8a8a', fontSize:10} },
      { xAxis:inRange[inRange.length-1] },
    ];
  }).filter(Boolean);
  if (gapAreas.length && series.length) {
    series[0].markArea = { silent:true, data:gapAreas };
  }

  chart.setOption({
    ...LIGHT_OPTS,
    tooltip: { trigger:'axis', axisPointer:{type:'cross'}, formatter: params => {
      return params[0].name + '<br>' + params.map(p => `${p.marker}${p.seriesName}: ${p.value ?? '—'}%`).join('<br>');
    }},
    legend: { data: labs, textStyle:{color:'#444'}, top: 0 },
    grid: { left:50, right:20, top:36, bottom:30 },
    xAxis: { type:'category', data:dates, axisLabel:{color:'#888',fontSize:10,rotate:30} },
    yAxis: { type:'value', min:0, max: v => Math.max(10, Math.min(100, Math.ceil(v.max*1.25/5)*5)), axisLabel:{color:'#888',fontSize:10,formatter:'{value}%'}, splitLine:{lineStyle:{color:'rgba(0,0,0,0.06)'}} },
    series,
  });
}

// ── 2.3 Machine Leaderboard ────────────────────────────────────────────────────
async function initLeaderboard() {
  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString().split('T')[0];
  const { data } = await db
    .from('machine_daily_summary')
    .select('machine_id, utilisation_rate, number_of_offline_events, number_of_possible_failures, machines(name)')
    .gte('date', since);

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

  function renderLB(id, sorted, valFn, noteFn) {
    document.getElementById(id).innerHTML = sorted.slice(0,5).map((m,i) =>
      `<div class="lb-row">
         <span class="lb-rank">${i+1}</span>
         <span class="lb-name">${m.name}${noteFn && noteFn(m) ? `<br><span style="font-size:10px;color:var(--muted);font-weight:400">${noteFn(m)}</span>` : ''}</span>
         <span class="lb-val">${valFn(m)}</span>
       </div>`
    ).join('');
  }

  renderLB('lb-util',    [...machines].sort((a,b) => b.util    - a.util),    m => m.util + '%');
  // A couple of machines (Bambu X1-Carbon units, historically) reconnect to
  // WiFi every few seconds to a few minutes almost continuously — each
  // reconnect logs as a fresh offline→online pair, so their count can run
  // into the thousands and swamp this leaderboard, even though it's a
  // connectivity quirk rather than the machine actually being down that
  // often. Flag anything far outside the pack (>10x the group median)
  // instead of hardcoding machine names, so this adapts if the issue moves
  // or gets fixed.
  const offlineVals = machines.map(m => m.offline).filter(v => v > 0).sort((a,b) => a-b);
  const medOffline = offlineVals.length ? offlineVals[Math.floor(offlineVals.length/2)] : 0;
  const flapThreshold = Math.max(20, medOffline * 10);
  renderLB('lb-offline', [...machines].sort((a,b) => b.offline - a.offline), m => m.offline + ' times',
    m => m.offline > flapThreshold ? '⚠ frequent brief reconnects — likely WiFi, not sustained downtime' : null);
  renderLB('lb-fail',    [...machines].sort((a,b) => b.fail    - a.fail),    m => m.fail + ' events');
}

// ── 2.4 Machine Health Score ───────────────────────────────────────────────────
async function initHealthScores() {
  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString().split('T')[0];
  const { data } = await db
    .from('machine_daily_summary')
    .select('machine_id, number_of_possible_failures, number_of_offline_events, number_of_pauses, machines(name)')
    .gte('date', since);

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
    .gte('date', since);

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
// Recolours slices with the actual filament_color hex from Supabase (stored
// as an 8-char RGBA hex, e.g. "FFFFFFFF") instead of the generic chart
// palette, so the chart visually matches the real spools in the lab.
async function initFilamentType() {
  const chart = makeChart('chart-filament-type');
  if (!chart) return;

  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const { data } = await db
    .from('machine_status_logs')
    .select('filament_type, filament_color')
    .gte('timestamp', since)
    .not('filament_type', 'is', null);

  if (!data || !data.length) {
    chart.setOption({ ...LIGHT_OPTS, graphic:[{type:'text',left:'center',top:'middle',style:{text:'No filament type data yet — will populate as machines run',fill:'#999',fontSize:13}}] });
    return;
  }

  // Group by (type, colour) so each slice can use the real spool colour
  const counts = {};
  for (const row of data) {
    const t = (row.filament_type || 'Unknown').toUpperCase();
    const rawColor = (row.filament_color || '').trim();
    const hex6 = /^[0-9a-fA-F]{6,8}$/.test(rawColor) ? rawColor.slice(0,6).toUpperCase() : null;
    const key = `${t}|${hex6 || 'none'}`;
    if (!counts[key]) counts[key] = { type: t, hex: hex6, count: 0 };
    counts[key].count++;
  }

  let fallbackIdx = 0; // palette index, only used when a record has no real colour
  const pieData = Object.values(counts)
    .sort((a, b) => b.count - a.count)
    .map(v => {
      const color = v.hex ? `#${v.hex}` : CHART_COLORS[(fallbackIdx++) % CHART_COLORS.length];
      const name = v.hex ? `${v.type} · #${v.hex}` : `${v.type} · unknown colour`;
      // Real filament colours can be white/near-white (e.g. #FFFFFF, #DCDCDC)
      // which — with the old white slice border — were only visible on
      // hover (emphasis outline) against this card's white background.
      // A visible mid-grey border keeps every slice legible at rest.
      return { name, value: v.count, itemStyle: { color, borderColor:'rgba(0,0,0,0.22)', borderWidth:1.5 } };
    });

  chart.setOption({
    ...LIGHT_OPTS,
    tooltip: { trigger:'item', formatter: p => `${p.name}<br>${p.value} records (${p.percent}%)` },
    legend: { orient:'vertical', right:20, top:'middle', textStyle:{color:'#444',fontSize:11}, itemWidth:12, itemHeight:12 },
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

// ── 2.4 Bambu vs Prusa comparison ──────────────────────────────────────────────
// Groups machine_daily_summary by brand (derived from machines.machine_type,
// which used to default to 'Prusa Core One' for every machine — fixed 5 July).
async function initBrandCompare() {
  const chart = makeChart('chart-brand-compare');
  if (!chart) return;

  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString().split('T')[0];
  const { data } = await db
    .from('machine_daily_summary')
    .select('utilisation_rate, number_of_possible_failures, number_of_offline_events, machines(machine_type)')
    .gte('date', since);

  if (!data || !data.length) {
    chart.setOption({ ...LIGHT_OPTS, graphic:[{type:'text',left:'center',top:'middle',style:{text:'No daily summary data yet',fill:'#999',fontSize:13}}] });
    return;
  }

  const brandOf = (machineType) => {
    const t = (machineType || '').toLowerCase();
    if (t.includes('bambu')) return 'Bambu';
    if (t.includes('prusa')) return 'Prusa';
    return 'Other';
  };

  const agg = {};
  for (const row of data) {
    const brand = brandOf(row.machines?.machine_type);
    if (!agg[brand]) agg[brand] = { utilSum: 0, n: 0, fail: 0, offline: 0 };
    agg[brand].utilSum += (row.utilisation_rate || 0);
    agg[brand].fail    += (row.number_of_possible_failures || 0);
    agg[brand].offline += (row.number_of_offline_events || 0);
    agg[brand].n++;
  }

  const brands = Object.keys(agg).filter(b => b !== 'Other');
  const avgUtil    = brands.map(b => parseFloat(((agg[b].utilSum / agg[b].n) * 100).toFixed(1)));
  const failEvents = brands.map(b => agg[b].fail);
  const offlineEvents = brands.map(b => agg[b].offline);

  chart.setOption({
    ...LIGHT_OPTS,
    tooltip: { trigger:'axis', axisPointer:{type:'shadow'} },
    legend: { data:['Avg utilisation %','Possible failures (30d)','Offline events (30d)'], textStyle:{color:'#444',fontSize:11}, top:0 },
    grid: { left:60, right:40, top:44, bottom:30 },
    xAxis: { type:'category', data:brands, axisLabel:{color:'#555',fontSize:12,fontWeight:600} },
    yAxis: [
      { type:'value', name:'%', max: v => Math.max(10, Math.min(100, Math.ceil(v.max*1.4/5)*5)), axisLabel:{color:'#888',fontSize:10,formatter:'{value}%'}, splitLine:{lineStyle:{color:'rgba(0,0,0,0.06)'}} },
      { type:'value', name:'events', axisLabel:{color:'#888',fontSize:10}, splitLine:{show:false} },
    ],
    series: [
      { name:'Avg utilisation %', type:'bar', yAxisIndex:0, data:avgUtil, itemStyle:{color:CHART_COLORS[0],borderRadius:[4,4,0,0]}, barMaxWidth:60 },
      { name:'Possible failures (30d)', type:'bar', yAxisIndex:1, data:failEvents, itemStyle:{color:CHART_COLORS[2],borderRadius:[4,4,0,0]}, barMaxWidth:60 },
      { name:'Offline events (30d)', type:'bar', yAxisIndex:1, data:offlineEvents, itemStyle:{color:CHART_COLORS[1],borderRadius:[4,4,0,0]}, barMaxWidth:60 },
    ],
  });
}

// ── 2.8 Daily job count trend ──────────────────────────────────────────────────
async function initJobCountTrend() {
  const chart = makeChart('chart-job-count');
  if (!chart) return;

  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString().split('T')[0];
  const { data } = await db
    .from('machine_daily_summary')
    .select('date, number_of_jobs')
    .gte('date', since)
    .order('date', { ascending: true });

  if (!data || !data.length) {
    chart.setOption({ ...LIGHT_OPTS, graphic:[{type:'text',left:'center',top:'middle',style:{text:'No daily summary data yet',fill:'#999',fontSize:13}}] });
    return;
  }

  const byDate = {};
  for (const row of data) byDate[row.date] = (byDate[row.date] || 0) + (row.number_of_jobs || 0);
  const dates = Object.keys(byDate).sort();
  const values = dates.map(d => byDate[d]);

  chart.setOption({
    ...LIGHT_OPTS,
    tooltip: { trigger:'axis', formatter: p => `${p[0].name}<br>${p[0].value} jobs across all machines` },
    grid: { left:45, right:20, top:20, bottom:30 },
    xAxis: { type:'category', data:dates, axisLabel:{color:'#888',fontSize:10,rotate:30} },
    yAxis: { type:'value', axisLabel:{color:'#888',fontSize:10}, splitLine:{lineStyle:{color:'rgba(0,0,0,0.06)'}} },
    series: [{ type:'bar', data:values, itemStyle:{color:CHART_COLORS[0],borderRadius:[3,3,0,0]}, barMaxWidth:18 }],
  });
}

// ── 2.9 Average temperature profile per machine ────────────────────────────────
async function initTempProfile() {
  const chart = makeChart('chart-temp-profile');
  if (!chart) return;

  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString().split('T')[0];
  const { data } = await db
    .from('machine_daily_summary')
    .select('machine_id, avg_nozzle_temp, avg_bed_temp, machines(name)')
    .gte('date', since);

  if (!data || !data.length) {
    chart.setOption({ ...LIGHT_OPTS, graphic:[{type:'text',left:'center',top:'middle',style:{text:'No daily summary data yet',fill:'#999',fontSize:13}}] });
    return;
  }

  const agg = {};
  for (const row of data) {
    const name = row.machines?.name || row.machine_id;
    if (!agg[name]) agg[name] = { nozzle: 0, bed: 0, n: 0 };
    if (row.avg_nozzle_temp != null) { agg[name].nozzle += Number(row.avg_nozzle_temp); }
    if (row.avg_bed_temp != null)    { agg[name].bed    += Number(row.avg_bed_temp); }
    agg[name].n++;
  }

  const names = Object.keys(agg);
  const nozzle = names.map(n => parseFloat((agg[n].nozzle / agg[n].n).toFixed(1)));
  const bed    = names.map(n => parseFloat((agg[n].bed / agg[n].n).toFixed(1)));

  chart.setOption({
    ...LIGHT_OPTS,
    tooltip: { trigger:'axis' },
    legend: { data:['Avg nozzle °C','Avg bed °C'], textStyle:{color:'#444',fontSize:11}, top:0 },
    grid: { left:110, right:20, top:40, bottom:30 },
    xAxis: { type:'value', axisLabel:{color:'#888',fontSize:10,formatter:'{value}°'}, splitLine:{lineStyle:{color:'rgba(0,0,0,0.06)'}} },
    yAxis: { type:'category', data:names, axisLabel:{color:'#555',fontSize:11} },
    series: [
      { name:'Avg nozzle °C', type:'bar', data:nozzle, itemStyle:{color:CHART_COLORS[4]}, barMaxWidth:9 },
      { name:'Avg bed °C',    type:'bar', data:bed,    itemStyle:{color:CHART_COLORS[1]}, barMaxWidth:9 },
    ],
  });
}

// ── 2.5 Sustainability estimate ────────────────────────────────────────────────
// Rough kWh / CO2 estimate from total_print_seconds. This is intentionally
// approximate (labelled as such in the UI) — we don't have per-machine power
// meters, so it assumes a flat average draw per printer and a UK grid
// carbon-intensity figure. Good for a talking point on an exhibit tour, not
// a precise energy audit.
const AVG_PRINTER_WATTS = 150;               // rough average draw incl. bed+hotend heating
const UK_GRID_KG_CO2_PER_KWH = 0.19;         // approx. recent UK grid average

async function initSustainability() {
  const el = document.getElementById('sustainability-result');
  if (!el) return;

  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString().split('T')[0];
  const { data } = await db
    .from('machine_daily_summary')
    .select('total_print_seconds')
    .gte('date', since);

  if (!data || !data.length) {
    el.textContent = 'Not enough data yet to estimate.';
    return;
  }

  const totalSeconds = data.reduce((a, r) => a + (r.total_print_seconds || 0), 0);
  const hours = totalSeconds / 3600;
  const kWh = (hours * AVG_PRINTER_WATTS) / 1000;
  const co2 = kWh * UK_GRID_KG_CO2_PER_KWH;

  el.innerHTML = `
    <div style="display:flex;gap:28px;flex-wrap:wrap;margin-bottom:8px">
      <div><span style="font-size:26px;font-weight:700;color:var(--accent)">${kWh.toFixed(0)}</span>
        <span style="font-size:11px;color:var(--muted);display:block;text-transform:uppercase;letter-spacing:0.05em">kWh (est.)</span></div>
      <div><span style="font-size:26px;font-weight:700;color:var(--accent)">${co2.toFixed(0)}</span>
        <span style="font-size:11px;color:var(--muted);display:block;text-transform:uppercase;letter-spacing:0.05em">kg CO₂e (est.)</span></div>
      <div><span style="font-size:26px;font-weight:700;color:var(--accent)">${Math.round(hours)}</span>
        <span style="font-size:11px;color:var(--muted);display:block;text-transform:uppercase;letter-spacing:0.05em">print hours</span></div>
    </div>
    <p style="font-size:11px;color:var(--muted);line-height:1.5">
      Estimated over the last 30 days across all machines. Assumes ~${AVG_PRINTER_WATTS}W average draw per printer
      and ${UK_GRID_KG_CO2_PER_KWH} kg CO₂e/kWh (approx. UK grid average) — a rough talking-point figure, not a metered measurement.
    </p>`;
}


// ── KPI strip (top of Analysis) ───────────────────────────────────────────────
// Standard dashboard convention: headline numbers first, detail charts after.
// This week vs last week, computed from machine_daily_summary.
async function initKPIs() {
  const el = document.getElementById('kpi-row');
  if (!el) return;
  const since = new Date(Date.now() - 14 * 24 * 3600_000).toISOString().split('T')[0];
  const { data } = await db
    .from('machine_daily_summary')
    .select('date, machine_id, utilisation_rate, number_of_jobs, total_print_seconds')
    .gte('date', since);
  if (!data || !data.length) { el.style.display = 'none'; return; }

  const cut = new Date(Date.now() - 7 * 24 * 3600_000).toISOString().split('T')[0];
  const week = data.filter(r => r.date >= cut);
  const prev = data.filter(r => r.date < cut);
  const agg = rows => ({
    util: rows.length ? rows.reduce((s, r) => s + (r.utilisation_rate || 0), 0) / rows.length * 100 : 0,
    jobs: rows.reduce((s, r) => s + (r.number_of_jobs || 0), 0),
    hours: rows.reduce((s, r) => s + (r.total_print_seconds || 0), 0) / 3600,
    machines: new Set(rows.filter(r => (r.number_of_jobs || 0) > 0 || (r.utilisation_rate || 0) > 0)
                          .map(r => r.machine_id)).size,
  });
  const a = agg(week), b = agg(prev);

  const delta = (now, before) => {
    if (!before) return '<span class="kpi-delta flat">&ndash;</span>';
    const pct = (now - before) / before * 100;
    if (Math.abs(pct) < 1) return '<span class="kpi-delta flat">&rarr; steady</span>';
    return `<span class="kpi-delta ${pct > 0 ? 'up' : 'down'}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)}% vs last week</span>`;
  };
  const card = (num, label, d) =>
    `<div class="kpi-card"><div class="kpi-num">${num}</div><div class="kpi-label">${label}</div>${d}</div>`;

  el.innerHTML =
    card(a.util.toFixed(1) + '%', 'Avg utilisation (7d)', delta(a.util, b.util)) +
    card(a.jobs, 'Print jobs (7d)', delta(a.jobs, b.jobs)) +
    card(Math.round(a.hours) + 'h', 'Print time (7d)', delta(a.hours, b.hours)) +
    card(a.machines, 'Machines active (7d)', delta(a.machines, b.machines));
}

// ── Init all ──────────────────────────────────────────────────────────────────
async function initAnalysis() {
  if (analysisRunning) return;
  analysisRunning = true;

  try {
    await Promise.all([
      initKPIs(),
      initHeatmap(),
      initUtilTrend(),
      initLeaderboard(),
      initHealthScores(),
      initFilamentUsage(),
      initFilamentType(),
      initBrandCompare(),
      initJobCountTrend(),
      initTempProfile(),
      initSustainability(),
    ]);
  } finally {
    analysisRunning = false;
    // Belt-and-braces: force a resize once everything has rendered, in case
    // any chart's container was still settling its layout at init time.
    setTimeout(() => allCharts.forEach(c => { try { c.resize(); } catch (e) {} }), 50);
  }
}

window.addEventListener('tab-analysis', initAnalysis);
