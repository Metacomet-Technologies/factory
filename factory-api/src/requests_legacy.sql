-- Schema captured in docs/data-model.md, Factory-api cache schema (MET-92).
CREATE TABLE requests(id INTEGER PRIMARY KEY, ts_ms INTEGER NOT NULL, record TEXT NOT NULL);
CREATE INDEX requests_ts ON requests(ts_ms);
CREATE TABLE warnings(message TEXT PRIMARY KEY);
