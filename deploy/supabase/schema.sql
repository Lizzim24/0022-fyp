-- ============================================================================
-- Print Lab Digital Twin — Supabase / PostgreSQL schema (complete)
-- Regenerated from the live database (project droqokuoocckdnqashpi), Aug 2026.
--
-- Run the whole file in Supabase -> SQL Editor. It is idempotent
-- (IF NOT EXISTS / CREATE OR REPLACE), so it is safe to re-run.
--
-- Contents
--   1. Extensions
--   2. Tables            machines, machine_status_logs, machine_events,
--                        machine_daily_summary, alert_config, alert_log
--   3. Indexes
--   4. updated_at trigger
--   5. Materialised views machine_hourly_usage, filament_daily_usage
--   6. RPC functions     (read API used by the front end + the alerting job)
--   7. Row-Level Security (public read on the 4 data tables; alert tables locked)
--   8. Scheduled jobs    (pg_cron: health check + matview refresh)
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1. Extensions
-- ────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";   -- uuid_generate_v4()
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_net;        -- net.http_post() for Slack alerts
CREATE EXTENSION IF NOT EXISTS pg_cron;       -- scheduled jobs (see section 8)
-- On Supabase, pg_net and pg_cron can also be toggled under
-- Database -> Extensions. supabase_vault / pg_stat_statements are managed.


-- ────────────────────────────────────────────────────────────────────────────
-- 2. Tables
-- ────────────────────────────────────────────────────────────────────────────

-- 2.1 machines — static, one row per printer (13 rows)
CREATE TABLE IF NOT EXISTS machines (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                TEXT UNIQUE NOT NULL,          -- e.g. 'CoreOne-4', 'H2D-02'
    hostname            TEXT,
    serial              TEXT,
    machine_type        TEXT DEFAULT 'Prusa Core One', -- e.g. 'Bambu X1C', 'Bambu H2D'
    nozzle_diameter     NUMERIC(4,2),
    mmu                 BOOLEAN DEFAULT FALSE,
    min_extrusion_temp  INTEGER,
    farm_mode           BOOLEAN DEFAULT FALSE,
    ip_address          TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    lab                 TEXT DEFAULT 'CELab'           -- 'CELab' or 'LFLab'
);

-- 2.2 machine_status_logs — high-frequency telemetry (~30 s per row, 1.6M+ rows)
CREATE TABLE IF NOT EXISTS machine_status_logs (
    id              BIGSERIAL PRIMARY KEY,
    machine_id      UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- State
    state           TEXT,             -- IDLE, PRINTING, PAUSED, FINISHED, ERROR, ...
    online          BOOLEAN,
    active          BOOLEAN,          -- true while a job is running
    -- Temperatures
    temp_nozzle     NUMERIC(6,2),
    target_nozzle   NUMERIC(6,2),
    temp_bed        NUMERIC(6,2),
    target_bed      NUMERIC(6,2),
    -- Motion
    axis_z          NUMERIC(8,3),
    -- Speed / flow
    speed           INTEGER,          -- print speed %
    flow            INTEGER,          -- flow rate %
    -- Fans
    fan_hotend_rpm  INTEGER,
    fan_print_rpm   INTEGER,
    -- Job snapshot (denormalised)
    job_progress    NUMERIC(5,2),     -- 0.00 – 100.00
    job_remaining   INTEGER,          -- vendor-native remaining time: Bambu minutes, Prusa seconds
    -- Filament / job detail (populated where the vendor exposes it)
    filament_type   TEXT,             -- PLA, PETG, ...
    layer_height    NUMERIC(4,3),
    nozzle_diameter NUMERIC(3,2),
    filament_brand  TEXT,
    filament_color  CHAR(8),          -- hex, e.g. '#FF6600'
    filament_remain SMALLINT          -- % remaining, where reported
);

CREATE INDEX IF NOT EXISTS idx_status_logs_machine_time
    ON machine_status_logs (machine_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_status_logs_timestamp
    ON machine_status_logs (timestamp DESC);

-- 2.3 machine_events — inferred events (starts, completions, failures, offline …)
CREATE TABLE IF NOT EXISTS machine_events (
    id               BIGSERIAL PRIMARY KEY,
    machine_id       UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    event_type       TEXT NOT NULL,
    -- machine_online / machine_offline / state_changed
    -- print_started / print_paused / print_resumed / print_completed
    -- print_stopped / print_stopped_manual / possible_failure
    -- temperature_warning / storage_unavailable
    severity         TEXT DEFAULT 'info',    -- info / warning / error
    start_time       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    end_time         TIMESTAMPTZ,
    duration_seconds INTEGER,
    description      TEXT,
    metadata         JSONB,                  -- filename, temps, etc.
    progress_at_stop NUMERIC(5,2)            -- job_progress when a print stopped/failed
);

CREATE INDEX IF NOT EXISTS idx_events_machine_time
    ON machine_events (machine_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_events_type
    ON machine_events (event_type, start_time DESC);

-- 2.4 machine_daily_summary — one aggregated row per machine per day
CREATE TABLE IF NOT EXISTS machine_daily_summary (
    id                          BIGSERIAL PRIMARY KEY,
    machine_id                  UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    date                        DATE NOT NULL,
    total_online_minutes        INTEGER DEFAULT 0,
    total_active_minutes        INTEGER DEFAULT 0,   -- state = PRINTING
    total_idle_minutes          INTEGER DEFAULT 0,
    utilisation_rate            NUMERIC(5,4),        -- active / online (0.0000–1.0000)
    number_of_jobs              INTEGER DEFAULT 0,
    number_of_pauses            INTEGER DEFAULT 0,
    number_of_possible_failures INTEGER DEFAULT 0,
    number_of_offline_events    INTEGER DEFAULT 0,
    avg_nozzle_temp             NUMERIC(6,2),
    avg_bed_temp                NUMERIC(6,2),
    max_nozzle_temp             NUMERIC(6,2),
    total_print_seconds         INTEGER DEFAULT 0,
    UNIQUE (machine_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_summary_machine_date
    ON machine_daily_summary (machine_id, date DESC);

-- 2.5 alert_config — key/value settings for the alerting job (e.g. slack_webhook_url)
CREATE TABLE IF NOT EXISTS alert_config (
    key    TEXT PRIMARY KEY,
    value  TEXT
);

-- 2.6 alert_log — record of alerts sent, used for de-duplication / cooldown
CREATE TABLE IF NOT EXISTS alert_log (
    id            BIGSERIAL PRIMARY KEY,
    machine_name  TEXT NOT NULL,
    alert_type    TEXT NOT NULL,          -- e.g. 'stale'
    sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ────────────────────────────────────────────────────────────────────────────
-- 4. updated_at trigger (keeps machines.updated_at fresh)
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_machines_updated_at ON machines;
CREATE TRIGGER trg_machines_updated_at
    BEFORE UPDATE ON machines
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- 5. Materialised views (refreshed every 30 min by pg_cron — see section 8)
--    They pre-aggregate the huge status_logs table so the dashboard reads stay
--    cheap. Each has a UNIQUE index so it can be REFRESHed CONCURRENTLY.
-- ────────────────────────────────────────────────────────────────────────────

-- 5.1 machine_hourly_usage — per machine, per hour: sample counts + remaining-time
CREATE MATERIALIZED VIEW IF NOT EXISTS machine_hourly_usage AS
  SELECT machine_id,
         date_trunc('hour', "timestamp")                      AS hour_start,
         count(*)                                             AS total,
         count(*) FILTER (WHERE active)                       AS active_count,
         COALESCE(sum(job_remaining) FILTER (WHERE job_remaining > 0), 0::bigint) AS rem_sum,
         count(*) FILTER (WHERE job_remaining > 0)            AS rem_cnt
  FROM machine_status_logs
  GROUP BY machine_id, date_trunc('hour', "timestamp");

CREATE UNIQUE INDEX IF NOT EXISTS idx_mhu_machine_hour
    ON machine_hourly_usage (machine_id, hour_start);

-- 5.2 filament_daily_usage — per day, per (filament type, colour): printing samples
CREATE MATERIALIZED VIEW IF NOT EXISTS filament_daily_usage AS
  SELECT (date_trunc('day', "timestamp"))::date AS day,
         upper(COALESCE(NULLIF(TRIM(BOTH FROM filament_type), ''), 'UNKNOWN'))                       AS filament_type,
         upper(substr(regexp_replace(COALESCE(filament_color, '')::text, '[^0-9a-fA-F]', '', 'g'), 1, 6)) AS color_hex,
         count(*) FILTER (WHERE state = 'PRINTING') AS printing_cnt,
         count(*)                                   AS all_cnt
  FROM machine_status_logs
  WHERE filament_type IS NOT NULL
  GROUP BY 1, 2, 3;

CREATE UNIQUE INDEX IF NOT EXISTS idx_fdu
    ON filament_daily_usage (day, filament_type, color_hex);


-- ────────────────────────────────────────────────────────────────────────────
-- 6. RPC functions (called from the front end via the anon key, except
--    notify_stale_agents which is SECURITY DEFINER and run only by pg_cron)
-- ────────────────────────────────────────────────────────────────────────────

-- 6.1 latest_status_per_machine() — newest row per machine (drives Live view)
--     Uses a LATERAL per-machine index lookup (13 fast seeks) instead of a
--     DISTINCT ON scan over the whole million-row table.
CREATE OR REPLACE FUNCTION latest_status_per_machine()
RETURNS TABLE(machine_id uuid, "timestamp" timestamptz, state text, online boolean,
              job_progress numeric, job_remaining integer, filament_type text,
              filament_brand text, filament_color text, filament_remain smallint,
              temp_nozzle numeric, nozzle_diameter numeric,
              machine_name text, machine_lab text, machine_type text)
LANGUAGE sql STABLE SET search_path TO 'public'
AS $$
  SELECT
  l.machine_id,
  l."timestamp",
  l.state,
  l.online,
  l.job_progress,
  CASE
    WHEN l.job_remaining IS NULL THEN NULL
    WHEN m.machine_type ILIKE 'Prusa%'
      THEN ROUND(l.job_remaining / 60.0)::integer
    ELSE l.job_remaining
  END AS job_remaining,
  l.filament_type,
  l.filament_brand,
  l.filament_color,
  l.filament_remain,
  l.temp_nozzle,
  l.nozzle_diameter,
  m.name,
  m.lab,
  m.machine_type
FROM machines m
CROSS JOIN LATERAL (
  SELECT *
  FROM machine_status_logs s
  WHERE s.machine_id = m.id
  ORDER BY s."timestamp" DESC
  LIMIT 1
) l;
$$;

-- 6.2 deduped_daily_jobs(since) — trustworthy job count per machine per day.
--     Counts reliable TERMINAL events, not the (historically inflated) starts.
CREATE OR REPLACE FUNCTION deduped_daily_jobs(since timestamptz)
RETURNS TABLE(day date, machine_id uuid, jobs bigint)
LANGUAGE sql STABLE SET search_path TO 'public'
AS $$
  SELECT start_time::date AS day, machine_id, count(*)::bigint AS jobs
  FROM machine_events
  WHERE event_type IN ('print_completed', 'print_stopped_manual',
                       'print_stopped', 'possible_failure')
    AND start_time >= since
  GROUP BY start_time::date, machine_id;
$$;

-- 6.3 usage_by_weekday_hour(since, machine_filter) — heatmap + ETA remaining stats
CREATE OR REPLACE FUNCTION usage_by_weekday_hour(since timestamptz, machine_filter uuid DEFAULT NULL)
RETURNS TABLE(weekday integer, hour integer, total bigint, active_count bigint,
              rem_sum bigint, rem_cnt bigint)
LANGUAGE sql STABLE SET search_path TO 'public'
AS $$
  SELECT
  extract(dow  FROM u.hour_start AT TIME ZONE 'Europe/London')::int AS weekday,
  extract(hour FROM u.hour_start AT TIME ZONE 'Europe/London')::int AS hour,
  sum(u.total)::bigint,
  sum(u.active_count)::bigint,
  ROUND(
    SUM(
      CASE
        WHEN m.machine_type ILIKE 'Prusa%'
          THEN u.rem_sum / 60.0
        ELSE u.rem_sum::numeric
      END
    )
  )::bigint AS rem_sum,
  sum(u.rem_cnt)::bigint
FROM machine_hourly_usage u
JOIN machines m ON m.id = u.machine_id
WHERE u.hour_start >= date_trunc('hour', since)
  AND (machine_filter IS NULL OR u.machine_id = machine_filter)
GROUP BY 1, 2;
$$;

-- 6.4 usage_by_machine_weekday_hour(since) — same, broken out per machine
CREATE OR REPLACE FUNCTION usage_by_machine_weekday_hour(since timestamptz)
RETURNS TABLE(machine_id uuid, weekday integer, hour integer, total bigint, active_count bigint)
LANGUAGE sql STABLE SET search_path TO 'public'
AS $$
  SELECT machine_id,
         extract(dow  FROM hour_start AT TIME ZONE 'Europe/London')::int,
         extract(hour FROM hour_start AT TIME ZONE 'Europe/London')::int,
         sum(total)::bigint,
         sum(active_count)::bigint
  FROM machine_hourly_usage
  WHERE hour_start >= date_trunc('hour', since)
  GROUP BY 1, 2, 3;
$$;

-- 6.5 filament_type_counts(since) — filament mix for the Analysis donut
CREATE OR REPLACE FUNCTION filament_type_counts(since date)
RETURNS TABLE(filament_type text, color_hex text, printing_cnt bigint)
LANGUAGE sql STABLE SET search_path TO 'public'
AS $$
  SELECT filament_type, nullif(color_hex, '') AS color_hex, sum(printing_cnt)::bigint
  FROM filament_daily_usage
  WHERE day >= since
  GROUP BY 1, 2
  HAVING sum(printing_cnt) > 0;
$$;

-- 6.6 machine_card_stats(machine_id) — totals for a machine's detail card
CREATE OR REPLACE FUNCTION machine_card_stats(p_machine_id uuid)
RETURNS TABLE(total_print_seconds bigint, top_filament_type text, longest_streak_seconds numeric)
LANGUAGE sql STABLE SET search_path TO 'public'
AS $$
  WITH total AS (
    SELECT coalesce(sum(total_print_seconds), 0)::bigint AS total_print_seconds
    FROM machine_daily_summary WHERE machine_id = p_machine_id
  ),
  top_fil AS (
    SELECT filament_type FROM machine_status_logs
    WHERE machine_id = p_machine_id AND filament_type IS NOT NULL
    GROUP BY filament_type ORDER BY count(*) DESC LIMIT 1
  ),
  with_lag AS (
    SELECT "timestamp", state,
           lag(state) OVER (ORDER BY "timestamp") AS prev_state
    FROM machine_status_logs WHERE machine_id = p_machine_id
  ),
  islands AS (
    SELECT "timestamp", state,
           sum(CASE WHEN state = 'PRINTING' AND prev_state IS DISTINCT FROM 'PRINTING'
                    THEN 1 ELSE 0 END) OVER (ORDER BY "timestamp") AS grp
    FROM with_lag
  ),
  streaks AS (
    SELECT grp, min("timestamp") AS start_t, max("timestamp") AS end_t
    FROM islands WHERE state = 'PRINTING' GROUP BY grp
  )
  SELECT t.total_print_seconds,
         (SELECT filament_type FROM top_fil),
         (SELECT coalesce(max(extract(epoch FROM (end_t - start_t))), 0) FROM streaks)
  FROM total t;
$$;

-- 6.7 notify_stale_agents() — every 10 min, Slack-alert machines that went silent.
--     SECURITY DEFINER so the cron role may read alert_config and POST via pg_net.
CREATE OR REPLACE FUNCTION notify_stale_agents()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  webhook text; stale_list text; n int;
BEGIN
  SELECT value INTO webhook FROM alert_config WHERE key = 'slack_webhook_url';
  IF webhook IS NULL OR webhook = '' THEN RETURN; END IF;

  -- Machines silent > 15 min but seen within 25 h (ignore long-powered-off ones),
  -- and not already alerted in the last 6 h (cooldown). The 26-hour window keeps
  -- the scan on an index instead of the whole (million-row) status_logs table.
  WITH recent AS (
    SELECT machine_id, max("timestamp") AS last_seen
    FROM machine_status_logs
    WHERE "timestamp" > now() - interval '26 hours'
    GROUP BY machine_id
  ),
  stale AS (
    SELECT m.name, r.last_seen
    FROM machines m JOIN recent r ON r.machine_id = m.id
    WHERE r.last_seen < now() - interval '15 minutes'
      AND r.last_seen > now() - interval '25 hours'
  )
  SELECT string_agg(s.name || ' (last seen ' ||
           to_char(s.last_seen AT TIME ZONE 'Europe/London', 'DD Mon HH24:MI') || ')', E'\n• '),
         count(*)
    INTO stale_list, n
  FROM stale s
  WHERE NOT EXISTS (
    SELECT 1 FROM alert_log a
    WHERE a.machine_name = s.name AND a.alert_type = 'stale'
      AND a.sent_at > now() - interval '6 hours');

  IF n IS NULL OR n = 0 THEN RETURN; END IF;

  PERFORM net.http_post(
    url := webhook,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('text',
      ':warning: *Print Lab Digital Twin* — ' || n || ' machine(s) stopped reporting:'
      || E'\n• ' || stale_list
      || E'\n\nIf several machines from one lab appear together, check that lab''s Pi agent.'));

  WITH recent AS (
    SELECT machine_id, max("timestamp") AS last_seen
    FROM machine_status_logs
    WHERE "timestamp" > now() - interval '26 hours'
    GROUP BY machine_id
  )
  INSERT INTO alert_log (machine_name, alert_type)
  SELECT m.name, 'stale'
  FROM machines m JOIN recent r ON r.machine_id = m.id
  WHERE r.last_seen < now() - interval '15 minutes'
    AND r.last_seen > now() - interval '25 hours'
    AND NOT EXISTS (
      SELECT 1 FROM alert_log a
      WHERE a.machine_name = m.name AND a.alert_type = 'stale'
        AND a.sent_at > now() - interval '6 hours');
END;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 7. Row-Level Security
--    The public web app uses the anon key: it may read the four data tables and
--    nothing else. alert_config / alert_log have RLS on but no anon policy, so
--    they are unreadable to the public (only service_role / SECURITY DEFINER).
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE machines              ENABLE ROW LEVEL SECURITY;
ALTER TABLE machine_status_logs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE machine_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE machine_daily_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_config          ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_log             ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public read" ON machines;
DROP POLICY IF EXISTS "public read" ON machine_status_logs;
DROP POLICY IF EXISTS "public read" ON machine_events;
DROP POLICY IF EXISTS "public read" ON machine_daily_summary;

CREATE POLICY "public read" ON machines              FOR SELECT TO anon USING (true);
CREATE POLICY "public read" ON machine_status_logs   FOR SELECT TO anon USING (true);
CREATE POLICY "public read" ON machine_events        FOR SELECT TO anon USING (true);
CREATE POLICY "public read" ON machine_daily_summary FOR SELECT TO anon USING (true);

-- Read RPCs are callable by the public; the alerting job is not.
GRANT EXECUTE ON FUNCTION latest_status_per_machine()                 TO anon, authenticated;
GRANT EXECUTE ON FUNCTION deduped_daily_jobs(timestamptz)             TO anon, authenticated;
GRANT EXECUTE ON FUNCTION usage_by_weekday_hour(timestamptz, uuid)    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION usage_by_machine_weekday_hour(timestamptz)  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION filament_type_counts(date)                  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION machine_card_stats(uuid)                    TO anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 8. Scheduled jobs (pg_cron). Re-running is safe: unschedule-if-exists first.
-- ────────────────────────────────────────────────────────────────────────────
SELECT cron.unschedule('agent-health-check')     WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='agent-health-check');
SELECT cron.unschedule('refresh-hourly-usage')   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='refresh-hourly-usage');
SELECT cron.unschedule('refresh-filament-usage') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='refresh-filament-usage');

SELECT cron.schedule('agent-health-check',     '*/10 * * * *', $$SELECT notify_stale_agents()$$);
SELECT cron.schedule('refresh-hourly-usage',   '*/30 * * * *', $$REFRESH MATERIALIZED VIEW CONCURRENTLY public.machine_hourly_usage$$);
SELECT cron.schedule('refresh-filament-usage', '*/30 * * * *', $$REFRESH MATERIALIZED VIEW CONCURRENTLY public.filament_daily_usage$$);

-- To enable Slack alerts, store the webhook once (not committed to git):
--   INSERT INTO alert_config (key, value)
--   VALUES ('slack_webhook_url', 'https://hooks.slack.com/services/…')
--   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- ============================================================================
-- End of schema
-- ============================================================================
