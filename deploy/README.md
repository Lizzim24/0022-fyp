# `deploy/` — data acquisition + database

This is the edge layer that turns two different printer brands into one clean stream in Postgres. A Raspberry Pi in each lab runs a Python agent that talks to its machines on their own protocol, normalises every reading into one shape, infers events, and writes to Supabase. A nightly job rolls the raw log into daily summaries.

```
deploy/
├── pi-LFlab/     # Light Fabrication Lab — Bambu (MQTT) + Prusa XL
│   ├── lfl_agent.py
│   ├── daily_summary.py
│   └── config.example.py
├── pi-CElab/     # Connected Environments Lab — Prusa Core One (PrusaLink REST)
│   ├── prusa_mqtt_agent.py
│   ├── prusa-agent.service
│   ├── daily_summary.py
│   └── config.example.py
└── supabase/
    └── schema.sql   # full database: tables, matviews, RPCs, RLS, cron
```

## The two agents, side by side

| | **pi-LFlab** (`lfl_agent.py`) | **pi-CElab** (`prusa_mqtt_agent.py`) |
|---|---|---|
| Machines | Bambu H2D ×4, X1-Carbon ×2 (+ Prusa XL) | Prusa Core One ×N |
| Protocol | **Local MQTT** over TLS, port 8883 (push) | **PrusaLink HTTP API** (poll) |
| Auth | Per-printer serial + access code | HTTP Digest (`user` / `password`) |
| Discovery | IPs resolved from the **ARP table by MAC** (`ip=None` → auto) | same |
| Also | Republishes to the cetools MQTT broker | Republishes to MQTT |
| Writes to | Supabase Postgres (via connection pooler, `psycopg2`) | same |

Both agents share the same core responsibilities, in one poll loop every `POLL_INTERVAL` (30 s):

1. **`ensure_machines()`** — upsert each printer into `machines`.
2. **`insert_status_log()`** — write one normalised row into `machine_status_logs` (state, online/active, temps, axis, speeds, fans, job progress/remaining, filament type/brand/colour/remain).
3. **`detect_events()`** — compare against the previous reading and emit `machine_events` (online/offline, `print_started`, pause/resume, `print_completed`, `print_stopped_manual`, `possible_failure`). Each real job now emits **exactly one `print_started`** — see the note below.
4. Publish a compact status to MQTT for anything else on the network.

### PrusaLink specifics (`prusa_mqtt_agent.py`)
`fetch_printer()` calls four REST endpoints per poll — `/api/v1/status`, `/api/v1/job`, `/api/v1/info`, `/api/v1/storage` — with `HTTPDigestAuth`. `flatten_status()` and `flatten_job()` reshape the vendor JSON into the common schema before it is logged.

### `print_started` correctness (both agents)
Earlier versions re-fired `print_started` every time a job briefly left and re-entered the printing state (a pause, a reconnect, a process restart), inflating LFLab job counts ~20–40×. The agents now track the **identity of the job on the bed** (`current_job`) and emit a start only for a genuinely new job (fresh start, or a filename change); a job already running when the agent first sees it is adopted silently. `machine_status_logs`, utilisation and `print_completed` were never affected. Full write-up in the repo's agent changelog.

## `daily_summary.py`
Runs at **00:05 daily via cron**, aggregating the previous day's `machine_status_logs` + `machine_events` into one `machine_daily_summary` row per machine: online/active/idle minutes (sample count × `POLL_INTERVAL`), utilisation rate, job/pause/failure/offline counts, temperature averages (>0 samples only), and total print seconds.

```cron
5 0 * * * /usr/bin/python3 /home/pi_24/prusa-agent/daily_summary.py >> daily_summary.log 2>&1
```
Backfill a specific day with: `python3 daily_summary.py 2026-05-25`.

## Setup (per Pi)

```bash
pip3 install requests paho-mqtt psycopg2-binary --break-system-packages
cp config.example.py config.py      # then fill in real values
```

`config.py` holds the MQTT credentials, the **Supabase pooler** connection (`DB_PARAMS`, port 6543), and the printer list (serials / access codes / digest passwords). Run the agent as a service so it restarts on boot — `pi-CElab/prusa-agent.service` is the template:

```bash
sudo cp prusa-agent.service /etc/systemd/system/
sudo systemctl enable --now prusa-agent
journalctl -u prusa-agent -f      # follow logs
```

On the LFLab Pi the same pattern applies (service name `lfl-agent`); that Pi also runs a RaspAP Wi-Fi access point that the Bambu machines join.

## `supabase/schema.sql`
The complete database — six tables (`machines`, `machine_status_logs`, `machine_events`, `machine_daily_summary`, `alert_config`, `alert_log`), two materialised views, the RPC functions the dashboard calls, Row-Level Security (public read on the four data tables only), and the pg_cron jobs (health check + matview refresh). Run it once in Supabase → SQL Editor.

## ⚠️ Secrets
`config.py` and any `service_role` key **must never be committed** — keep `config.py` in `.gitignore`. The Slack webhook lives in the `alert_config` table (inserted once by hand), not in the repo. The dashboard's **anon** key is safe to commit: it is public and constrained by RLS.
