-- Requests and warnings retain their legacy contract; UPS owns only the new tables.
CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY, ts_ms INTEGER NOT NULL, record TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts_ms);
CREATE TABLE IF NOT EXISTS warnings(message TEXT PRIMARY KEY);

-- Raw readings: seven days, deleted in bounded jobs only after rollup commit.
CREATE TABLE ups_samples (
    ts_ms INTEGER PRIMARY KEY CHECK(ts_ms >= 0),
    status TEXT,
    charge_percent REAL,
    runtime_s INTEGER,
    load_w REAL,
    input_v REAL,
    output_v REAL,
    battery_v REAL,
    test_result TEXT,
    energy_mwh INTEGER NOT NULL CHECK(energy_mwh >= 0),
    coverage_ms INTEGER NOT NULL CHECK(coverage_ms BETWEEN 0 AND 30000)
) STRICT;
-- Hourly summaries and events are retained indefinitely.
CREATE TABLE ups_rollup_hourly (
    ts_ms INTEGER PRIMARY KEY CHECK(ts_ms >= 0 AND ts_ms % 3600000 = 0),
    sample_count INTEGER NOT NULL CHECK(sample_count > 0),
    charge_min REAL, charge_avg REAL, charge_max REAL,
    load_min REAL, load_avg REAL, load_max REAL,
    input_min REAL, input_avg REAL, input_max REAL,
    runtime_min_s INTEGER,
    energy_mwh INTEGER NOT NULL CHECK(energy_mwh >= 0),
    coverage_ms INTEGER NOT NULL CHECK(coverage_ms >= 0),
    on_battery_s REAL NOT NULL CHECK(on_battery_s >= 0)
) STRICT;
CREATE TABLE ups_events (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('on_battery','low_battery','replace_battery','comms_lost','self_test')),
    started_ms INTEGER NOT NULL CHECK(started_ms >= 0),
    ended_ms INTEGER CHECK(ended_ms >= started_ms),
    min_charge_percent REAL,
    min_runtime_s INTEGER,
    detail TEXT,
    end_reason TEXT CHECK(end_reason IN ('recovered','restart')),
    CHECK((ended_ms IS NULL) = (end_reason IS NULL))
) STRICT;
CREATE INDEX ups_events_started ON ups_events(started_ms DESC, id DESC);
CREATE UNIQUE INDEX ups_events_open ON ups_events(kind) WHERE ended_ms IS NULL;
-- Settings persist until explicitly replaced or cleared through PUT.
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value INTEGER
) STRICT;
