"""
Prusa MQTT + Database Agent (CELab)
Runs on Raspberry Pi, every 30 seconds:
  1. Collects data from all printers via PrusaLink HTTP API
  2. Publishes to cetools MQTT broker
  3. Writes to Supabase PostgreSQL (status logs + event detection)

Filament type, layer height, and nozzle diameter are extracted from the
PrusaSlicer filename convention:
  e.g. model_0.4n_0.2mm_PLA_COREONE_1h30m.bgcode
       -> filament_type=PLA, layer_height=0.2, nozzle_diameter=0.4

Dependencies:
    pip3 install requests paho-mqtt psycopg2-binary --break-system-packages

Credentials and printer configs live in config.py (not committed to git).
Copy config.example.py to config.py and fill in real values.
"""

import re, json, time, logging, requests
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
machine_ids         = {}  # name -> UUID (loaded from DB)
last_print_progress = {}  # name -> last known print progress while PRINTING


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


# ── Parse PrusaSlicer filename metadata ───────────────────────
def parse_filename_meta(display_name):
    """Extract print parameters from PrusaSlicer filename convention.

    PrusaSlicer embeds slice settings into the exported filename:
      <model>_<nozzle>n_<layer>mm_<filament>_<printer>_<time>.bgcode
      e.g. part_0.4n_0.2mm_PLA_COREONE_1h30m.bgcode

    Returns a dict with any of: filament_type, layer_height, nozzle_diameter
    Falls back gracefully if the filename doesn't match the convention.
    """
    result = {}
    if not display_name:
        return result
    # Nozzle diameter: e.g. _0.4n_
    m = re.search(r'_(\d+\.\d+)n_', display_name)
    if m:
        result['nozzle_diameter'] = float(m.group(1))
    # Layer height: e.g. _0.2mm_
    m = re.search(r'_(\d+\.\d+)mm_', display_name)
    if m:
        result['layer_height'] = float(m.group(1))
    # Filament type: e.g. _PLA_ / _PETG_ / _ASA_ / _PLA+_
    m = re.search(r'_\d+\.\d+mm_([A-Z][A-Z0-9+]*)_', display_name)
    if m:
        result['filament_type'] = m.group(1)
    return result


# ── Write status log ──────────────────────────────────────────
def insert_status_log(conn, name, status_data, job_data, online):
    mid = machine_ids.get(name)
    if not mid:
        return
    p = (status_data or {}).get("printer", {})
    j = (status_data or {}).get("job", {})

    active       = job_data is not None and job_data.get("state") == "PRINTING"
    display_name = (job_data or {}).get("file", {}).get("display_name", "")
    fname_meta   = parse_filename_meta(display_name)

    # Prefer API metadata; fall back to filename parsing
    filament_type = (
        (job_data or {}).get("file", {}).get("meta", {}).get("filament_type")
        or fname_meta.get("filament_type")
    )
    layer_height = fname_meta.get("layer_height")
    nozzle_diam  = fname_meta.get("nozzle_diameter")

    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO machine_status_logs
              (machine_id, timestamp, state, online, active,
               temp_nozzle, target_nozzle, temp_bed, target_bed,
               axis_z, speed, flow, fan_hotend_rpm, fan_print_rpm,
               job_progress, job_remaining, filament_type, layer_height, nozzle_diameter)
            VALUES (%s, NOW(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
            filament_type,
            layer_height,
            nozzle_diam,
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



# ── Log manual print stop event ───────────────────────────────
def log_print_stop_event(conn, name, progress):
    """PRINTING → IDLE/PAUSED 时记录停止事件，含停止时进度"""
    mid = machine_ids.get(name)
    if not mid:
        return
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO machine_events
                  (machine_id, event_type, severity, start_time, description, progress_at_stop)
                VALUES (%s, 'print_stopped_manual', 'warning', NOW(), %s, %s)
            """, (mid, f"Print manually stopped at {progress}%", progress))
        conn.commit()
        log.info(f"  {name}: print_stopped_manual at {progress}%")
    except Exception as e:
        log.error(f"  {name}: log_print_stop_event failed — {e}")

# ── Event detection ───────────────────────────────────────────
current_job = {}  # name -> filename of current job (None = idle). Fire print_started once per job.
def detect_events(conn, name, status_data, job_data, online):
    p    = (status_data or {}).get("printer", {})
    curr_state  = p.get("state", "UNKNOWN")
    curr_active = job_data is not None
    prev = prev_state.get(name, {})
    if prev.get("online") is True and not online:
        insert_event(conn, name, "machine_offline", "warning",
                     f"{name} went offline")
    elif prev.get("online") is False and online:
        insert_event(conn, name, "machine_online", "info",
                     f"{name} came back online")
    if online and status_data:
        prev_s = prev.get("state")
        if prev_s and prev_s != curr_state:
            insert_event(conn, name, "state_changed", "info",
                         f"State: {prev_s} → {curr_state}",
                         {"from": prev_s, "to": curr_state})
        # print_started fires ONCE per real job. curr_active (a job object exists)
        # already persists across pauses, so pauses never re-fire. The only
        # remaining inflation is a process restart clearing prev_state, which made
        # an already-running job look new. Track the job by filename and only fire
        # on a witnessed fresh start (machine seen job-less, then a job appears) or
        # a filename change; a job already running when first seen is adopted
        # silently, so restarts no longer emit a phantom start.
        job_key = None
        if curr_active:
            job_key = ((job_data or {}).get("file", {}).get("display_name")
                       or (job_data or {}).get("file", {}).get("name") or "unknown")
        tracked = current_job.get(name)
        if curr_active:
            witnessed_start = tracked is None and prev.get("active") is False
            new_file = tracked is not None and job_key != tracked
            if witnessed_start or new_file:
                insert_event(conn, name, "print_started", "info",
                             f"Print started: {job_key}",
                             {"filename": job_key})
            current_job[name] = job_key
        else:
            current_job.pop(name, None)
        if prev.get("active") and not curr_active and prev_s == "PRINTING":
            if curr_state == "FINISHED":
                insert_event(conn, name, "print_completed", "info",
                             "Print completed successfully")
            elif curr_state in ("STOPPED", "ERROR"):
                insert_event(conn, name, "print_stopped", "warning",
                             f"Print ended with state: {curr_state}")
        if prev_s == "PRINTING" and curr_state == "PAUSED":
            insert_event(conn, name, "print_paused", "info", "Print paused")
        if prev_s == "PAUSED" and curr_state == "PRINTING":
            insert_event(conn, name, "print_resumed", "info", "Print resumed")
        nozzle = p.get("temp_nozzle", 0)
        bed    = p.get("temp_bed", 0)
        if nozzle and nozzle > TEMP_WARNING_NOZZLE:
            insert_event(conn, name, "temperature_warning", "warning",
                         f"Nozzle temp high: {nozzle}°C",
                         {"temp_nozzle": nozzle})
        if bed and bed > TEMP_WARNING_BED:
            insert_event(conn, name, "temperature_warning", "warning",
                         f"Bed temp high: {bed}°C",
                         {"temp_bed": bed})
        if curr_state == "ERROR" and prev_s != "ERROR":
            insert_event(conn, name, "possible_failure", "error",
                         f"Printer entered ERROR state",
                         {"state": curr_state})
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
    """Flatten job data for MQTT publish.
    Note: filament_type here comes from file metadata only (for MQTT payload).
    The DB insert also checks the filename via parse_filename_meta as fallback.
    """
    if not raw: return {"active": False}
    f = raw.get("file", {})
    m = f.get("meta", {})
    fname_meta = parse_filename_meta(f.get("display_name", ""))
    return {
        "active":        True,
        "state":         raw.get("state"),
        "progress":      raw.get("progress"),
        "time_printing": raw.get("time_printing"),
        "time_remaining": raw.get("time_remaining"),
        "filename":      f.get("display_name") or f.get("name"),
        "filament_type": m.get("filament_type") or fname_meta.get("filament_type"),
        "layer_height":  m.get("layer_height")  or fname_meta.get("layer_height"),
        "nozzle_diameter": fname_meta.get("nozzle_diameter"),
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
                prev_before = prev_state.get(name, {})
                detect_events(conn, name, data["status"], data["job"], online)
                # Track progress while printing (for weighted stop detection)
                job_data = data["job"]
                if job_data and job_data.get("state") == "PRINTING":
                    prog = job_data.get("progress")
                    if prog is not None:
                        last_print_progress[name] = prog
                # Detect PRINTING → IDLE/PAUSED: log weighted stop event
                prev_s = (prev_before or {}).get("state", "").upper()
                curr_s = ((data["status"] or {}).get("printer", {}).get("state") or "").upper()
                if prev_s == "PRINTING" and curr_s in ("IDLE", "FINISH", "STOPPED", "PAUSED"):
                    stopped_at = last_print_progress.pop(name, None)
                    if stopped_at is not None:
                        log_print_stop_event(conn, name, stopped_at)

            except (psycopg2.OperationalError, psycopg2.InterfaceError):
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
    