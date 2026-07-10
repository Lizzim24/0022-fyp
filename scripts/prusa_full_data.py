"""
Prusa Core One — Full data collection script
Uses HTTP Digest auth (/api/v1/* modern API) to fetch more data than PrusaLinkPy.

Credentials live in config.py (not committed to git).
Copy config.example.py to config.py and fill in real values.
"""

import requests
from requests.auth import HTTPDigestAuth
import json
from datetime import datetime
from config import PRINTERS

TIMEOUT = 5  # request timeout in seconds


# ── Fetch all data from a single printer ─────────────────────
def fetch_all(cfg):
    base = f"http://{cfg['ip']}"
    auth = HTTPDigestAuth(cfg["user"], cfg["password"])
    legacy_headers = {"X-Api-Key": cfg["password"]}  # legacy API uses X-Api-Key header

    data = {"name": cfg["name"], "ip": cfg["ip"], "fetched_at": datetime.now().isoformat()}

    def get(url, use_digest=True):
        try:
            if use_digest:
                r = requests.get(url, auth=auth, timeout=TIMEOUT)
            else:
                r = requests.get(url, headers=legacy_headers, timeout=TIMEOUT)
            if r.status_code == 200:
                return r.json()
            elif r.status_code == 204:
                return None  # normal empty response (no job / no transfer)
            else:
                return {"_error": r.status_code}
        except Exception as e:
            return {"_error": str(e)}

    # Firmware & version info
    data["version"] = get(f"{base}/api/version", use_digest=False)

    # Static printer info (serial, nozzle diameter, MMU, hostname, etc.)
    data["info"] = get(f"{base}/api/v1/info")

    # Live status (temperatures, axis position, speed, fan RPM, connection)
    data["status"] = get(f"{base}/api/v1/status")

    # Current job (filename, progress, time remaining, time elapsed)
    data["job"] = get(f"{base}/api/v1/job")

    # Storage devices (local/USB/SD, space usage)
    data["storage"] = get(f"{base}/api/v1/storage")

    # File transfer status
    data["transfer"] = get(f"{base}/api/v1/transfer")

    # Camera list
    data["cameras"] = get(f"{base}/api/v1/cameras")

    # Update info
    data["update_info"] = get(f"{base}/api/v1/update/prusalink")

    # File list (local storage root)
    data["files_local"] = get(f"{base}/api/v1/files/local/")

    return data


# ── Print summary to console ──────────────────────────────────
def print_summary(d):
    sep = "═" * 55
    print(f"\n{sep}")
    print(f"  {d['name']}  ({d['ip']})")
    print(sep)

    # Version
    v = d.get("version") or {}
    print(f"  Firmware    : {v.get('firmware', v.get('printer', 'N/A'))}")
    print(f"  PrusaLink   : {v.get('version', 'N/A')}")

    # Static info
    info = d.get("info") or {}
    if not info.get("_error"):
        print(f"  Serial      : {info.get('serial', 'N/A')}")
        print(f"  Nozzle      : {info.get('nozzle_diameter', 'N/A')} mm")
        print(f"  MMU         : {'Yes' if info.get('mmu') else 'No'}")
        print(f"  Farm mode   : {'Yes' if info.get('farm_mode') else 'No'}")

    # Live status
    status = d.get("status") or {}
    if not status.get("_error"):
        p = status.get("printer", {})
        print(f"\n  ── Live status ──")
        print(f"  State       : {p.get('state', 'N/A')}")
        print(f"  Nozzle temp : {p.get('temp_nozzle', 'N/A')} / {p.get('target_nozzle', 'N/A')} °C  (current/target)")
        print(f"  Bed temp    : {p.get('temp_bed', 'N/A')} / {p.get('target_bed', 'N/A')} °C")
        print(f"  Z axis      : {p.get('axis_z', 'N/A')} mm")
        print(f"  Speed       : {p.get('speed', 'N/A')} %")
        print(f"  Flow        : {p.get('flow', 'N/A')} %")
        print(f"  Hotend fan  : {p.get('fan_hotend', 'N/A')} RPM")
        print(f"  Print fan   : {p.get('fan_print', 'N/A')} RPM")
        sc = p.get("status_connect", {})
        print(f"  Connect     : {'OK' if sc.get('ok') else 'FAIL'} {sc.get('message', '')}")

    # Current job
    job = d.get("job")
    if job and not (isinstance(job, dict) and job.get("_error")):
        print(f"\n  ── Current job ──")
        print(f"  Filename    : {job.get('file', {}).get('display_name') or job.get('file', {}).get('name', 'serial print')}")
        print(f"  State       : {job.get('state', 'N/A')}")
        print(f"  Progress    : {job.get('progress', 0):.1f} %")
        elapsed   = job.get("time_printing", 0)
        remaining = job.get("time_remaining")
        print(f"  Elapsed     : {elapsed//3600}h {(elapsed%3600)//60}m")
        if remaining:
            print(f"  Remaining   : {remaining//3600}h {(remaining%3600)//60}m")
        meta = job.get("file", {}).get("meta", {})
        if meta:
            print(f"  Layer height: {meta.get('layer_height', 'N/A')} mm")
            print(f"  Filament    : {meta.get('filament_type', 'N/A')}")
    else:
        print(f"\n  Job         : idle")

    # Storage
    storage = d.get("storage")
    if storage and isinstance(storage, list):
        print(f"\n  ── Storage ──")
        for s in storage:
            free  = s.get("free_space", 0)
            total = s.get("total_space", 0)
            pct   = (1 - free / total) * 100 if total else 0
            print(f"  {s.get('type','?'):6s} {s.get('path','')}: "
                  f"{free//1024//1024} MB free / {total//1024//1024} MB total  ({pct:.0f}% used)")


# ── Main ──────────────────────────────────────────────────────
if __name__ == "__main__":
    print(f"\n Prusa full data collection  —  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    all_data = []
    for cfg in PRINTERS:
        print(f"\n  Reading {cfg['name']} ({cfg['ip']}) ...")
        result = fetch_all(cfg)
        all_data.append(result)
        print_summary(result)

    # Save full raw JSON
    output_file = f"prusa_data_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(all_data, f, ensure_ascii=False, indent=2)
    print(f"\n Raw data saved to: {output_file}\n")
