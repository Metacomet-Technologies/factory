use anyhow::{Result, ensure};
use rusqlite::Connection;

/// Application integer settings. The owner creates `settings(key TEXT PRIMARY
/// KEY, value INTEGER) STRICT` in its versioned migration, never in a handler.
pub fn integers(db: &Connection, keys: &[&str]) -> Result<Vec<Option<i64>>> {
    let placeholders = std::iter::repeat_n("?", keys.len())
        .collect::<Vec<_>>()
        .join(",");
    let mut statement = db.prepare(&format!(
        "SELECT key,value FROM settings WHERE key IN ({placeholders})"
    ))?;
    let values = statement
        .query_map(rusqlite::params_from_iter(keys), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
        })?
        .collect::<rusqlite::Result<std::collections::BTreeMap<_, _>>>()?;
    Ok(keys
        .iter()
        .map(|key| values.get(*key).copied().flatten())
        .collect())
}

/// One statement; multiple settings change together even without a transaction.
pub fn put_integers(db: &Connection, values: &[(&str, Option<i64>)]) -> Result<()> {
    if values.is_empty() {
        return Ok(());
    }
    let placeholders = std::iter::repeat_n("(?,?)", values.len())
        .collect::<Vec<_>>()
        .join(",");
    let parameters = values
        .iter()
        .flat_map(|(key, value)| [rusqlite::types::Value::Text((*key).into()), (*value).into()]);
    db.execute(&format!("INSERT INTO settings(key,value) VALUES {placeholders} ON CONFLICT(key) DO UPDATE SET value=excluded.value"), rusqlite::params_from_iter(parameters))?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    pub journal_mode: String,
    pub synchronous: i64,
    pub busy_timeout: i64,
    pub foreign_keys: i64,
    pub journal_size_limit: i64,
    pub query_only: i64,
    pub cache_size: i64,
    pub wal_autocheckpoint: i64,
}

impl Settings {
    pub fn read(db: &Connection) -> Result<Self> {
        let integer = |name: &str| -> rusqlite::Result<i64> {
            db.pragma_query_value(None, name, |row| row.get(0))
        };
        Ok(Self {
            journal_mode: db.pragma_query_value(None, "journal_mode", |row| row.get(0))?,
            synchronous: integer("synchronous")?,
            busy_timeout: integer("busy_timeout")?,
            foreign_keys: integer("foreign_keys")?,
            journal_size_limit: integer("journal_size_limit")?,
            query_only: integer("query_only")?,
            cache_size: integer("cache_size")?,
            wal_autocheckpoint: integer("wal_autocheckpoint")?,
        })
    }
}

/// MEMORY is accepted only when SQLite reports no backing file (unit tests).
pub fn apply(db: &Connection, reader: bool, reader_cache_kib: u32) -> Result<Settings> {
    ensure!(db.is_autocommit(), "settings require no active transaction");
    ensure!(reader_cache_kib > 0, "reader cache must be positive");
    if !reader {
        db.pragma_update(None, "journal_mode", "WAL")?;
    }
    db.execute_batch(
        "PRAGMA synchronous=NORMAL;
         PRAGMA busy_timeout=5000;
         PRAGMA foreign_keys=ON;
         PRAGMA journal_size_limit=67108864;
         PRAGMA wal_autocheckpoint=1000;",
    )?;
    if reader {
        db.pragma_update(None, "cache_size", -i64::from(reader_cache_kib))?;
    }
    db.pragma_update(None, "query_only", reader)?;
    verify(db, reader, reader_cache_kib)
}

pub fn verify(db: &Connection, reader: bool, reader_cache_kib: u32) -> Result<Settings> {
    let actual = Settings::read(db)?;
    ensure!(
        actual.journal_mode == "wal"
            || (actual.journal_mode == "memory" && db.path().is_none_or(str::is_empty)),
        "expected WAL, got {actual:?}"
    );
    ensure!(
        actual.synchronous == 1
            && actual.busy_timeout == 5000
            && actual.foreign_keys == 1
            && actual.journal_size_limit == 67_108_864
            && actual.query_only == i64::from(reader)
            && actual.wal_autocheckpoint == 1000
            && (!reader || actual.cache_size == -i64::from(reader_cache_kib)),
        "connection settings did not apply: {actual:?}"
    );
    Ok(actual)
}

/// Returns SQLite's (busy, WAL pages, checkpointed pages); never waits for readers.
pub fn checkpoint(db: &Connection) -> Result<(i64, i64, i64)> {
    Ok(db.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?)
}

pub fn optimize(db: &Connection) -> Result<()> {
    Ok(db.execute_batch("PRAGMA optimize")?)
}
