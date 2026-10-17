-- MET-205: request and spend rollups with their checkpoint. Existing tables and rows are untouched.
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
-- Frozen request costs per family and dimension. Families are alternatives and
-- are never summed together. priced+estimated+unpriced equals the inference
-- requests of the matching request rollup row.
CREATE TABLE spend_hourly (
  bucket_ms INTEGER NOT NULL CHECK(bucket_ms>=0 AND bucket_ms%3600000=0),
  family TEXT NOT NULL CHECK(length(family)>0),
  dimension_key TEXT NOT NULL CHECK(dimension_key=json_array(endpoint,model,user_key,actor_kind)),
  endpoint TEXT NOT NULL, model TEXT,
  user_key TEXT CHECK(user_key IS NULL OR length(user_key)>0),
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','agent','unattributed')),
  priced_nano_usd INTEGER NOT NULL CHECK(priced_nano_usd>=0),
  estimated_nano_usd INTEGER NOT NULL CHECK(estimated_nano_usd>=0),
  priced_requests INTEGER NOT NULL CHECK(priced_requests>=0),
  estimated_requests INTEGER NOT NULL CHECK(estimated_requests>=0),
  unpriced_requests INTEGER NOT NULL CHECK(unpriced_requests>=0),
  PRIMARY KEY(bucket_ms,family,dimension_key),
  FOREIGN KEY(bucket_ms,dimension_key) REFERENCES request_hourly(bucket_ms,dimension_key),
  CHECK((user_key IS NULL AND actor_kind='unattributed') OR
        (user_key IS NOT NULL AND actor_kind IN ('human','agent')))
) STRICT, WITHOUT ROWID;
CREATE INDEX spend_hourly_family ON spend_hourly(family,bucket_ms);
CREATE INDEX spend_hourly_user ON spend_hourly(user_key,actor_kind,bucket_ms,family);
CREATE TABLE spend_daily (
  bucket_ms INTEGER NOT NULL CHECK(bucket_ms>=0 AND bucket_ms%86400000=0),
  family TEXT NOT NULL CHECK(length(family)>0),
  dimension_key TEXT NOT NULL CHECK(dimension_key=json_array(endpoint,model,user_key,actor_kind)),
  endpoint TEXT NOT NULL, model TEXT,
  user_key TEXT CHECK(user_key IS NULL OR length(user_key)>0),
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','agent','unattributed')),
  priced_nano_usd INTEGER NOT NULL CHECK(priced_nano_usd>=0),
  estimated_nano_usd INTEGER NOT NULL CHECK(estimated_nano_usd>=0),
  priced_requests INTEGER NOT NULL CHECK(priced_requests>=0),
  estimated_requests INTEGER NOT NULL CHECK(estimated_requests>=0),
  unpriced_requests INTEGER NOT NULL CHECK(unpriced_requests>=0),
  PRIMARY KEY(bucket_ms,family,dimension_key),
  FOREIGN KEY(bucket_ms,dimension_key) REFERENCES request_daily(bucket_ms,dimension_key),
  CHECK((user_key IS NULL AND actor_kind='unattributed') OR
        (user_key IS NOT NULL AND actor_kind IN ('human','agent')))
) STRICT, WITHOUT ROWID;
CREATE INDEX spend_daily_family ON spend_daily(family,bucket_ms);
CREATE INDEX spend_daily_user ON spend_daily(user_key,actor_kind,bucket_ms,family);
-- One checkpoint for request metrics and costs together, created with the
-- first committed aggregates; verified_at_ms only after the raw comparison.
CREATE TABLE rollup_state (
  job TEXT PRIMARY KEY NOT NULL CHECK(job='requests'),
  last_id INTEGER NOT NULL CHECK(last_id>=0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=0),
  verified_at_ms INTEGER CHECK(verified_at_ms>=0)
) STRICT, WITHOUT ROWID;
-- Exact usage percentiles read only these columns of the requested time range.
CREATE INDEX requests_ts_latency ON requests(ts_ms,endpoint,model,total_duration_ns,latency_ms);
