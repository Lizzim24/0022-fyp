# `dashboard/` — the web platform (front end)

The installable PWA served at **[0022-fyp.vercel.app](https://0022-fyp.vercel.app/)**. It reads directly from Supabase with a public **read-only** anon key and renders four views. No backend of its own, **no build step**, no framework — plain HTML/CSS/JS with three libraries pulled from a CDN.

```
Supabase (Postgres)  ──anon key, RLS read-only──▶  this app  ──▶  your phone
        ▲ RPCs: latest_status_per_machine, usage_by_weekday_hour,
          deduped_daily_jobs, filament_type_counts, machine_card_stats
```

## Files

| File | What it does |
|------|--------------|
| `index.html` | The whole UI: nav, the four `<section>` tab panels, the 3D/VR scene (`three-canvas`), and the isometric SVG maps. Loads `supabase-js`, `echarts` and Three.js from CDN. |
| `supabase.js` | Creates the Supabase client. Holds the project URL + **anon** key (public by design — safe to commit; protected by Row-Level Security). |
| `live.js` | **Live** view — machine status cards, updated in near-real time. |
| `analysis.js` | **Analysis** view — all KPIs and ECharts figures. |
| `planner.js` | **Scenario Planner** view — best-time, "who's free next", capacity simulator, maintenance windows. |
| `style.css` | Styling. |
| `manifest.json`, `service-worker.js`, `register-sw.js` | PWA plumbing: installable to home screen, caches the shell + last-known data so the app still opens offline. |
| `img/` | Static hero images and icons. |

## The four views

A **Visitor / Staff** toggle (top-right) hides the deep diagnostic panels so the exhibition view stays clean; Staff mode adds leaderboards, health scores and maintenance tools.

**🏠 Overview / Home** — an isometric map of both labs plus an interactive **3D/VR** scene (Three.js) you can drag and zoom. Live counts of online / printing / total. `LFLAB` / `CELab` switches labs.

**🟢 Live** — one card per machine: state, progress, temperatures, filament, and "soonest free". Reads `latest_status_per_machine()` (a LATERAL per-machine index lookup, so it stays fast against the million-row log).

**📊 Analysis** — see the module reference below.

**🗓️ Scenario Planner** — see the module reference below.

## Analysis modules — data → computation → meaning

- **KPI row** — `machine_daily_summary`, last 14 days split into this-week / last-week 7-day windows. Avg utilisation = mean of each machine's `utilisation_rate`; jobs and print-time are sums; the ± arrow is the week-over-week delta (±1% shows as "steady").
- **Usage heatmap** — RPC `usage_by_weekday_hour` (reads the `machine_hourly_usage` materialised view, refreshed every 30 min), 28-day window, converted to Europe/London. Each cell is the share of active status samples among all status samples for that weekday-hour slot. The measure is therefore sample-weighted rather than an equal-weight fleet fraction.
- **Utilisation trend** — `machine_daily_summary`, 30 days, daily mean `utilisation_rate` per lab. Grey `markArea` bands come from the front-end `DATA_GAPS` constant (add a row per known outage); they flag stretches where `connectNulls` has drawn a straight line across missing data that should not be trusted.
- **Filament types** — RPC `filament_type_counts` over the `filament_daily_usage` materialised view, 30 days, **counting only `state = 'PRINTING'` samples** (what was actually being printed, not what sat loaded while idle). Server-side pre-aggregation, so the result is stable — this replaced an older version that pulled raw rows and was silently truncated to a random 1,000-row slice each refresh.
- **Bambu vs Prusa** — `machine_daily_summary`, 30 days, grouped by brand: avg utilisation (left axis %) vs total `possible_failure` + offline events (right axis). The subtitle notes offline counts depend on reporting style (MQTT push vs REST poll), so reliability is **not** directly comparable across brands.
- **Sustainability** — 30-day `total_print_seconds` → hours × 150 W assumed draw = kWh; × 0.19 kg/kWh (approx. UK grid) = CO₂e. Both assumptions are printed on the card.
- **Leaderboards** — 30-day aggregates: utilisation (mean rate), offline (event totals, with an *adaptive* outlier flag — >10× the group median, so the "likely Wi-Fi" tag follows the problem instead of hard-coding a machine name), and failures (`possible_failure` totals).
- **Machine health score (v2)** — each noise channel is capped so no single signal can zero the score:
  ```
  score = 100
    − min(30, failures × 10)
    − min(25, round(manual_stop_rate × 50))    manual_stop_rate = print_stopped_manual ÷ jobs
    − min(15, ceil(offline ÷ 10))               connection noise capped; reconnect storms are network artefacts
    − min(10, pauses × 1)
  < 5 reporting days → "not enough data" card instead of a misleadingly high score
  ```
  Hovering a card shows the deduction breakdown. v1 was dominated by Wi-Fi flapping (a machine with 6,772 disconnects hit zero) and ignored manual stops entirely — v2 measures print quality, not network quietness. A known limitation: CoreOne-3's *planned* shutdowns still cost some offline points; the ideal fix is to distinguish planned vs unplanned downtime at the event layer.

## Scenario Planner modules

- **Best time to visit** — from the same heatmap table; the three Mon–Fri 09:00–18:00 cells with the lowest active share (cells with <3 samples skipped).
- **Guess who's next free** — last 5 minutes of raw logs, newest row per machine, filtered to `PRINTING` with `job_remaining > 0`. Needs ≥2 such machines to start; the user guesses which finishes first, scored by `job_remaining`.
- **Average wait time** — same weekday×hour table; for each working hour, expected wait ≈ all-busy probability × mean remaining time (a rough estimate, not queueing theory).
- **Capacity simulator** — demand = 30-day mean daily `total_active_minutes` (≈1,352 machine-min/day); capacity = machines × 9 h. Solid printer icons = machines the average demand occupies (`ceil(util × n)`), faded = spare capacity; colour shifts green→orange→red with pressure. Drag the slider to see how few machines the demand actually needs.
- **Maintenance window** — on load, calls `usage_by_weekday_hour(machine_filter)` once per machine (sub-second thanks to the materialised view) and lists, per machine, the quietest contiguous 2-hour Mon–Fri 08:00–20:00 window as a card (model icon + name + lab + window + historical busyness). Machines with <10 samples show "Not enough data yet".

## Run locally

```bash
cd dashboard
python3 -m http.server 8000     # open http://localhost:8000
```

It reads the public read-only Supabase project out of the box. To point at your own project, edit the two values in `supabase.js` (URL + anon key from Supabase → Settings → API).
