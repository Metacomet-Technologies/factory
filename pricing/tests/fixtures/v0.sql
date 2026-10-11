-- Legacy pricing schema from docs/data-model.md, including step-3 indexes.
CREATE TABLE refreshes (fetched_at INTEGER NOT NULL);
CREATE TABLE price_snapshots (
  fetched_at INTEGER NOT NULL, source TEXT NOT NULL, model_id TEXT NOT NULL,
  input_per_mtok REAL NOT NULL CHECK(input_per_mtok >= 0),
  output_per_mtok REAL NOT NULL CHECK(output_per_mtok >= 0), released_at INTEGER,
  refresh_id INTEGER NOT NULL
);
CREATE INDEX snapshot_lookup ON price_snapshots(model_id, fetched_at);
CREATE TABLE reference_selection (
  family TEXT NOT NULL, model_id TEXT NOT NULL, effective_from INTEGER NOT NULL,
  confirmed INTEGER NOT NULL CHECK(confirmed IN (0,1)), refresh_id INTEGER NOT NULL
);
CREATE INDEX selection_lookup ON reference_selection(family, effective_from);
CREATE TABLE pricing_items (
  fetched_at INTEGER NOT NULL, kind TEXT NOT NULL, family TEXT NOT NULL,
  message TEXT NOT NULL, refresh_id INTEGER NOT NULL
);
CREATE INDEX items_refresh ON pricing_items(refresh_id);
CREATE INDEX selection_confirmed ON reference_selection(family,confirmed,effective_from);
