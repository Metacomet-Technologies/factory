-- MET-204: frozen per-request, per-family reference costs. Existing tables are untouched.
-- Provenance IDs refer to the separate pricing database, so they are not SQLite FKs.
-- WITHOUT ROWID: usage and cascades probe the (request_id,family) key directly.
CREATE TABLE request_costs (
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  family TEXT NOT NULL CHECK(length(family)>0),
  priced_at_ms INTEGER NOT NULL CHECK(priced_at_ms>=0),
  cost_status TEXT NOT NULL CHECK(cost_status IN ('priced','estimated','unpriced')),
  cost_nano_usd INTEGER CHECK(cost_nano_usd>=0),
  selection_id INTEGER CHECK(selection_id>0),
  snapshot_id INTEGER CHECK(snapshot_id>0),
  reference_model_id TEXT CHECK(length(reference_model_id)>0),
  input_micro_usd_per_mtok INTEGER CHECK(input_micro_usd_per_mtok>=0),
  output_micro_usd_per_mtok INTEGER CHECK(output_micro_usd_per_mtok>=0),
  PRIMARY KEY(request_id,family),
  CHECK(CASE WHEN cost_status='unpriced' THEN
      cost_nano_usd IS NULL AND selection_id IS NULL AND snapshot_id IS NULL AND reference_model_id IS NULL
      AND input_micro_usd_per_mtok IS NULL AND output_micro_usd_per_mtok IS NULL
    ELSE
      cost_nano_usd IS NOT NULL AND selection_id IS NOT NULL AND snapshot_id IS NOT NULL AND reference_model_id IS NOT NULL
      AND input_micro_usd_per_mtok IS NOT NULL AND output_micro_usd_per_mtok IS NOT NULL
    END)
) STRICT, WITHOUT ROWID;
CREATE INDEX request_costs_family ON request_costs(family,request_id);
-- Priced and estimated rows are frozen. A later price never rewrites them.
CREATE TRIGGER request_costs_frozen BEFORE UPDATE ON request_costs
WHEN NOT (OLD.cost_status='unpriced' AND NEW.cost_status='estimated'
          AND NEW.request_id=OLD.request_id AND NEW.family=OLD.family)
BEGIN
  SELECT RAISE(ABORT,'request_costs: only unpriced may become estimated');
END;

-- One resumable walk per configured family over (after_id, target_id].
-- unpriced_from_id marks rows frozen before any reference price existed.
CREATE TABLE cost_backfill (
  family TEXT PRIMARY KEY NOT NULL CHECK(length(family)>0),
  after_id INTEGER NOT NULL CHECK(after_id>=0),
  target_id INTEGER NOT NULL CHECK(target_id>=0),
  unpriced_from_id INTEGER CHECK(unpriced_from_id>0),
  completed_at_ms INTEGER CHECK(completed_at_ms>=0)
) STRICT;
