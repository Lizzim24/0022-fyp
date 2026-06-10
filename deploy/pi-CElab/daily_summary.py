"""
Daily Summary Script (CELab)
Runs automatically at 00:05 each day via cron.
Aggregates machine_status_logs and machine_events into machine_daily_summary.

To set up cron (run `crontab -e` on the Pi and add):
    5 0 * * * /usr/bin/python3 /home/pi/prusa-agent/daily_summary.py >> /home/pi/prusa-agent/daily_summary.log 2>&1

To run manually for a specific date:
    python3 daily_summary.py 2026-05-25
"""
import psycopg2
from datetime import date, timedelta
from config import DB_PARAMS, POLL_INTERVAL


def run(target_date=None):
    if target_date is None:
        target_date = date.today() - timedelta(days=1)  # default: yesterday

    print(f"[{date.today()}] Summary date: {target_date}")
    conn = psycopg2.connect(**DB_PARAMS)

    with conn.cursor() as cur:
        cur.execute("SELECT id, name FROM machines")
        machines = cur.fetchall()

    for machine_id, name in machines:
        print(f"  Processing {name}...")

        with conn.cursor() as cur:
            # Aggregate from status_logs
            cur.execute("""
                SELECT
                    COUNT(*)                                               AS total_logs,
                    SUM(CASE WHEN online          THEN 1 ELSE 0 END)      AS online_logs,
                    SUM(CASE WHEN active          THEN 1 ELSE 0 END)      AS active_logs,
                    SUM(CASE WHEN online AND NOT active THEN 1 ELSE 0 END) AS idle_logs,
                    AVG(CASE WHEN temp_nozzle > 0 THEN temp_nozzle END)   AS avg_nozzle,
                    AVG(CASE WHEN temp_bed    > 0 THEN temp_bed    END)   AS avg_bed,
                    MAX(temp_nozzle)                                       AS max_nozzle
                FROM machine_status_logs
                WHERE machine_id = %s
                  AND timestamp::date = %s
            """, (machine_id, target_date))
            row = cur.fetchone()

        total, online_c, active_c, idle_c, avg_n, avg_b, max_n = row

        if not total:
            print(f"    {name}: No data for this date, skipping.")
            continue

        interval_min = POLL_INTERVAL / 60
        online_min   = int((online_c or 0) * interval_min)
        active_min   = int((active_c or 0) * interval_min)
        idle_min     = int((idle_c   or 0) * interval_min)
        util_rate    = round(active_c / online_c, 4) if online_c else 0

        # Aggregate from events
        with conn.cursor() as cur:
            cur.execute("""
                SELECT
                    COUNT(CASE WHEN event_type = 'print_started'    THEN 1 END) AS jobs,
                    COUNT(CASE WHEN event_type = 'print_paused'     THEN 1 END) AS pauses,
                    COUNT(CASE WHEN event_type = 'possible_failure' THEN 1 END) AS failures,
                    COUNT(CASE WHEN event_type = 'machine_offline'  THEN 1 END) AS offline_events
                FROM machine_events
                WHERE machine_id = %s
                  AND start_time::date = %s
            """, (machine_id, target_date))
            ev = cur.fetchone()

        jobs, pauses, failures, offline_ev = ev or (0, 0, 0, 0)

        # Upsert into machine_daily_summary
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO machine_daily_summary
                  (machine_id, date,
                   total_online_minutes, total_active_minutes, total_idle_minutes,
                   utilisation_rate,
                   number_of_jobs, number_of_pauses,
                   number_of_possible_failures, number_of_offline_events,
                   avg_nozzle_temp, avg_bed_temp, max_nozzle_temp,
                   total_print_seconds)
                VALUES (%s,%s, %s,%s,%s, %s, %s,%s,%s,%s, %s,%s,%s, %s)
                ON CONFLICT (machine_id, date) DO UPDATE SET
                    total_online_minutes        = EXCLUDED.total_online_minutes,
                    total_active_minutes        = EXCLUDED.total_active_minutes,
                    total_idle_minutes          = EXCLUDED.total_idle_minutes,
                    utilisation_rate            = EXCLUDED.utilisation_rate,
                    number_of_jobs              = EXCLUDED.number_of_jobs,
                    number_of_pauses            = EXCLUDED.number_of_pauses,
                    number_of_possible_failures = EXCLUDED.number_of_possible_failures,
                    number_of_offline_events    = EXCLUDED.number_of_offline_events,
                    avg_nozzle_temp             = EXCLUDED.avg_nozzle_temp,
                    avg_bed_temp                = EXCLUDED.avg_bed_temp,
                    max_nozzle_temp             = EXCLUDED.max_nozzle_temp,
                    total_print_seconds         = EXCLUDED.total_print_seconds
            """, (
                machine_id, target_date,
                online_min, active_min, idle_min,
                util_rate,
                jobs, pauses, failures, offline_ev,
                round(avg_n, 2) if avg_n else None,
                round(avg_b, 2) if avg_b else None,
                round(max_n, 2) if max_n else None,
                active_min * 60,
            ))
        conn.commit()

        print(f"    {name}: online={online_min}min, printing={active_min}min, "
              f"utilisation={util_rate*100:.1f}%, jobs={jobs}")

    conn.close()
    print("Summary complete ✓")


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        run(date.fromisoformat(sys.argv[1]))
    else:
        run()
