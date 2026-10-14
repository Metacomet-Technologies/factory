CREATE TABLE audit (
    id INTEGER PRIMARY KEY,
    ts_ms INTEGER NOT NULL CHECK(ts_ms >= 0),
    event TEXT NOT NULL CHECK(event IN ('request','confirm','dispatch','execute','refuse','guard-deny')),
    login TEXT,
    action TEXT,
    value TEXT,
    old_value TEXT,
    result TEXT NOT NULL,
    nut_response TEXT,
    boot_id TEXT NOT NULL,
    attempted INTEGER NOT NULL DEFAULT 0 CHECK(attempted IN (0,1)),
    executed INTEGER NOT NULL DEFAULT 0 CHECK(executed IN (0,1) AND (executed=0 OR event='execute')),
    tracking_status TEXT,
    tracking_id TEXT,
    notify INTEGER NOT NULL DEFAULT 0 CHECK(notify IN (0,1,2))
) STRICT;
CREATE INDEX audit_time ON audit(ts_ms DESC, id DESC);
CREATE INDEX audit_action ON audit(action, attempted, ts_ms DESC);
CREATE INDEX audit_pending ON audit(boot_id, action, attempted, id DESC);
CREATE INDEX audit_notifications ON audit(notify, id);
CREATE INDEX audit_guard ON audit(ts_ms DESC) WHERE event='guard-deny' AND notify>0;
CREATE TABLE confirmations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT NOT NULL,
    action TEXT NOT NULL,
    value TEXT,
    phrase TEXT NOT NULL,
    expires_ms INTEGER NOT NULL CHECK(expires_ms >= 0),
    used INTEGER NOT NULL DEFAULT 0 CHECK(used IN (0,1))
) STRICT;
