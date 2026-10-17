-- Host samples for factory-gpu. Raw rows stay seven days and are deleted
-- in bounded batches only after that hour's rollup is committed.
-- Hourly rollups stay. Null means the reading was not available.
CREATE TABLE device_samples (
    device_id TEXT NOT NULL,
    ts_ms INTEGER NOT NULL CHECK(ts_ms >= 0),
    cpu_percent REAL CHECK(cpu_percent IS NULL OR (cpu_percent >= 0 AND cpu_percent <= 100)),
    memory_used_bytes INTEGER CHECK(memory_used_bytes IS NULL OR memory_used_bytes >= 0),
    load1 REAL CHECK(load1 IS NULL OR load1 >= 0),
    disk_read_bps REAL CHECK(disk_read_bps IS NULL OR disk_read_bps >= 0),
    disk_write_bps REAL CHECK(disk_write_bps IS NULL OR disk_write_bps >= 0),
    net_rx_bps REAL CHECK(net_rx_bps IS NULL OR net_rx_bps >= 0),
    net_tx_bps REAL CHECK(net_tx_bps IS NULL OR net_tx_bps >= 0),
    cpu_temp_c REAL,
    PRIMARY KEY (device_id, ts_ms)
) STRICT;
CREATE INDEX device_samples_ts ON device_samples(ts_ms);

CREATE TABLE device_rollup_hourly (
    device_id TEXT NOT NULL,
    ts_ms INTEGER NOT NULL CHECK(ts_ms >= 0 AND ts_ms % 3600000 = 0),
    sample_count INTEGER NOT NULL CHECK(sample_count > 0),
    cpu_min REAL, cpu_avg REAL, cpu_max REAL,
    mem_min REAL, mem_avg REAL, mem_max REAL,
    load_min REAL, load_avg REAL, load_max REAL,
    read_min REAL, read_avg REAL, read_max REAL,
    write_min REAL, write_avg REAL, write_max REAL,
    rx_min REAL, rx_avg REAL, rx_max REAL,
    tx_min REAL, tx_avg REAL, tx_max REAL,
    temp_min REAL, temp_avg REAL, temp_max REAL,
    PRIMARY KEY (device_id, ts_ms)
) STRICT;
