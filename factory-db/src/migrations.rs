//! Startup-only migration runner, not owner schema adoption.
//!
//! Caller must quiesce other connections and hold exclusive startup ownership
//! before opening readers/listeners (EXCLUSIVE does not exclude WAL readers).
//! Take a fresh verified backup before each production migration. SQL and callbacks
//! are trusted binary code: they must not COMMIT/ROLLBACK, change user_version,
//! attach databases, or perform external effects. Callbacks should only validate
//! local data; rollback cannot undo external effects. No persisted history table
//! means checksums detect binary SQL edits, not prior on-disk migration tampering.
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, Transaction, TransactionBehavior};

pub struct Migration<'a> {
    pub version: u32,
    pub sql: &'a str,
    /// Immutable manifest value, stored as a literal in the owner's binary/tests.
    pub checksum: u64,
}

pub struct LegacySchema<'a> {
    pub fingerprint: &'a str,
    /// Existing schema corresponds to this manifest version (or zero).
    pub version: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Report {
    pub from: u32,
    pub to: u32,
    pub adopted_legacy: bool,
    pub applied: Vec<u32>,
}

/// FNV-1a byte-change detector for trusted binary SQL, NOT a security checksum.
pub const fn checksum(sql: &str) -> u64 {
    let bytes = sql.as_bytes();
    let mut hash = 0xcbf29ce484222325u64;
    let mut i = 0;
    while i < bytes.len() {
        hash = (hash ^ bytes[i] as u64).wrapping_mul(0x100000001b3);
        i += 1;
    }
    hash
}

/// Canonical complete *logical* main.sqlite_schema: every row, including internal
/// objects, sorted by type/name/table/SQL. Length-prefixed UTF-8 fields distinguish
/// NULL, delimiters and embedded newlines. SQL text is compared verbatim, not
/// normalized or hashed. rootpage is deliberately omitted: physical page placement
/// changes on VACUUM and is not schema. ANALYZE-created tables therefore matter.
pub fn schema_fingerprint(db: &Connection) -> Result<String> {
    let mut statement = db.prepare(
        "SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type COLLATE BINARY,name COLLATE BINARY,tbl_name COLLATE BINARY,sql COLLATE BINARY",
    )?;
    let mut rows = statement.query([])?;
    let mut result = String::new();
    while let Some(row) = rows.next()? {
        for column in 0..4 {
            match row.get::<_, Option<String>>(column)? {
                Some(value) => result.push_str(&format!("{}:{}", value.len(), value)),
                None => result.push_str("N:"),
            }
        }
        result.push('\n');
    }
    Ok(result)
}

/// Apply the entire pending sequence atomically. Both owner callbacks and SQLite
/// checks execute before commit so failure preserves schema/data/user_version.
/// Callbacks receive effective starting/final versions, even on a no-op rerun.
pub fn run(
    db: &mut Connection,
    manifest: &[Migration<'_>],
    legacy: Option<LegacySchema<'_>>,
    pre: impl FnOnce(&Transaction<'_>, u32) -> Result<()>,
    post: impl FnOnce(&Transaction<'_>, u32) -> Result<()>,
) -> Result<Report> {
    let mut previous = 0;
    for migration in manifest {
        ensure!(
            migration.version > previous && migration.version <= i32::MAX as u32,
            "invalid migration order/version"
        );
        ensure!(
            checksum(migration.sql) == migration.checksum,
            "migration {} checksum mismatch",
            migration.version
        );
        previous = migration.version;
    }
    let known = |v| v == 0 || manifest.iter().any(|m| m.version == v);
    if let Some(ref legacy) = legacy {
        ensure!(known(legacy.version), "unknown legacy version");
    }
    let tx = db.transaction_with_behavior(TransactionBehavior::Exclusive)?;
    let raw: i64 = tx.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    ensure!(
        raw >= 0 && raw <= i64::from(previous),
        "newer/invalid database version {raw}"
    );
    let from = raw as u32;
    ensure!(known(from), "unknown database version {from}");
    let mut current = from;
    let mut adopted_legacy = false;
    if from == 0 && !schema_fingerprint(&tx)?.is_empty() {
        let legacy =
            legacy.context("nonempty version-zero database requires exact legacy fingerprint")?;
        ensure!(
            schema_fingerprint(&tx)? == legacy.fingerprint,
            "legacy schema fingerprint mismatch"
        );
        current = legacy.version;
        adopted_legacy = true;
    }
    pre(&tx, current).context("owner pre-validation")?;
    let mut applied = Vec::new();
    for migration in manifest.iter().filter(|m| m.version > current) {
        tx.execute_batch(migration.sql)
            .with_context(|| format!("migration {}", migration.version))?;
        applied.push(migration.version);
    }
    let to = applied.last().copied().unwrap_or(current);
    post(&tx, to).context("owner post-validation")?;
    // Detect accidental trusted-code version changes before the runner updates it.
    ensure!(
        tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))? == raw,
        "migration changed user_version"
    );
    ensure!(
        tx.query_row("PRAGMA foreign_key_check", [], |_| Ok(()))
            .optional()?
            .is_none(),
        "foreign key check failed"
    );
    let mut check = tx.prepare("PRAGMA integrity_check")?;
    let results = check
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ensure!(results == ["ok"], "integrity check failed: {results:?}");
    drop(check);
    if to != from {
        tx.pragma_update(None, "user_version", to)?;
    }
    tx.commit()?;
    Ok(Report {
        from,
        to,
        adopted_legacy,
        applied,
    })
}

use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests {
    use super::*;

    const SQL: &str = "CREATE TABLE items(id INTEGER PRIMARY KEY) STRICT;";
    fn manifest() -> [Migration<'static>; 1] {
        [Migration {
            version: 1,
            sql: SQL,
            checksum: 0x483932d489b45372,
        }]
    }
    fn temporary() -> Result<(tempfile::TempDir, Connection)> {
        let dir = tempfile::tempdir()?;
        let db = Connection::open(dir.path().join("fixture.db"))?;
        Ok((dir, db))
    }
    fn apply(db: &mut Connection, migrations: &[Migration<'_>]) -> Result<Report> {
        run(db, migrations, None, |_, _| Ok(()), |_, _| Ok(()))
    }
    #[test]
    fn empty_and_rerun() -> Result<()> {
        let (_dir, mut db) = temporary()?;
        assert_eq!(manifest()[0].checksum, checksum(SQL));
        assert_eq!(apply(&mut db, &manifest())?.applied, [1]);
        assert!(apply(&mut db, &manifest())?.applied.is_empty());
        Ok(())
    }
    #[test]
    fn failures_rollback() -> Result<()> {
        for sql_failure in [true, false] {
            let (_dir, mut db) = temporary()?;
            let sql = if sql_failure {
                "CREATE TABLE partial(id INTEGER); INVALID;"
            } else {
                SQL
            };
            let m = [Migration {
                version: 1,
                sql,
                checksum: checksum(sql),
            }];
            assert!(
                run(
                    &mut db,
                    &m,
                    None,
                    |_, _| Ok(()),
                    |_, _| anyhow::bail!("owner invariant")
                )
                .is_err()
            );
            assert!(schema_fingerprint(&db)?.is_empty());
            assert_eq!(
                db.query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))?,
                0
            );
        }
        let (_dir, mut db) = temporary()?;
        assert!(
            run(
                &mut db,
                &manifest(),
                None,
                |_, _| anyhow::bail!("pre"),
                |_, _| Ok(())
            )
            .is_err()
        );
        assert!(schema_fingerprint(&db)?.is_empty());
        Ok(())
    }
    #[test]
    fn rejects_versions_and_bad_manifest_without_changes() -> Result<()> {
        for version in [2, 4] {
            let (_dir, mut db) = temporary()?;
            db.pragma_update(None, "user_version", version)?;
            let before = std::fs::read(db.path().unwrap())?;
            let m = [
                Migration {
                    version: 1,
                    sql: SQL,
                    checksum: checksum(SQL),
                },
                Migration {
                    version: 3,
                    sql: "",
                    checksum: checksum(""),
                },
            ];
            assert!(apply(&mut db, &m).is_err());
            assert_eq!(std::fs::read(db.path().unwrap())?, before);
            assert!(schema_fingerprint(&db)?.is_empty());
            assert_eq!(
                db.query_row("PRAGMA user_version", [], |r| r.get::<_, i32>(0))?,
                version
            );
        }
        let (_dir, mut db) = temporary()?;
        for (version, hash) in [(0, checksum(SQL)), (1, 0)] {
            assert!(
                apply(
                    &mut db,
                    &[Migration {
                        version,
                        sql: SQL,
                        checksum: hash
                    }]
                )
                .is_err()
            );
        }
        assert!(
            apply(
                &mut db,
                &[
                    Migration {
                        version: 1,
                        sql: SQL,
                        checksum: checksum(SQL)
                    },
                    Migration {
                        version: 1,
                        sql: "",
                        checksum: checksum("")
                    }
                ]
            )
            .is_err()
        );
        assert!(schema_fingerprint(&db)?.is_empty());
        Ok(())
    }
    #[test]
    fn exact_legacy_adoption_only() -> Result<()> {
        let (_dir, mut db) = temporary()?;
        db.execute_batch(SQL)?;
        let fingerprint = schema_fingerprint(&db)?;
        assert!(apply(&mut db, &manifest()).is_err());
        db.execute_batch("CREATE INDEX extra_index ON items(id)")?;
        assert!(
            run(
                &mut db,
                &manifest(),
                Some(LegacySchema {
                    fingerprint: &fingerprint,
                    version: 1
                }),
                |_, _| Ok(()),
                |_, _| Ok(())
            )
            .is_err()
        );
        db.execute_batch("DROP INDEX extra_index")?;
        assert!(
            run(
                &mut db,
                &manifest(),
                Some(LegacySchema {
                    fingerprint: "wrong",
                    version: 1
                }),
                |_, _| Ok(()),
                |_, _| Ok(())
            )
            .is_err()
        );
        let report = run(
            &mut db,
            &manifest(),
            Some(LegacySchema {
                fingerprint: &fingerprint,
                version: 1,
            }),
            |_, v| {
                ensure!(v == 1, "version");
                Ok(())
            },
            |_, _| Ok(()),
        )?;
        assert!(report.adopted_legacy);
        assert!(report.applied.is_empty());
        assert_eq!(schema_fingerprint(&db)?, fingerprint);
        Ok(())
    }
    #[test]
    fn fk_failure_rolls_back_even_when_enforcement_disabled() -> Result<()> {
        let (_dir, mut db) = temporary()?;
        db.pragma_update(None, "foreign_keys", false)?;
        let sql = "CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(p INTEGER REFERENCES p(id)); INSERT INTO c VALUES(7);";
        assert!(
            apply(
                &mut db,
                &[Migration {
                    version: 1,
                    sql,
                    checksum: checksum(sql)
                }]
            )
            .is_err()
        );
        assert!(schema_fingerprint(&db)?.is_empty());
        Ok(())
    }
}
