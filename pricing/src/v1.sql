CREATE TABLE refreshes (
  id INTEGER PRIMARY KEY, fetched_at_ms INTEGER NOT NULL CHECK(fetched_at_ms>=0)
) STRICT;
CREATE INDEX refreshes_time ON refreshes(fetched_at_ms);
CREATE TABLE price_snapshots (
  id INTEGER PRIMARY KEY, refresh_id INTEGER NOT NULL REFERENCES refreshes(id),
  fetched_at_ms INTEGER NOT NULL CHECK(fetched_at_ms>=0),
  source TEXT NOT NULL CHECK(source IN ('openrouter','litellm')), model_id TEXT NOT NULL,
  input_micro_usd_per_mtok INTEGER NOT NULL CHECK(input_micro_usd_per_mtok>=0),
  output_micro_usd_per_mtok INTEGER NOT NULL CHECK(output_micro_usd_per_mtok>=0),
  released_at_ms INTEGER CHECK(released_at_ms>=0)
) STRICT;
CREATE INDEX snapshot_lookup ON price_snapshots(
  model_id,fetched_at_ms DESC,refresh_id DESC,(source='openrouter') DESC,id DESC);
CREATE INDEX snapshot_earliest ON price_snapshots(
  model_id,fetched_at_ms,refresh_id,(source='openrouter') DESC,id DESC);
CREATE INDEX snapshot_release ON price_snapshots(model_id,released_at_ms DESC);
CREATE INDEX snapshot_refresh ON price_snapshots(refresh_id);
CREATE TABLE reference_selection (
  id INTEGER PRIMARY KEY, family TEXT NOT NULL, model_id TEXT NOT NULL,
  effective_from_ms INTEGER NOT NULL CHECK(effective_from_ms>=0),
  confirmed INTEGER NOT NULL CHECK(confirmed IN (0,1)),
  refresh_id INTEGER NOT NULL REFERENCES refreshes(id)
) STRICT;
CREATE INDEX selection_lookup ON reference_selection(
  family,confirmed,effective_from_ms DESC,id DESC);
CREATE INDEX selection_confirmed_id ON reference_selection(family,id DESC) WHERE confirmed=1;
CREATE INDEX selection_pending ON reference_selection(family,refresh_id,effective_from_ms DESC,id DESC)
  WHERE confirmed=0;
CREATE INDEX selection_time ON reference_selection(effective_from_ms);
CREATE INDEX selection_refresh ON reference_selection(refresh_id);
CREATE TABLE pricing_items (
  id INTEGER PRIMARY KEY, refresh_id INTEGER NOT NULL REFERENCES refreshes(id),
  fetched_at_ms INTEGER NOT NULL CHECK(fetched_at_ms>=0),
  kind TEXT NOT NULL CHECK(kind IN ('warning','pricing.changed')),
  family TEXT NOT NULL, message TEXT NOT NULL
) STRICT;
CREATE INDEX items_refresh ON pricing_items(refresh_id,id);
