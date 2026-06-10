# config.example.py
# Copy this file to config.py and fill in real values.
# config.py is listed in .gitignore and should never be committed.

# ── cetools MQTT (outbound publishing) ────────────────────────
MQTT_HOST     = "mqtt.cetools.org"
MQTT_PORT     = 1884
MQTT_USER     = "your_mqtt_username"
MQTT_PASSWORD = "your_mqtt_password"
MQTT_PREFIX   = "student/your_username/lfl"

# ── Supabase Connection Pooler ────────────────────────────────
DB_PARAMS = {
    "host":     "your-supabase-pooler-host",
    "port":     6543,
    "dbname":   "postgres",
    "user":     "postgres.your_project_id",
    "password": "your_supabase_password"
}

# ── Bambu printers ────────────────────────────────────────────
# IPs are auto-discovered via ARP; set ip=None to let the agent find them.
BAMBU_PRINTERS = [
    {"name": "LFL-H2D-XXX", "serial": "YOUR_SERIAL", "access_code": "YOUR_CODE", "ip": None, "mac": "xx:xx:xx:xx:xx:xx"},
    # add more printers...
]

# ── Prusa printers ────────────────────────────────────────────
PRUSA_PRINTERS = [
    {"name": "LFL-PrusaXL-A", "ip": None, "mac": "xx:xx:xx:xx:xx:xx", "user": "maker", "password": "your_password"},
    # add more printers...
]

# ── Poll interval (seconds) ───────────────────────────────────
POLL_INTERVAL = 30
