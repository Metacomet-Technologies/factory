//! Semantic EQP checks, not exact plan snapshots. Use analyzed, representative
//! fixtures and bound production parameters. Aliases are the plan's table names.
//! EQP cannot prove bounded row visits (notably global MAX with wrong leading
//! indexes); owners must additionally measure those paths. Exceptions are explicit
//! review assertions, not SQL parsers or automatic proofs of bounded work.
use anyhow::{Result, ensure};
use rusqlite::{Connection, Params};

pub fn query_plan(db: &Connection, sql: &str, params: impl Params) -> Result<Vec<String>> {
    let mut statement = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
    Ok(statement
        .query_map(params, |row| row.get(3))?
        .collect::<rusqlite::Result<_>>()?)
}

pub struct RequiredSearch<'a> {
    pub table: &'a str,
    /// None accepts any SEARCH; Some requires this exact named index.
    pub index: Option<&'a str>,
}

#[derive(Clone, Copy, Debug)]
pub enum ExceptionKind {
    LimitZero,
    BoundedRowidWalk,
    SmallWholeSetRead,
    ReviewedLegacySort,
}

pub struct Exception<'a> {
    pub kind: ExceptionKind,
    /// Exact table/alias for scan exceptions; ignored for ReviewedLegacySort.
    pub table: &'a str,
    pub reason: &'a str,
}

/// Reject every SCAN (including full index scans) and temp B-tree by default.
/// Required searches are never waived by exceptions. Match token boundaries so
/// similarly named tables/indexes cannot accidentally satisfy a requirement.
pub fn validate(
    plan: &[String],
    required: &[RequiredSearch<'_>],
    exceptions: &[Exception<'_>],
) -> Result<()> {
    for exception in exceptions {
        ensure!(
            !exception.reason.trim().is_empty(),
            "EQP exception requires a review reason"
        );
        if !matches!(exception.kind, ExceptionKind::ReviewedLegacySort) {
            ensure!(
                !exception.table.trim().is_empty(),
                "scan exception requires a table"
            );
        }
    }
    for requirement in required {
        ensure!(
            plan.iter().any(|detail| {
                let words: Vec<_> = detail.split_whitespace().collect();
                let search =
                    words.first() == Some(&"SEARCH") && words.get(1) == Some(&requirement.table);
                search
                    && requirement
                        .index
                        .is_none_or(|index| words.windows(2).any(|pair| pair == ["INDEX", index]))
            }),
            "missing SEARCH on {} index {:?}: {plan:?}",
            requirement.table,
            requirement.index
        );
    }
    for detail in plan {
        let words: Vec<_> = detail.split_whitespace().collect();
        if words.first() == Some(&"SCAN") {
            ensure!(
                exceptions.iter().any(|exception| {
                    !matches!(exception.kind, ExceptionKind::ReviewedLegacySort)
                        && words.get(1) == Some(&exception.table)
                }),
                "unrestricted scan: {detail}"
            );
        }
        if detail.contains("TEMP B-TREE") {
            ensure!(
                exceptions
                    .iter()
                    .any(|exception| matches!(exception.kind, ExceptionKind::ReviewedLegacySort)),
                "temporary B-tree: {detail}"
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Result<(tempfile::TempDir, Connection)> {
        let dir = tempfile::tempdir()?;
        let mut db = Connection::open(dir.path().join("plan.db"))?;
        db.execute_batch("CREATE TABLE events(id INTEGER PRIMARY KEY, family TEXT NOT NULL, ts INTEGER NOT NULL, payload TEXT); CREATE INDEX events_family_ts ON events(family,ts); CREATE TABLE config(value TEXT);")?;
        let tx = db.transaction()?;
        for id in 0..10_000 {
            tx.execute(
                "INSERT INTO events VALUES(?1,?2,?3,?4)",
                rusqlite::params![
                    id,
                    if id % 101 == 0 { "rare" } else { "common" },
                    id / 3,
                    format!("value-{}", id % 17)
                ],
            )?;
        }
        tx.execute("INSERT INTO config VALUES('one'),('two')", [])?;
        tx.commit()?;
        db.execute_batch("ANALYZE")?;
        Ok((dir, db))
    }

    #[test]
    fn bound_indexed_search_and_failures() -> Result<()> {
        let (_dir, db) = fixture()?;
        let plan = query_plan(
            &db,
            "SELECT payload FROM events WHERE family=?1 AND ts>=?2 ORDER BY ts",
            rusqlite::params!["rare", 3000],
        )?;
        validate(
            &plan,
            &[RequiredSearch {
                table: "events",
                index: Some("events_family_ts"),
            }],
            &[],
        )?;
        assert!(
            validate(
                &plan,
                &[RequiredSearch {
                    table: "events",
                    index: Some("events_family")
                }],
                &[]
            )
            .is_err()
        );
        assert!(
            validate(
                &plan,
                &[RequiredSearch {
                    table: "event",
                    index: None
                }],
                &[]
            )
            .is_err()
        );
        let scan = query_plan(
            &db,
            "SELECT payload FROM events WHERE payload=?1",
            ["value-1"],
        )?;
        assert!(validate(&scan, &[], &[]).is_err());
        let sort = query_plan(
            &db,
            "SELECT payload FROM events WHERE family=?1 ORDER BY payload",
            ["rare"],
        )?;
        assert!(validate(&sort, &[], &[]).is_err());
        validate(
            &sort,
            &[],
            &[Exception {
                kind: ExceptionKind::ReviewedLegacySort,
                table: "",
                reason: "legacy payload order retained until indexed owner migration",
            }],
        )?;
        Ok(())
    }

    #[test]
    fn explicit_exceptions() -> Result<()> {
        let (_dir, db) = fixture()?;
        for (sql, table, kind, reason) in [
            (
                "SELECT * FROM events LIMIT 0",
                "events",
                ExceptionKind::LimitZero,
                "metadata-only query executes no rows",
            ),
            (
                "SELECT * FROM events ORDER BY id DESC LIMIT 10",
                "events",
                ExceptionKind::BoundedRowidWalk,
                "newest ten rowids, no predicate that could extend the walk",
            ),
            (
                "SELECT * FROM config",
                "config",
                ExceptionKind::SmallWholeSetRead,
                "two-row complete configuration set",
            ),
        ] {
            let plan = query_plan(&db, sql, [])?;
            assert!(validate(&plan, &[], &[]).is_err());
            validate(
                &plan,
                &[],
                &[Exception {
                    kind,
                    table,
                    reason,
                }],
            )?;
            assert!(
                validate(
                    &plan,
                    &[],
                    &[Exception {
                        kind,
                        table,
                        reason: " "
                    }]
                )
                .is_err()
            );
            assert!(
                validate(
                    &plan,
                    &[],
                    &[Exception {
                        kind,
                        table: "unrelated",
                        reason
                    }]
                )
                .is_err()
            );
        }
        Ok(())
    }
}
