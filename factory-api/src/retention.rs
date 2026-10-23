//! 365-day raw request retention for the API copy (MET-206, docs/data-model.md).
//! Rows are deleted only when the verified request rollup, the cost backfill
//! and frozen costs all cover them, so usage and spend for every range stay
//! identical. Deleting a request cascades to its `request_costs`.
use crate::costs;
use anyhow::Result;
use factory_db::rollup;
use rusqlite::{Connection, TransactionBehavior, params};

pub const RETENTION_MS: i64 = 365 * rollup::DAY_MS;
/// Requests per retention statement; each batch is its own writer job.
pub const BATCH: usize = 2_000;
pub const BATCHES_PER_RUN: usize = 50;

#[derive(Debug, PartialEq, Eq)]
pub enum Prune {
    /// No cached request is older than the cutoff.
    Nothing,
    /// At least one gate is unmet; nothing was deleted.
    Refused(String),
    Deleted(usize),
}

/// Unmet gates for deleting every request up to `expired`, the highest
/// expired ID. Empty when pruning is safe.
fn unmet(db: &Connection, expired: i64) -> Result<Vec<String>> {
    let mut reasons = vec![];
    match rollup::state(db, crate::rollups::JOB)? {
        Some(s) if s.verified_at_ms.is_some() && s.last_id >= expired => {}
        Some(s) if s.verified_at_ms.is_some() => reasons.push(format!(
            "rollup behind: expired request id {expired} is above the verified checkpoint {}",
            s.last_id
        )),
        _ => reasons
            .push("rollup unverified: the request rollup has not passed its raw comparison".into()),
    }
    let states = costs::states(db)?;
    for family in costs::families()? {
        match states.iter().find(|s| s.family == family) {
            Some(s) if s.completed_at_ms.is_some() => {
                let walking = s.after_id < s.target_id && s.after_id < expired;
                let fill_in = s.unpriced_from_id.is_some_and(|id| id <= expired);
                if walking || fill_in {
                    reasons.push(format!(
                        "costs not frozen: {family} classifications through id {expired} may still change (after_id {}, target_id {}, unpriced_from_id {:?})",
                        s.after_id, s.target_id, s.unpriced_from_id
                    ));
                }
            }
            _ => reasons.push(format!(
                "backfill incomplete: {family} cost backfill has no completion time"
            )),
        }
    }
    Ok(reasons)
}

/// One bounded retention transaction: the gates and the delete see the same
/// state. Rows at exactly the cutoff are kept.
pub fn prune(db: &mut Connection, cutoff_ms: i64) -> Result<Prune> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let Some(expired) = tx.query_row(
        "SELECT MAX(id) FROM requests INDEXED BY requests_ts WHERE ts_ms<?1",
        [cutoff_ms],
        |r| r.get::<_, Option<i64>>(0),
    )?
    else {
        return Ok(Prune::Nothing);
    };
    let reasons = unmet(&tx, expired)?;
    if !reasons.is_empty() {
        return Ok(Prune::Refused(reasons.join("; ")));
    }
    let deleted = tx.execute(
        "DELETE FROM requests WHERE id IN (SELECT id FROM requests INDEXED BY requests_ts WHERE ts_ms<?1 AND id<=?2 LIMIT ?3)",
        params![cutoff_ms, expired, BATCH as i64],
    )?;
    tx.commit()?;
    Ok(Prune::Deleted(deleted))
}
