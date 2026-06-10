# config.example.py (CELab)
# Copy this file to config.py and fill in real values.
# config.py is listed in .gitignore and should never be committed.

# ── cetools MQTT ──────────────────────────────────────────────
MQTT_HOST     = "mqtt.cetools.org"
MQTT_PORT     = 1884
MQTT_USER     = "your_mqtt_username"
MQTT_PASSWORD = "your_mqtt_password"
MQTT_PREFIX   = "student/your_username/prusa"

# ── Supabase Connection Pooler ────────────────────────────────
DB_PARAMS = {
    "host":     "your-supabase-pooler-host",
    "port":     6543,
    "dbname":   "postgres",
    "user":     "postgres.your_project_id",
    "password": "your_supabase_password"
}

# ── Printers ──────────────────────────────────────────────────
PRINTERS = [
    {"name": "CoreOne-2", "ip": "x.x.x.x", "user": "maker", "password": "your_password"},
    {"name": "CoreOne-4", "ip": "x.x.x.x", "user": "maker", "password": "your_password"},
    # add more printers...
]

# ── Poll interval (seconds) ───────────────────────────────────
POLL_INTERVAL = 30

# ── Temperature warning thresholds ───────────────────────────
TEMP_WARNING_NOZZLE = 260  # trigger warning above this nozzle temp (°C)
TEMP_WARNING_BED    = 120  # trigger warning above this bed temp (°C)
