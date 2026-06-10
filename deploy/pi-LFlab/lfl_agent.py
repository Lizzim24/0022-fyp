"""
Light Fabrication Lab (LFL) Agent
Runs on Raspberry Pi 3, handling:
  - Bambu Lab H2D x4 + X1-Carbon x2  (local MQTT, port 8883, TLS)
  - Prusa XL x2 + Prusa Core One x1   (PrusaLink HTTP API)

Dependencies:
    pip3 install requests paho-mqtt psycopg2-binary --break-system-packages

Ensure all printers are connected to the Pi hotspot (RaspAP) before starting.
IPs are discovered automatically via ARP table lookup by MAC address.

Credentials and printer configs live in config.py (not committed to git).
Copy config.example.py to config.py and fill in real values.
"""
import json, time, logging, ssl, subprocess, requests
from config import (
    MQTT_HOST, MQTT_PORT, MQTT_USER, MQTT_PASSWORD, MQTT_PREFIX,
    DB_PARAMS, BAMBU_PRINTERS, PRUSA_PRINTERS, POLL_INTERVAL
)
from requests.auth import HTTPDigestAuth
import paho.mqtt.client as mqtt
import psycopg2
from datetime import datetime, timezone

# ══════════════════════════════════════════════════════════════

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

machine_ids       = {}  # name -> UUID
last_db_write     = {}  # name -> last write timestamp
last_connectivity = {}  # name -> True/False, dedup offline events
prev_state        = {}  # name -> last known state dict
bambu_clients     = {}  # name -> paho client


def get_db():
    return psycopg2.connect(**DB_PARAMS)


# ── IP discovery via ARP table (match by MAC) ─────────────────
def discover_ips():
    result = subprocess.run(["arp", "-a"], capture_output=True, text=True)
    arp_table = {}
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 4:
            ip  = parts[1].strip("()")
            mac = parts[3].lower()
            arp_table[mac] = ip
    for p in BAMBU_PRINTERS + PRUSA_PRINTERS:
        mac = p["mac"].lower()
        if mac in arp_table:
            if p["ip"] != arp_table[mac]:
                p["ip"] = arp_table[mac]
                log.info(f"  Discovered {p['name']}: {p['ip']}")
        else:
            if p["ip"] is None:
                log.warning(f"  {p['name']} not in ARP (not connected?)")


# ── Sync machines table ───────────────────────────────────────
def ensure_machines(conn):
    with conn.cursor() as cur:
        for p in BAMBU_PRINTERS + PRUSA_PRINTERS:
            cur.execute("""
                INSERT INTO machines (name, ip_address, lab)
                VALUES (%s, %s, 'LFL')
                ON CONFLICT (name) DO UPDATE SET
                    ip_address = COALESCE(EXCLUDED.ip_address, machines.ip_address),
                    updated_at = NOW()
                RETURNING id
            """, (p["name"], p.get("ip")))
            machine_ids[p["name"]] = cur.fetchone()[0]
    conn.commit()
    log.info(f"Machines synced: {list(machine_ids.keys())}")


# ── Write status log ──────────────────────────────────────────
def insert_status_log(conn, name, data, online):
    mid = machine_ids.get(name)
    if not mid:
        return
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO machine_status_logs
              (machine_id, timestamp, state, online, active,
               temp_nozzle, target_nozzle, temp_bed, target_bed,
               job_progress, job_remaining)
            VALUES (%s, NOW(), %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (
            mid,
            data.get("state"),
            online,
            data.get("active", False),
            data.get("nozzle_temp"),
            data.get("nozzle_target"),
            data.get("bed_temp"),
            data.get("bed_target"),
            data.get("progress"),
            data.get("remaining"),
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


# ── Event detection (state-change based) ─────────────────────
def detect_events(conn, name, data, online):
    prev = prev_state.get(name, {})

    if prev.get("online") is True and not online:
        insert_event(conn, name, "machine_offline", "warning", f"{name} went offline")
    elif prev.get("online") is False and online:
        insert_event(conn, name, "machine_online", "info", f"{name} came back online")

    if online:
        if not prev.get("active") and data.get("active"):
            insert_event(conn, name, "print_started", "info",
                         f"Print started: {data.get('filename', 'unknown')}",
                         {"filename": data.get("filename")})
        if prev.get("active") and not data.get("active") and prev.get("state") == "PRINTING":
            if data.get("state") == "FINISHED":
                insert_event(conn, name, "print_completed", "info", "Print completed")
            elif data.get("state") in ("ERROR", "FAILED", "STOPPED"):
                insert_event(conn, name, "possible_failure", "error",
                             f"Print ended with state: {data.get('state')}")
        if prev.get("state") == "PRINTING" and data.get("state") == "PAUSED":
            insert_event(conn, name, "print_paused", "info", "Print paused")
        if prev.get("state") == "PAUSED" and data.get("state") == "PRINTING":
            insert_event(conn, name, "print_resumed", "info", "Print resumed")

    prev_state[name] = {**data, "online": online}


# ══════════════════════════════════════════════════════════════
#  Bambu local MQTT subscription
# ══════════════════════════════════════════════════════════════
BAMBU_STATE_MAP = {
    "RUNNING":  "PRINTING",
    "PAUSE":    "PAUSED",
    "IDLE":     "IDLE",
    "FINISH":   "FINISHED",
    "FAILED":   "ERROR",
    "PREPARE":  "PREPARING",
    "SLICING":  "SLICING",
}


def connect_bambu(cfg, mqtt_pub, conn):
    """Connect to a single Bambu printer's local MQTT broker."""
    name   = cfg["name"]
    serial = cfg["serial"]
    ip     = cfg["ip"]

    if not ip:
        log.warning(f"  {name}: No IP yet, skipping")
        return None

    def on_message(client, userdata, msg):
        try:
            payload    = json.loads(msg.payload)
            print_data = payload.get("print", {})
            raw_state  = print_data.get("gcode_state", "UNKNOWN")
            state      = BAMBU_STATE_MAP.get(raw_state, raw_state)
            active     = state == "PRINTING"
            data = {
                "state":         state,
                "active":        active,
                "nozzle_temp":   print_data.get("nozzle_temper"),
                "nozzle_target": print_data.get("nozzle_target_temper"),
                "bed_temp":      print_data.get("bed_temper"),
                "bed_target":    print_data.get("bed_target_temper"),
                "progress":      print_data.get("mc_percent"),
                "remaining":     print_data.get("mc_remaining_time"),
                "filename":      print_data.get("subtask_name"),
                "layer":         print_data.get("layer_num"),
                "total_layers":  print_data.get("total_layer_num"),
            }
            # Publish to cetools MQTT
            mqtt_pub.publish(
                f"{MQTT_PREFIX}/{name}/status",
                json.dumps({**data, "_ts": datetime.now(timezone.utc).isoformat()}),
                qos=1, retain=True
            )
            # Write to DB (throttled: write on state change or every 30s max)
            now = time.time()
            prev = prev_state.get(name, {})
            state_changed = prev.get("state") != data.get("state") or prev.get("active") != data.get("active")
            if state_changed or (now - last_db_write.get(name, 0)) >= 30:
                insert_status_log(conn, name, data, True)
                detect_events(conn, name, data, True)
                last_db_write[name] = now
            log.info(f"  {name}: {state} {data.get('progress', '')}%")
        except Exception as e:
            log.error(f"  {name} message error: {e}")

    def on_connect(client, userdata, flags, rc):
        if rc == 0:
            log.info(f"  {name}: Connected to Bambu MQTT")
            client.subscribe(f"device/{serial}/report")
            # Only fire machine_online event on state transition
            if last_connectivity.get(name) is not True:
                insert_event(conn, name, "machine_online", "info", f"{name} connected")
            last_connectivity[name] = True
        else:
            log.warning(f"  {name}: Bambu MQTT connect failed rc={rc}")

    def on_disconnect(client, userdata, rc):
        log.warning(f"  {name}: Bambu MQTT disconnected rc={rc}")
        # Only fire machine_offline event on state transition
        if last_connectivity.get(name) is not False:
            insert_event(conn, name, "machine_offline", "warning", f"{name} disconnected")
            last_connectivity[name] = False

    c = mqtt.Client(client_id=f"lfl-{serial[-6:]}", clean_session=True,
                    protocol=mqtt.MQTTv311)
    c.username_pw_set("bblp", cfg["access_code"])
    c.tls_set(cert_reqs=ssl.CERT_NONE)
    c.tls_insecure_set(True)
    c.on_connect    = on_connect
    c.on_message    = on_message
    c.on_disconnect = on_disconnect

    try:
        c.connect(ip, 8883, keepalive=60)
        c.loop_start()
        log.info(f"  {name}: Connecting to {ip}:8883")
        return c
    except Exception as e:
        log.error(f"  {name}: Cannot connect {ip}:8883 — {e}")
        return None


# ══════════════════════════════════════════════════════════════
#  Prusa HTTP polling
# ══════════════════════════════════════════════════════════════
def fetch_prusa(cfg):
    base = f"http://{cfg['ip']}"
    auth = HTTPDigestAuth(cfg["user"], cfg["password"])

    def get(path):
        try:
            r = requests.get(f"{base}{path}", auth=auth, timeout=5)
            return r.json() if r.status_code == 200 else None
        except:
            return None

    return {
        "status": get("/api/v1/status"),
        "job":    get("/api/v1/job"),
    }


def poll_prusa(conn, mqtt_pub):
    for cfg in PRUSA_PRINTERS:
        if not cfg["ip"]:
            continue
        name = cfg["name"]
        log.info(f"Polling {name}")
        try:
            raw    = fetch_prusa(cfg)
            online = raw["status"] is not None
            p      = (raw["status"] or {}).get("printer", {})
            j      = (raw["status"] or {}).get("job", {})
            job    = raw["job"]
            active = job is not None and job.get("state") == "PRINTING"
            data = {
                "state":         p.get("state"),
                "active":        active,
                "nozzle_temp":   p.get("temp_nozzle"),
                "nozzle_target": p.get("target_nozzle"),
                "bed_temp":      p.get("temp_bed"),
                "bed_target":    p.get("target_bed"),
                "progress":      j.get("progress"),
                "remaining":     j.get("time_remaining"),
                "filename":      (job or {}).get("file", {}).get("display_name"),
            }
            mqtt_pub.publish(f"{MQTT_PREFIX}/{name}/online",
                             json.dumps({"online": online}), qos=1, retain=True)
            if online:
                mqtt_pub.publish(
                    f"{MQTT_PREFIX}/{name}/status",
                    json.dumps({**data, "_ts": datetime.now(timezone.utc).isoformat()}),
                    qos=1, retain=True
                )
            insert_status_log(conn, name, data, online)
            detect_events(conn, name, data, online)
        except psycopg2.OperationalError:
            log.warning("DB disconnected, reconnecting...")
            try:
                conn = get_db()
            except Exception as e:
                log.error(f"Reconnect failed: {e}")
        except Exception as e:
            log.error(f"  {name} error: {e}")


# ══════════════════════════════════════════════════════════════
#  Main
# ══════════════════════════════════════════════════════════════
def run():
    # Connect to cetools MQTT (outbound publishing)
    mqtt_pub = mqtt.Client(client_id="lfl-agent-pub", clean_session=True)
    mqtt_pub.username_pw_set(MQTT_USER, MQTT_PASSWORD)
    mqtt_pub.on_connect = lambda c, u, f, rc: log.info(f"cetools MQTT connected rc={rc}")
    mqtt_pub.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
    mqtt_pub.loop_start()

    # Connect to database
    log.info("Connecting to Supabase...")
    conn = get_db()
    log.info("DB connected")

    # Initial IP discovery
    log.info("Discovering printer IPs via ARP...")
    discover_ips()

    # Sync machines table
    ensure_machines(conn)

    # Connect all Bambu printers
    for cfg in BAMBU_PRINTERS:
        c = connect_bambu(cfg, mqtt_pub, conn)
        if c:
            bambu_clients[cfg["name"]] = c

    log.info(f"Starting poll loop, interval {POLL_INTERVAL}s")
    while True:
        # Re-discover IPs periodically (handles printer reconnections)
        discover_ips()

        # Connect any Bambu printers that have an IP but no client yet
        for cfg in BAMBU_PRINTERS:
            if cfg["ip"] and cfg["name"] not in bambu_clients:
                c = connect_bambu(cfg, mqtt_pub, conn)
                if c:
                    bambu_clients[cfg["name"]] = c

        # Poll Prusa printers
        poll_prusa(conn, mqtt_pub)
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    run()
