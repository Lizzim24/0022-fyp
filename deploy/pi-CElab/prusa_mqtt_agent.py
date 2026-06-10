"""
Prusa MQTT + Database Agent (CELab)
Runs on Raspberry Pi, every 30 seconds:
  1. Collects data from all printers
  2. Publishes to MQTT
  3. Writes to Supabase PostgreSQL (status logs + event detection)

Dependencies:
    pip3 install requests paho-mqtt psycopg2-binary --break-system-packages

Credentials and printer configs live in config.py (not committed to git).
Copy config.example.py to config.py and fill in real values.
"""

import json, time, logging, requests
from requests.auth import HTTPDigestAuth
import paho.mqtt.client as mqtt
import psycopg2
import psycopg2.extras
from datetime import datetime, timezone
from config import (
    MQTT_HOST, MQTT_PORT, MQTT_USER, MQTT_PASSWORD, MQTT_PREFIX,
    DB_PARAMS, PRINTERS, POLL_INTERVAL,
    TEMP_WARNING_NOZZLE, TEMP_WARNING_BED
)

# ══════════════════════════════════════════════════════════════

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

prev_state  = {}  # name -> {"state": str, "online": bool, "active": bool}
machine_ids = {}  # name -> UUID (loaded from DB)


# ── Database connection ───────────────────────────────────────
def get_db():
    return psycopg2.connect(**DB_PARAMS)


# ── Sync machines table on startup ───────────────────────────
def ensure_machines(conn, all_info):
    """all_info: {name: info_json_or_None}"""
    with conn.cursor() as cur:
        for name, info in all_info.items():
            cfg = next(p for p in PRINTERS if p["name"] == name)
            cur.execute("""
                INSERT INTO machines (name, hostname, serial, nozzle_diameter,
                                      mmu, min_extrusion_temp, farm_mode, ip_address)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (name) DO UPDATE SET
                    hostname           = EXCLUDED.hostname,
                    serial             = EXCLUDED.serial,
                    nozzle_diameter    = EXCLUDED.nozzle_diameter,
                    mmu                = EXCLUDED.mmu,
                    min_extrusion_temp = EXCLUDED.min_extrusion_temp,
                    farm_mode          = EXCLUDED.farm_mode,
                    ip_address         = EXCLUDED.ip_address,
                    updated_at         = NOW()
                RETURNING id
            """, (
                name,
                info.get("hostname") if info else None,
                info.get("serial")   if info else None,
                info.get("nozzle_diameter") if info else None,
                info.get("mmu", False) if info else False,
                info.get("min_extrusion_temp") if info else None,
                info.get("farm_mode", False) if info else False,
                cfg["ip"],
            ))
            machine_ids[name] = cur.fetchone()[0]
    conn.commit()
    log.info(f"Machines synced: {list(machine_ids.keys())}")


# ── Write status log ──────────────────────────────────────────
def insert_status_log(conn, name, status_data, job_data, online):
    mid = machine_ids.get(name)
    if not mid:
        return
    p = (status_data or {}).get("printer", {})
    j = (status_data or {}).get("job", {})
    active = job_data is not None and job_data.get("state") == "PRINTING"

    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO machine_status_logs
              (machine_id, timestamp, state, online, active,
               temp_nozzle, target_nozzle, temp_bed, target_bed,
               axis_z, speed, flow, fan_hotend_rpm, fan_print_rpm,
               job_progress, job_remaining)
            VALUES (%s, NOW(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (
            mid,
            p.get("state"),
            online,
            active,
            p.get("temp_nozzle"),
            p.get("target_nozzle"),
            p.get("temp_bed"),
            p.get("target_bed"),
            p.get("axis_z"),
            p.get("speed"),
            p.get("flow"),
            p.get("fan_hotend"),
            p.get("fan_print"),
            j.get("progress"),
            j.get("time_remaining"),
        ))
    conn.commit()


# ── Write event ───────────────────────────────────────────────
def insert_event(conn, name, event_type, severity="info", description="", metadata=None):
    mid = machine_ids.get(name)
    if not mid:
        return
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO machine_events
              (machine_id, event_type, severity, start_time, description, metadata)
            VALUES (%s, %s, %s, NOW(), %s, %s)
        """, (mid, event_type, severity, description,
              json.dumps(metadata) if metadata else None))
    conn.commit()
    log.info(f"  [EVENT] {name} | {event_type} | {description}")


# ── Event detection ───────────────────────────────────────────
def detect_events(conn, name, status_data, job_data, online):
    p           = (status_data or {}).get("printer", {})
    curr_state  = p.get("state", "UNKNOWN")
    curr_active = job_data is not None
    prev        = prev_state.get(name, {})

    # Online / offline transitions
    if prev.get("online") is True and not online:
        insert_event(conn, name, "machine_offline", "warning", f"{name} went offline")
    elif prev.get("online") is False and online:
        insert_event(conn, name, "machine_online", "info", f"{name} came back online")

    if online and status_data:
        prev_s = prev.get("state")

        # State change
        if prev_s and prev_s != curr_state:
            insert_event(conn, name, "state_changed", "info",
                         f"State: {prev_s} → {curr_state}",
                         {"from": prev_s, "to": curr_state})

        # Print started
        if not prev.get("active") and curr_active:
            filename = (job_data or {}).get("file", {}).get("display_name") or \
                       (job_data or {}).get("file", {}).get("name", "unknown")
            insert_event(conn, name, "print_started", "info",
                         f"Print started: {filename}",
                         {"filename": filename})

        # Print finished / stopped
        if prev.get("active") and not curr_active and prev_s == "PRINTING":
            if curr_state == "FINISHED":
                insert_event(conn, name, "print_completed", "info",
                             "Print completed successfully")
            elif curr_state in ("STOPPED", "ERROR"):
                insert_event(conn, name, "print_stopped", "warning",
                             f"Print ended with state: {curr_state}")

        # Paused / resumed
        if prev_s == "PRINTING" and curr_state == "PAUSED":
            insert_event(conn, name, "print_paused", "info", "Print paused")
        if prev_s == "PAUSED" and curr_state == "PRINTING":
            insert_event(conn, name, "print_resumed", "info", "Print resumed")

        # Temperature warnings
        nozzle = p.get("temp_nozzle", 0)
        bed    = p.get("temp_bed", 0)
        if nozzle and nozzle > TEMP_WARNING_NOZZLE:
            insert_event(conn, name, "temperature_warning", "warning",
                         f"Nozzle temp high: {nozzle}°C", {"temp_nozzle": nozzle})
        if bed and bed > TEMP_WARNING_BED:
            insert_event(conn, name, "temperature_warning", "warning",
                         f"Bed temp high: {bed}°C", {"temp_bed": bed})

        # Error state
        if curr_state == "ERROR" and prev_s != "ERROR":
            insert_event(conn, name, "possible_failure", "error",
                         "Printer entered ERROR state", {"state": curr_state})

    prev_state[name] = {"state": curr_state, "online": online, "active": curr_active}


# ── Fetch data from a single Prusa printer ───────────────────
def fetch_printer(cfg):
    base = f"http://{cfg['ip']}"
    auth = HTTPDigestAuth(cfg["user"], cfg["password"])
    def get(path):
        try:
            r = requests.get(f"{base}{path}", auth=auth, timeout=5)
            return r.json() if r.status_code == 200 else None
        except:
            return None
    return {
        "status":  get("/api/v1/status"),
        "job":     get("/api/v1/job"),
        "info":    get("/api/v1/info"),
        "storage": get("/api/v1/storage"),
    }


# ── MQTT publish helpers ──────────────────────────────────────
def publish(client, name, subtopic, payload):
    topic = f"{MQTT_PREFIX}/{name}/{subtopic}"
    client.publish(topic,
                   json.dumps({**payload, "_ts": datetime.now(timezone.utc).isoformat()}),
                   qos=1, retain=True)
    log.info(f"  -> {topic}")


def flatten_status(raw):
    if not raw: return {}
    p = raw.get("printer", {})
    j = raw.get("job", {})
    d = {
        "state": p.get("state"), "temp_nozzle": p.get("temp_nozzle"),
        "target_nozzle": p.get("target_nozzle"), "temp_bed": p.get("temp_bed"),
        "target_bed": p.get("target_bed"), "axis_z": p.get("axis_z"),
        "speed": p.get("speed"), "flow": p.get("flow"),
        "fan_hotend_rpm": p.get("fan_hotend"), "fan_print_rpm": p.get("fan_print"),
        "job_progress": j.get("progress"), "job_remaining": j.get("time_remaining"),
    }
    return {k: v for k, v in d.items() if v is not None}


def flatten_job(raw):
    if not raw: return {"active": False}
    f = raw.get("file", {}); m = f.get("meta", {})
    return {
        "active": True, "state": raw.get("state"),
        "progress": raw.get("progress"),
        "time_printing": raw.get("time_printing"),
        "time_remaining": raw.get("time_remaining"),
        "filename": f.get("display_name") or f.get("name"),
        "filament_type": m.get("filament_type"),
        "layer_height": m.get("layer_height"),
    }


# ── Main ──────────────────────────────────────────────────────
def run():
    # Connect to MQTT
    mqtt_client = mqtt.Client(client_id="prusa-agent", clean_session=True)
    mqtt_client.username_pw_set(MQTT_USER, MQTT_PASSWORD)
    mqtt_client.on_connect = lambda c, u, f, rc: log.info(f"MQTT connected rc={rc}")
    mqtt_client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
    mqtt_client.loop_start()

    # Connect to database
    log.info("Connecting to Supabase...")
    conn = get_db()
    log.info("DB connected")

    # Initial info fetch to sync machines table
    log.info("Syncing machines static info...")
    all_info = {}
    for cfg in PRINTERS:
        data = fetch_printer(cfg)
        all_info[cfg["name"]] = data.get("info")
    ensure_machines(conn, all_info)

    log.info(f"Starting poll loop, interval {POLL_INTERVAL}s")

    while True:
        for cfg in PRINTERS:
            name = cfg["name"]
            log.info(f"Polling {name}")
            try:
                data   = fetch_printer(cfg)
                online = data["status"] is not None

                # Publish to MQTT
                mqtt_client.publish(f"{MQTT_PREFIX}/{name}/online",
                                    json.dumps({"online": online}), qos=1, retain=True)
                if online:
                    publish(mqtt_client, name, "status", flatten_status(data["status"]))
                    publish(mqtt_client, name, "job",    flatten_job(data["job"]))
                    if data["storage"]:
                        publish(mqtt_client, name, "storage", {"devices": data["storage"]})

                # Write to DB
                insert_status_log(conn, name, data["status"], data["job"], online)
                detect_events(conn, name, data["status"], data["job"], online)

            except psycopg2.OperationalError:
                log.warning("DB disconnected, reconnecting...")
                try:
                    conn = get_db()
                except Exception as e:
                    log.error(f"Reconnect failed: {e}")
            except Exception as e:
                log.error(f"  {name} error: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    run()
