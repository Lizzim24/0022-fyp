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
import re, json, time, logging, ssl, subprocess, requests
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
ams_cache         = {}  # name -> {"filament_type": str} from last AMS payload
last_print_progress = {}  # name -> last known print progress


def get_db():
    return psycopg2.connect(**DB_PARAMS)


# ── Parse PrusaSlicer filename metadata ───────────────────────
def parse_filename_meta(display_name):
    """Extract print parameters from PrusaSlicer filename convention.
    e.g. part_0.4n_0.2mm_PLA_COREONE_1h30m.bgcode
    -> filament_type=PLA, layer_height=0.2, nozzle_diameter=0.4
    Only applies to Prusa printers (Bambu uses AMS for filament info).
    """
    result = {}
    if not display_name:
        return result
    m = re.search(r'_(\d+\.\d+)n_', display_name)
    if m:
        result['nozzle_diameter'] = float(m.group(1))
    m = re.search(r'_(\d+\.\d+)mm_', display_name)
    if m:
        result['layer_height'] = float(m.group(1))
    m = re.search(r'_\d+\.\d+mm_([A-Z][A-Z0-9+]*)_', display_name)
    if m:
        result['filament_type'] = m.group(1)
    return result


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

def log_print_stop_event(conn, name, progress):
    """Called when the machine switches from PRINTING to IDLE/PAUSED, this function logs the stop event."""
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
               job_progress, job_remaining,
               filament_type, nozzle_diameter, layer_height,
               filament_brand, filament_color, filament_remain)
            VALUES (%s, NOW(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
            data.get("filament_type"),
            data.get("nozzle_diameter"),
            data.get("layer_height"),
            data.get("filament_brand"),
            data.get("filament_color"),
            data.get("filament_remain"),
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

            # ── Extract AMS filament data ─────────────────────────
            # tray_now: "0"-"3" = AMS slot, "254" = external spool, "255" = none/idle
            ams_info = print_data.get("ams", {})
            if ams_info:
                tray_now = str(ams_info.get("tray_now", "255"))
                ams_list = ams_info.get("ams", [])
                if tray_now not in ("254", "255") and ams_list:
                    try:
                        tray_idx = int(tray_now) % 4
                        unit_idx = int(tray_now) // 4
                        tray = ams_list[unit_idx].get("tray", [])[tray_idx]
                        ams_cache[name] = {
                            "filament_type":    tray.get("tray_type"),
                            "filament_brand":   tray.get("tray_sub_brands"),
                            "filament_color":   tray.get("tray_color"),
                            "filament_remain":  tray.get("remain"),
                        }
                    except (IndexError, KeyError, ValueError):
                        pass
                elif tray_now == "254":  # External spool (vir_slot id=254)
                    vt_list = [s for s in print_data.get("vir_slot", []) if s.get("id") == "254"]
                    if vt_list:
                        vt = vt_list[0]
                        ams_cache[name] = {
                            "filament_type":   vt.get("tray_type"),
                            "filament_brand":  vt.get("tray_sub_brands"),
                            "filament_color":  vt.get("tray_color"),
                            "filament_remain": vt.get("remain"),
                        }

            # Nozzle diameter available directly from payload (e.g. "0.4")
            nozzle_diam_raw = print_data.get("nozzle_diameter")
            if nozzle_diam_raw is not None:
                try:
                    ams_cache.setdefault(name, {})["nozzle_diameter"] = float(nozzle_diam_raw)
                except ValueError:
                    pass

            data = {
                "state":          state,
                "active":         active,
                "nozzle_temp":    print_data.get("nozzle_temper"),
                "nozzle_target":  print_data.get("nozzle_target_temper"),
                "bed_temp":       print_data.get("bed_temper"),
                "bed_target":     print_data.get("bed_target_temper"),
                "progress":       print_data.get("mc_percent"),
                "remaining":      print_data.get("mc_remaining_time"),
                "filename":       print_data.get("subtask_name"),
                "layer":          print_data.get("layer_num"),
                "total_layers":   print_data.get("total_layer_num"),
                # Filament & nozzle from cache (persists across messages without AMS data)
                "filament_type":   ams_cache.get(name, {}).get("filament_type"),
                "filament_brand":  ams_cache.get(name, {}).get("filament_brand"),
                "filament_color":  ams_cache.get(name, {}).get("filament_color"),
                "filament_remain": ams_cache.get(name, {}).get("filament_remain"),
                "nozzle_diameter": ams_cache.get(name, {}).get("nozzle_diameter"),
                # layer_height not available from Bambu MQTT
            }

            if state.upper() == 'PRINTING' and data.get('progress') is not None:
                last_print_progress[name] = data['progress']
            
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

                # Detect transition from PRINTING to IDLE/FINISH/PAUSED and log print_stopped_manual event
                prev_s = prev.get("state", "").upper()
                curr_s = state.upper()
                if prev_s == "PRINTING" and curr_s in ("IDLE", "FINISH", "PAUSED", "PAUSE", "UNKNOWN"):
                    stopped_at = last_print_progress.pop(name, None)
                    if stopped_at is not None:
                        log_print_stop_event(conn, name, stopped_at)

                last_db_write[name] = now
            log.info(f"  {name}: {state} {data.get('progress', '')}%")
        except Exception:
            # Ensure any unexpected errors in the MQTT handler are logged and do not crash the client loop
            log.exception(f"  {name}: Error in MQTT message handler")

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
            job          = raw["job"]
            active       = job is not None and job.get("state") == "PRINTING"
            display_name = (job or {}).get("file", {}).get("display_name", "")
            fname_meta   = parse_filename_meta(display_name)
            data = {
                "state":          p.get("state"),
                "active":         active,
                "nozzle_temp":    p.get("temp_nozzle"),
                "nozzle_target":  p.get("target_nozzle"),
                "bed_temp":       p.get("temp_bed"),
                "bed_target":     p.get("target_bed"),
                "progress":       j.get("progress"),
                "remaining":      j.get("time_remaining"),
                "filename":       display_name,
                # Prefer API metadata; fall back to filename parsing
                "filament_type":  (
                    (job or {}).get("file", {}).get("meta", {}).get("filament_type")
                    or fname_meta.get("filament_type")
                ),
                "layer_height":   fname_meta.get("layer_height"),
                "nozzle_diameter": fname_meta.get("nozzle_diameter"),
            }

            # Detect manual stop event for Prusa printers
            if (data.get('state') or '').upper() == 'PRINTING' and data.get('progress') is not None:
                last_print_progress[name] = data['progress']

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
            # Detect transition from PRINTING to IDLE/FINISH/PAUSED and log print_stopped_manual event
            prev_s = (prev_state.get(name) or {}).get("state", "").upper()
            curr_s = (data.get("state") or "").upper()
            if prev_s == "PRINTING" and curr_s in ("IDLE", "FINISH", "PAUSED", "PAUSE", "UNKNOWN"):
                stopped_at = last_print_progress.pop(name, None)
                if stopped_at is not None:
                    log_print_stop_event(conn, name, stopped_at)
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
    