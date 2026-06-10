-- ============================================================
-- Prusa Digital Twin — Supabase Schema
-- Run this entire file in Supabase → SQL Editor
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ────────────────────────────────────────────────────────────
-- 1. machines: static printer info
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS machines (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                TEXT UNIQUE NOT NULL,       -- e.g. 'CoreOne-4'
    hostname            TEXT,                        -- e.g. 'CELab-CoreOne-4'
    serial              TEXT,
    machine_type        TEXT DEFAULT 'Prusa Core One',
    nozzle_diameter     NUMERIC(4,2),
    mmu                 BOOLEAN DEFAULT FALSE,
    min_extrusion_temp  INTEGER,
    farm_mode           BOOLEAN DEFAULT FALSE,
    ip_address          TEXT,
    lab                 TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────
-- 2. machine_status_logs: high-frequency live status (~30s per row)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS machine_status_logs (
    id              BIGSERIAL PRIMARY KEY,
    machine_id      UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- State
    state           TEXT,           -- IDLE, PRINTING, PAUSED, FINISHED, ERROR, etc.
    online          BOOLEAN,
    active          BOOLEAN,        -- true if a job is running
    -- Temperatures
    temp_nozzle     NUMERIC(6,2),
    target_nozzle   NUMERIC(6,2),
    temp_bed        NUMERIC(6,2),
    target_bed      NUMERIC(6,2),
    -- Motion
    axis_z          NUMERIC(8,3),
    -- Speed parameters
    speed           INTEGER,        -- print speed %
    flow            INTEGER,        -- flow rate %
    -- Fans
    fan_hotend_rpm  INTEGER,
    fan_print_rpm   INTEGER,
    -- Job snapshot (denormalised for easy querying)
    job_progress    NUMERIC(5,2),   -- 0.00 ~ 100.00
    job_remaining   INTEGER         -- seconds remaining
);

-- Index for time-range queries
CREATE INDEX IF NOT EXISTS idx_status_logs_machine_time
    ON machine_status_logs (machine_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_status_logs_timestamp
    ON machine_status_logs (timestamp DESC);

-- ────────────────────────────────────────────────────────────
-- 3. machine_events: event log (state changes, offline, errors, etc.)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS machine_events (
    id               BIGSERIAL PRIMARY KEY,
    machine_id       UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    event_type       TEXT NOT NULL,
    -- Event types (not enforced, extensible):
    -- machine_online / machine_offline
    -- state_changed
    -- print_started / print_paused / print_resumed / print_completed / print_stopped
    -- temperature_warning
    -- possible_failure
    -- storage_unavailable
    severity         TEXT DEFAULT 'info',   -- info / warning / error
    start_time       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    end_time         TIMESTAMPTZ,           -- filled for duration events
    duration_seconds INTEGER,
    description      TEXT,
    metadata         JSONB                  -- arbitrary extra data (filename, temp values, etc.)
);

CREATE INDEX IF NOT EXISTS idx_events_machine_time
    ON machine_events (machine_id, start_time DESC);

CREATE INDEX IF NOT EXISTS idx_events_type
    ON machine_events (event_type, start_time DESC);

-- ────────────────────────────────────────────────────────────
-- 4. machine_daily_summary: daily aggregated stats (low-frequency)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS machine_daily_summary (
    id                          BIGSERIAL PRIMARY KEY,
    machine_id                  UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    date                        DATE NOT NULL,
    -- Time stats (minutes)
    total_online_minutes        INTEGER DEFAULT 0,
    total_active_minutes        INTEGER DEFAULT 0,   -- state = PRINTING
    total_idle_minutes          INTEGER DEFAULT 0,   -- online but not printing
    -- Utilisation
    utilisation_rate            NUMERIC(5,4),        -- active / online (0.0000~1.0000)
    -- Job counts
    number_of_jobs              INTEGER DEFAULT 0,
    number_of_pauses            INTEGER DEFAULT 0,
    number_of_possible_failures INTEGER DEFAULT 0,
    number_of_offline_events    INTEGER DEFAULT 0,
    -- Temperature averages (for trend analysis)
    avg_nozzle_temp             NUMERIC(6,2),
    avg_bed_temp                NUMERIC(6,2),
    max_nozzle_temp             NUMERIC(6,2),
    -- Job detail
    total_print_seconds         INTEGER DEFAULT 0,
    UNIQUE (machine_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_summary_machine_date
    ON machine_daily_summary (machine_id, date DESC);

-- ────────────────────────────────────────────────────────────
-- Helper: auto-update machines.updated_at on row change
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_machines_updated_at
    BEFORE UPDATE ON machines
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
