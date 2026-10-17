-- Network quality (MET-197). Rows carry device_id so other probe hosts can follow.
-- Raw probe bursts: seven days, deleted in bounded jobs only after their hourly rollup commits.
CREATE TABLE net_probe_samples (
    device_id TEXT NOT NULL CHECK(device_id <> ''),
    ts_ms INTEGER NOT NULL CHECK(ts_ms >= 0),
    target TEXT NOT NULL CHECK(target <> ''),
    layer TEXT NOT NULL CHECK(layer IN ('lan','wan','dns','tailnet')),
    address TEXT CHECK(address <> ''),
    sent INTEGER NOT NULL CHECK(sent BETWEEN 1 AND 100),
    received INTEGER NOT NULL CHECK(received BETWEEN 0 AND sent),
    rtt_min_us INTEGER CHECK(rtt_min_us >= 0),
    rtt_avg_us INTEGER CHECK(rtt_avg_us >= rtt_min_us),
    rtt_max_us INTEGER CHECK(rtt_max_us >= rtt_avg_us),
    rtt_mdev_us INTEGER CHECK(rtt_mdev_us >= 0),
    CHECK((received = 0) = (rtt_min_us IS NULL) AND (received = 0) = (rtt_avg_us IS NULL)
        AND (received = 0) = (rtt_max_us IS NULL) AND (received = 0) = (rtt_mdev_us IS NULL)),
    PRIMARY KEY(device_id, ts_ms, target)
) STRICT;
CREATE INDEX net_probe_samples_target ON net_probe_samples(device_id, target, ts_ms);
CREATE INDEX net_probe_samples_ts ON net_probe_samples(ts_ms);
-- Hourly summaries are retained indefinitely. Loss is derived from the sent/received sums.
CREATE TABLE net_probe_rollup_hourly (
    device_id TEXT NOT NULL CHECK(device_id <> ''),
    ts_ms INTEGER NOT NULL CHECK(ts_ms >= 0 AND ts_ms % 3600000 = 0),
    target TEXT NOT NULL CHECK(target <> ''),
    layer TEXT NOT NULL CHECK(layer IN ('lan','wan','dns','tailnet')),
    sample_count INTEGER NOT NULL CHECK(sample_count > 0),
    sent INTEGER NOT NULL CHECK(sent >= sample_count),
    received INTEGER NOT NULL CHECK(received BETWEEN 0 AND sent),
    rtt_min_us INTEGER CHECK(rtt_min_us >= 0),
    -- Weighted by received replies, not by sample.
    rtt_avg_us INTEGER CHECK(rtt_avg_us >= rtt_min_us),
    rtt_max_us INTEGER CHECK(rtt_max_us >= rtt_avg_us),
    -- Nearest-rank p95 of the hour's per-burst mdev values.
    rtt_mdev_p95_us INTEGER CHECK(rtt_mdev_p95_us >= 0),
    CHECK((received = 0) = (rtt_min_us IS NULL) AND (received = 0) = (rtt_avg_us IS NULL)
        AND (received = 0) = (rtt_max_us IS NULL) AND (received = 0) = (rtt_mdev_p95_us IS NULL)),
    PRIMARY KEY(device_id, ts_ms, target)
) STRICT;
-- Throughput tests (written from MET-197 PR 2): 365 days, then bounded deletion by started_ms.
CREATE TABLE net_speed_tests (
    id INTEGER PRIMARY KEY,
    device_id TEXT NOT NULL CHECK(device_id <> ''),
    started_ms INTEGER NOT NULL CHECK(started_ms >= 0),
    ended_ms INTEGER NOT NULL CHECK(ended_ms >= started_ms),
    outcome TEXT NOT NULL CHECK(outcome IN ('ok','failed','timeout')),
    error TEXT CHECK(error <> ''),
    download_bps INTEGER CHECK(download_bps >= 0),
    upload_bps INTEGER CHECK(upload_bps >= 0),
    download_bytes INTEGER NOT NULL CHECK(download_bytes >= 0),
    upload_bytes INTEGER NOT NULL CHECK(upload_bytes >= 0),
    idle_latency_us INTEGER CHECK(idle_latency_us >= 0),
    download_loaded_latency_us INTEGER CHECK(download_loaded_latency_us >= 0),
    upload_loaded_latency_us INTEGER CHECK(upload_loaded_latency_us >= 0),
    colo TEXT CHECK(colo <> ''),
    CHECK(outcome <> 'failed' OR error IS NOT NULL),
    CHECK((outcome = 'ok') = (download_bps IS NOT NULL) AND (outcome = 'ok') = (upload_bps IS NOT NULL))
) STRICT;
CREATE INDEX net_speed_tests_started ON net_speed_tests(device_id, started_ms DESC, id DESC);
-- Degraded/down episodes (written from MET-197 PR 3) are retained indefinitely.
CREATE TABLE net_events (
    id INTEGER PRIMARY KEY,
    device_id TEXT NOT NULL CHECK(device_id <> ''),
    state TEXT NOT NULL CHECK(state IN ('degraded','down')),
    layer TEXT NOT NULL CHECK(layer IN ('lan','wan','dns','tailnet')),
    reason TEXT CHECK(reason IN ('loss','latency','jitter')),
    started_ms INTEGER NOT NULL CHECK(started_ms >= 0),
    ended_ms INTEGER CHECK(ended_ms >= started_ms),
    end_reason TEXT CHECK(end_reason IN ('recovered','changed','restart')),
    peak_loss_percent REAL CHECK(peak_loss_percent BETWEEN 0 AND 100),
    peak_rtt_us INTEGER CHECK(peak_rtt_us >= 0),
    peak_mdev_us INTEGER CHECK(peak_mdev_us >= 0),
    CHECK((state = 'degraded') = (reason IS NOT NULL)),
    CHECK((ended_ms IS NULL) = (end_reason IS NULL))
) STRICT;
CREATE INDEX net_events_started ON net_events(device_id, started_ms DESC, id DESC);
CREATE UNIQUE INDEX net_events_open ON net_events(device_id) WHERE ended_ms IS NULL;
