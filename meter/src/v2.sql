-- MET-205: rollups and their checkpoints. Existing tables and rows are untouched.
-- Request rollups (docs/data-model.md "Rollup tables and exact aggregation").
-- Identical in meter and factory-api; only bucket width differs between tables.
-- dimension_key is json_array(endpoint,model,user_key,actor_kind), so NULL,
-- empty string and literal "unattributed" stay distinct in the primary key.
CREATE TABLE request_hourly (
  bucket_ms INTEGER NOT NULL CHECK(bucket_ms>=0 AND bucket_ms%3600000=0),
  dimension_key TEXT NOT NULL CHECK(dimension_key=json_array(endpoint,model,user_key,actor_kind)),
  endpoint TEXT NOT NULL, model TEXT,
  user_key TEXT CHECK(user_key IS NULL OR length(user_key)>0),
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','agent','unattributed')),
  requests INTEGER NOT NULL CHECK(requests>0),
  input_tokens INTEGER NOT NULL CHECK(input_tokens>=0),
  output_tokens INTEGER NOT NULL CHECK(output_tokens>=0),
  input_known_count INTEGER NOT NULL CHECK(input_known_count BETWEEN 0 AND requests),
  output_known_count INTEGER NOT NULL CHECK(output_known_count BETWEEN 0 AND requests),
  prompt_tps_sum REAL NOT NULL CHECK(prompt_tps_sum>=0),
  prompt_tps_count INTEGER NOT NULL CHECK(prompt_tps_count BETWEEN 0 AND requests),
  generation_tps_sum REAL NOT NULL CHECK(generation_tps_sum>=0),
  generation_tps_count INTEGER NOT NULL CHECK(generation_tps_count BETWEEN 0 AND requests),
  total_load_ns INTEGER NOT NULL CHECK(total_load_ns>=0),
  load_known_count INTEGER NOT NULL CHECK(load_known_count BETWEEN 0 AND requests),
  PRIMARY KEY(bucket_ms,dimension_key),
  CHECK((user_key IS NULL AND actor_kind='unattributed') OR
        (user_key IS NOT NULL AND actor_kind IN ('human','agent')))
) STRICT, WITHOUT ROWID;
CREATE INDEX request_hourly_model ON request_hourly(model,bucket_ms);
CREATE INDEX request_hourly_user ON request_hourly(user_key,actor_kind,bucket_ms);
CREATE TABLE request_daily (
  bucket_ms INTEGER NOT NULL CHECK(bucket_ms>=0 AND bucket_ms%86400000=0),
  dimension_key TEXT NOT NULL CHECK(dimension_key=json_array(endpoint,model,user_key,actor_kind)),
  endpoint TEXT NOT NULL, model TEXT,
  user_key TEXT CHECK(user_key IS NULL OR length(user_key)>0),
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','agent','unattributed')),
  requests INTEGER NOT NULL CHECK(requests>0),
  input_tokens INTEGER NOT NULL CHECK(input_tokens>=0),
  output_tokens INTEGER NOT NULL CHECK(output_tokens>=0),
  input_known_count INTEGER NOT NULL CHECK(input_known_count BETWEEN 0 AND requests),
  output_known_count INTEGER NOT NULL CHECK(output_known_count BETWEEN 0 AND requests),
  prompt_tps_sum REAL NOT NULL CHECK(prompt_tps_sum>=0),
  prompt_tps_count INTEGER NOT NULL CHECK(prompt_tps_count BETWEEN 0 AND requests),
  generation_tps_sum REAL NOT NULL CHECK(generation_tps_sum>=0),
  generation_tps_count INTEGER NOT NULL CHECK(generation_tps_count BETWEEN 0 AND requests),
  total_load_ns INTEGER NOT NULL CHECK(total_load_ns>=0),
  load_known_count INTEGER NOT NULL CHECK(load_known_count BETWEEN 0 AND requests),
  PRIMARY KEY(bucket_ms,dimension_key),
  CHECK((user_key IS NULL AND actor_kind='unattributed') OR
        (user_key IS NOT NULL AND actor_kind IN ('human','agent')))
) STRICT, WITHOUT ROWID;
CREATE INDEX request_daily_model ON request_daily(model,bucket_ms);
CREATE INDEX request_daily_user ON request_daily(user_key,actor_kind,bucket_ms);
-- Mergeable fixed-bucket latency histograms; scheme 1 is factory_db::rollup::latency.
-- A new bin layout adds a new scheme number; existing scheme rows never change.
CREATE TABLE request_latency_hourly (
  bucket_ms INTEGER NOT NULL, dimension_key TEXT NOT NULL,
  scheme INTEGER NOT NULL CHECK(scheme>=1),
  bin INTEGER NOT NULL CHECK(bin>=0 AND (scheme<>1 OR bin<=495)),
  requests INTEGER NOT NULL CHECK(requests>0),
  PRIMARY KEY(bucket_ms,dimension_key,scheme,bin),
  FOREIGN KEY(bucket_ms,dimension_key) REFERENCES request_hourly(bucket_ms,dimension_key)
) STRICT, WITHOUT ROWID;
CREATE TABLE request_latency_daily (
  bucket_ms INTEGER NOT NULL, dimension_key TEXT NOT NULL,
  scheme INTEGER NOT NULL CHECK(scheme>=1),
  bin INTEGER NOT NULL CHECK(bin>=0 AND (scheme<>1 OR bin<=495)),
  requests INTEGER NOT NULL CHECK(requests>0),
  PRIMARY KEY(bucket_ms,dimension_key,scheme,bin),
  FOREIGN KEY(bucket_ms,dimension_key) REFERENCES request_daily(bucket_ms,dimension_key)
) STRICT, WITHOUT ROWID;
-- Per-GPU hourly measurement summaries. Missing cycles add no samples;
-- *_last comes from the greatest (ts_ms,id). Not time-weighted energy.
CREATE TABLE gpu_hourly (
  bucket_ms INTEGER NOT NULL CHECK(bucket_ms>=0 AND bucket_ms%3600000=0),
  gpu_index INTEGER NOT NULL CHECK(gpu_index>=0),
  samples INTEGER NOT NULL CHECK(samples>0),
  last_sample_ms INTEGER NOT NULL CHECK(last_sample_ms>=bucket_ms AND last_sample_ms<bucket_ms+3600000),
  memory_used_mib_sum REAL NOT NULL CHECK(memory_used_mib_sum>=0),
  memory_used_mib_min REAL NOT NULL CHECK(memory_used_mib_min>=0),
  memory_used_mib_max REAL NOT NULL CHECK(memory_used_mib_max>=memory_used_mib_min),
  memory_used_mib_last REAL NOT NULL CHECK(memory_used_mib_last BETWEEN memory_used_mib_min AND memory_used_mib_max),
  memory_total_mib_sum REAL NOT NULL CHECK(memory_total_mib_sum>=0),
  memory_total_mib_min REAL NOT NULL CHECK(memory_total_mib_min>=0),
  memory_total_mib_max REAL NOT NULL CHECK(memory_total_mib_max>=memory_total_mib_min),
  memory_total_mib_last REAL NOT NULL CHECK(memory_total_mib_last BETWEEN memory_total_mib_min AND memory_total_mib_max),
  utilization_percent_sum REAL NOT NULL CHECK(utilization_percent_sum>=0),
  utilization_percent_min REAL NOT NULL CHECK(utilization_percent_min BETWEEN 0 AND 100),
  utilization_percent_max REAL NOT NULL CHECK(utilization_percent_max BETWEEN utilization_percent_min AND 100),
  utilization_percent_last REAL NOT NULL CHECK(utilization_percent_last BETWEEN utilization_percent_min AND utilization_percent_max),
  temperature_c_sum REAL NOT NULL,
  temperature_c_min REAL NOT NULL,
  temperature_c_max REAL NOT NULL CHECK(temperature_c_max>=temperature_c_min),
  temperature_c_last REAL NOT NULL CHECK(temperature_c_last BETWEEN temperature_c_min AND temperature_c_max),
  power_w_sum REAL NOT NULL CHECK(power_w_sum>=0),
  power_w_min REAL NOT NULL CHECK(power_w_min>=0),
  power_w_max REAL NOT NULL CHECK(power_w_max>=power_w_min),
  power_w_last REAL NOT NULL CHECK(power_w_last BETWEEN power_w_min AND power_w_max),
  PRIMARY KEY(bucket_ms,gpu_index)
) STRICT, WITHOUT ROWID;
CREATE INDEX gpu_hourly_index ON gpu_hourly(gpu_index,bucket_ms);
-- One checkpoint per job, created with its first committed aggregates.
-- verified_at_ms is set only after the aggregate-versus-raw comparison passes.
CREATE TABLE rollup_state (
  job TEXT PRIMARY KEY NOT NULL CHECK(job IN ('requests','gpu')),
  last_id INTEGER NOT NULL CHECK(last_id>=0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=0),
  verified_at_ms INTEGER CHECK(verified_at_ms>=0)
) STRICT, WITHOUT ROWID;
-- Exact percentiles read only these columns of the requested time range.
CREATE INDEX requests_ts_latency ON requests(ts_ms,model,total_duration_ns,latency_ms);
