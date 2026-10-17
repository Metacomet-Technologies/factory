-- Rebuild only the replicated facts. Telemetry tables and pricing are untouched.
ALTER TABLE requests RENAME TO requests_before_v4;
DROP INDEX requests_ts;
CREATE TABLE requests (
  id INTEGER PRIMARY KEY CHECK(id>0),
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

CREATE TABLE sync_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  last_after_id INTEGER NOT NULL CHECK(last_after_id>=0),
  synced_at_ms INTEGER NOT NULL CHECK(synced_at_ms>=0),
  replay_through_id INTEGER NOT NULL CHECK(replay_through_id>=0),
  rebuilding INTEGER NOT NULL CHECK(rebuilding IN (0,1))
) STRICT;
INSERT INTO sync_state SELECT 1,0,0,COALESCE(MAX(id),0),COUNT(*)>0 FROM requests_before_v4;

ALTER TABLE warnings RENAME TO warnings_before_v4;
CREATE TABLE warnings (
  message TEXT PRIMARY KEY NOT NULL,
  first_seen_ms INTEGER NOT NULL CHECK(first_seen_ms>=0),
  last_seen_ms INTEGER NOT NULL CHECK(last_seen_ms>=first_seen_ms),
  resolved_at_ms INTEGER CHECK(resolved_at_ms>=first_seen_ms),
  first_id INTEGER CHECK(first_id>0),
  last_id INTEGER CHECK(last_id>=first_id),
  CHECK((first_id IS NULL) = (last_id IS NULL))
) STRICT;
CREATE INDEX warnings_unresolved ON warnings(resolved_at_ms,last_seen_ms);
