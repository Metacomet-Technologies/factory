CREATE TABLE requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL CHECK(ts_ms>=0), endpoint TEXT NOT NULL, model TEXT,
  prompt_eval_count INTEGER CHECK(prompt_eval_count>=0),
  eval_count INTEGER CHECK(eval_count>=0),
  load_duration_ns INTEGER CHECK(load_duration_ns>=0),
  prompt_eval_duration_ns INTEGER CHECK(prompt_eval_duration_ns>=0),
  eval_duration_ns INTEGER CHECK(eval_duration_ns>=0),
  total_duration_ns INTEGER CHECK(total_duration_ns>=0),
  usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
  latency_ms REAL NOT NULL CHECK(latency_ms>=0),
  status INTEGER NOT NULL CHECK(status BETWEEN 100 AND 999),
  stream INTEGER NOT NULL CHECK(stream IN (0,1)), error TEXT,
  client_ip TEXT NOT NULL, client_hostname TEXT NOT NULL,
  user_key TEXT CHECK(user_key IS NULL OR length(user_key)>0),
  actor_kind TEXT NOT NULL DEFAULT 'unattributed'
    CHECK(actor_kind IN ('human','agent','unattributed')),
  CHECK((user_key IS NULL AND actor_kind='unattributed') OR
        (user_key IS NOT NULL AND actor_kind IN ('human','agent')))
) STRICT;
CREATE INDEX requests_ts ON requests(ts_ms);
CREATE INDEX requests_model_ts ON requests(model,ts_ms);
CREATE INDEX requests_user_ts ON requests(user_key,actor_kind,ts_ms);
CREATE TABLE gpu_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL CHECK(ts_ms>=0),
  gpu_index INTEGER NOT NULL CHECK(gpu_index>=0),
  memory_used_mib REAL NOT NULL CHECK(memory_used_mib>=0),
  memory_total_mib REAL NOT NULL CHECK(memory_total_mib>=0),
  utilization_percent REAL NOT NULL CHECK(utilization_percent BETWEEN 0 AND 100),
  temperature_c REAL NOT NULL,
  power_w REAL NOT NULL CHECK(power_w>=0)
) STRICT;
CREATE INDEX gpu_ts ON gpu_samples(ts_ms);
CREATE INDEX gpu_index_ts ON gpu_samples(gpu_index,ts_ms,id);
CREATE TABLE drop_episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at_ms INTEGER NOT NULL CHECK(started_at_ms>=0),
  ended_at_ms INTEGER NOT NULL CHECK(ended_at_ms>=started_at_ms),
  dropped_requests INTEGER NOT NULL CHECK(dropped_requests>=0),
  dropped_gpu_samples INTEGER NOT NULL CHECK(dropped_gpu_samples>=0)
) STRICT;
