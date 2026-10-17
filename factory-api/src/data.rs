use crate::types::*;
use anyhow::{Context, Result};
use factory_db::{money::NanoUsd, rollup};
use rusqlite::Connection;
use shared::RequestRecord;
use std::{collections::BTreeMap, path::Path};

pub fn ns_to_ms(ns: u64) -> f64 {
    ns as f64 / 1_000_000.0
}
pub fn tps(tokens: Option<u64>, ns: Option<u64>) -> Option<f64> {
    match (tokens, ns) {
        (Some(tokens), Some(ns)) if ns > 0 => Some(tokens as f64 / (ns as f64 / 1e9)),
        _ => None,
    }
}
pub fn open(path: &Path) -> Result<Connection> {
    verify_path(path)?;
    let mut db = Connection::open(path)?;
    factory_db::settings::apply(&db, false, 65_536)?;
    initialize(&mut db)?;
    Ok(db)
}

/// Check before pool settings can write to an existing database.
pub fn verify_path(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let empty = factory_db::migrations::schema_fingerprint(&db)?.is_empty();
    anyhow::ensure!(
        version == 6 || (version == 0 && empty),
        "requests requires user_version=6, found {version}; stop factory-api, take a verified backup, then run factory-api migrate --requests-db <path>"
    );
    Ok(())
}

const V6: &str = include_str!("requests_v6.sql");

/// Offline only for existing databases. Runtime may initialize a fresh file.
pub fn initialize(db: &mut Connection) -> Result<()> {
    use factory_db::migrations::{LegacySchema, Migration, run, schema_fingerprint};
    let from: u32 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let legacy = Connection::open_in_memory()?;
    legacy.execute_batch(include_str!("requests_legacy.sql"))?;
    // PRAGMA optimize on the deployed cache may already have created sqlite_stat1.
    if db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='sqlite_stat1')",
        [],
        |r| r.get::<_, bool>(0),
    )? {
        legacy.execute_batch("ANALYZE")?;
    }
    run(
        db,
        &[
            Migration {
                version: 1,
                sql: include_str!("ups_schema.sql"),
                checksum: 0xf7820cc3e88268c1,
            },
            Migration {
                version: 2,
                sql: include_str!("devices_schema.sql"),
                checksum: 0xec390e5b72cf3828,
            },
            Migration {
                version: 3,
                sql: include_str!("network_schema.sql"),
                checksum: 0xeafe4295b7f9e60f,
            },
            Migration {
                version: 4,
                sql: include_str!("requests_v4.sql"),
                checksum: 0x27c842b5b0708030,
            },
            Migration {
                version: 5,
                sql: include_str!("requests_v5.sql"),
                checksum: 0xc09d8eb6bc540f70,
            },
            Migration {
                version: 6,
                sql: V6,
                checksum: 0xbcc07fc3ad3e0747,
            },
        ],
        Some(LegacySchema {
            fingerprint: &schema_fingerprint(&legacy)?,
            version: 0,
        }),
        |_, _| Ok(()),
        |tx, _| {
            if from < 4 {
                let messages = tx
                    .prepare("SELECT message FROM warnings_before_v4")?
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let now = crate::now_ms();
                for message in messages {
                    let range = message
                        .strip_prefix("gap: meter ids ")
                        .and_then(|s| s.split_once(' '))
                        .and_then(|(s, _)| s.split_once(".."))
                        .and_then(|(a, b)| Some((a.parse::<i64>().ok()?, b.parse::<i64>().ok()?)))
                        .filter(|(a, b)| *a > 0 && b >= a);
                    tx.execute(
                        "INSERT INTO warnings VALUES (?1,?2,?2,NULL,?3,?4)",
                        rusqlite::params![message, now, range.map(|r| r.0), range.map(|r| r.1)],
                    )?;
                }
            }
            if from < 5 {
                crate::costs::seed(tx, &crate::costs::families()?, crate::now_ms())?;
            }
            Ok(())
        },
    )?;
    Ok(())
}

pub const REQUEST_COLUMNS: &str = "id,ts_ms,endpoint,model,prompt_eval_count,eval_count,load_duration_ns,prompt_eval_duration_ns,eval_duration_ns,total_duration_ns,usage_json,latency_ms,status,stream,error,client_ip,client_hostname,user_key,actor_kind";

/// Store one meter page with its frozen costs (see costs::freeze) atomically.
pub fn sync(
    db: &mut Connection,
    records: Vec<RequestRecord>,
    costs: &[crate::costs::Cost],
) -> Result<Vec<RequestRecord>> {
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let (watermark, rebuilding, replay_through): (i64, bool, i64) = tx.query_row(
        "SELECT last_after_id,rebuilding,replay_through_id FROM sync_state WHERE id=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let now = crate::now_ms();
    let mut previous = watermark;
    let mut warnings = Vec::new();
    for record in &records {
        anyhow::ensure!(
            record.id > previous && record.latency_ms.is_finite(),
            "invalid meter record"
        );
        if record.id > previous.saturating_add(1) {
            warnings.push((
                format!(
                    "gap: meter ids {}..{} are absent from cursor history",
                    previous + 1,
                    record.id - 1
                ),
                previous + 1,
                record.id - 1,
            ));
        }
        previous = record.id;
    }
    for chunk in warnings.chunks(100) {
        let values = std::iter::repeat_n("(?,?,?,?,?)", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let parameters: Vec<rusqlite::types::Value> = chunk
            .iter()
            .flat_map(|(message, a, b)| {
                [
                    message.clone().into(),
                    now.into(),
                    now.into(),
                    (*a).into(),
                    (*b).into(),
                ]
            })
            .collect();
        tx.execute(
            &format!("INSERT OR IGNORE INTO warnings(message,first_seen_ms,last_seen_ms,first_id,last_id) VALUES {values}"),
            rusqlite::params_from_iter(parameters),
        )?;
    }
    for chunk in records.chunks(100) {
        let values = std::iter::repeat_n("(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let mut parameters = Vec::<rusqlite::types::Value>::with_capacity(chunk.len() * 19);
        let integer = |v: Option<u64>| -> Result<rusqlite::types::Value> {
            Ok(v.map(i64::try_from).transpose()?.into())
        };
        for r in chunk {
            parameters.extend([
                r.id.into(),
                r.ts.into(),
                r.endpoint.clone().into(),
                r.model.clone().into(),
                integer(r.prompt_eval_count)?,
                integer(r.eval_count)?,
                integer(r.load_duration)?,
                integer(r.prompt_eval_duration)?,
                integer(r.eval_duration)?,
                integer(r.total_duration)?,
                r.usage
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?
                    .into(),
                r.latency_ms.into(),
                i64::from(r.status).into(),
                i64::from(r.stream).into(),
                r.error.clone().into(),
                r.client_ip.clone().into(),
                r.client_hostname.clone().into(),
                r.user_key.clone().into(),
                r.actor_kind
                    .as_deref()
                    .unwrap_or("unattributed")
                    .to_owned()
                    .into(),
            ]);
        }
        tx.execute(
            &format!("INSERT INTO requests({REQUEST_COLUMNS}) VALUES {values}"),
            rusqlite::params_from_iter(parameters),
        )?;
    }
    crate::costs::store(&tx, costs, now)?;
    if records.is_empty() {
        // A successful new poll alone is not recovery: every ID must be present.
        tx.execute("UPDATE warnings SET resolved_at_ms=?1,last_seen_ms=?1 WHERE resolved_at_ms IS NULL AND first_id IS NOT NULL AND (SELECT COUNT(*) FROM requests WHERE id BETWEEN first_id AND last_id)=last_id-first_id+1", [now])?;
        if rebuilding {
            let missing: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM requests_before_v4 old LEFT JOIN requests new ON new.id=old.id WHERE new.id IS NULL)", [], |r| r.get(0))?;
            if missing {
                tx.execute("INSERT OR IGNORE INTO warnings(message,first_seen_ms,last_seen_ms) VALUES('gap: previously cached meter requests are absent from replay',?1,?1)", [now])?;
            }
        }
    }
    tx.execute("UPDATE sync_state SET last_after_id=?1,synced_at_ms=?2,rebuilding=CASE WHEN ?3 THEN 0 ELSE rebuilding END WHERE id=1", rusqlite::params![previous,now,records.is_empty()])?;
    tx.commit()?;
    let mut new: Vec<_> = records
        .into_iter()
        .filter(|record| !rebuilding && record.id > watermark.max(replay_through))
        .collect();
    new.sort_by_key(|r| r.id);
    Ok(new)
}

pub fn pricing_view(
    store: &pricing::Store,
    references: &[pricing::Reference],
    warnings: Vec<String>,
) -> Result<Pricing> {
    let mut warnings = warnings;
    warnings.extend(
        store
            .items()?
            .into_iter()
            .filter(|i| i.kind == "warning")
            .map(|i| format!("{}: {}", i.family, i.message)),
    );
    let families = store
        .show(references, crate::now_ms())?
        .into_iter()
        .map(|s| Family {
            family: s.family,
            selected: s.selected.map(|s| Selection {
                model_id: s.model_id,
                effective_from_ms: s.effective_from_ms,
            }),
            pending: s.pending.map(|s| Selection {
                model_id: s.model_id,
                effective_from_ms: s.effective_from_ms,
            }),
            rates: s.rates.map(|r| Rates {
                input_per_mtok: r.model.input_micro_usd_per_mtok as f64 / 1_000_000.0,
                output_per_mtok: r.model.output_micro_usd_per_mtok as f64 / 1_000_000.0,
                source: r.source,
                fetched_at_ms: r.fetched_at_ms,
            }),
        })
        .collect();
    Ok(Pricing { families, warnings })
}
/// Frozen spend for one family over a usage range, summed with checked arithmetic.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct FrozenSpend {
    pub priced: NanoUsd,
    pub estimated: NanoUsd,
    pub priced_requests: usize,
    pub estimated_requests: usize,
}

/// Usage for one range from a single requests-DB read snapshot.
#[derive(Debug, Default)]
pub struct UsageRows {
    pub models: BTreeMap<Option<String>, rollup::Summary>,
    pub spend: BTreeMap<String, FrozenSpend>,
    pub warnings: Vec<String>,
    pub approximate: bool,
}

/// Rollups plus a disjoint raw edge, in one read snapshot: five statements
/// regardless of history. Daily rows cover whole UTC days from the first day
/// boundary, hourly rows the hours before it, and raw rows the partial first
/// hour plus everything above the verified checkpoint. Ranges up to 30 days
/// read exact nearest-rank percentiles from the covering latency index;
/// longer ranges merge fixed-bucket histograms and are flagged approximate.
pub fn usage_records(
    db: &Connection,
    since: i64,
    approximate: bool,
    mut warnings: Vec<String>,
) -> Result<UsageRows> {
    let window = rollup::Window::new(since);
    let inference = format!(" AND endpoint IN ({})", crate::rollups::inference_list());
    let rollups = db
        .prepare(&rollup::rollup_sql(&inference))?
        .query_map([window.hour, window.day], |r| {
            Ok((r.get::<_, Option<String>>(1)?, rollup::agg(r, 2)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let families = crate::costs::families()?;
    let mut spend: Vec<FrozenSpend> = vec![FrozenSpend::default(); families.len()];
    let mut add = |family: &str, status: &str, nano: Option<i64>, n: i64| -> Result<()> {
        let Some(total) = families
            .iter()
            .position(|f| f == family)
            .map(|i| &mut spend[i])
        else {
            return Ok(());
        };
        let n = usize::try_from(n)?;
        match (status, nano) {
            ("priced", Some(cost)) => {
                total.priced = total.priced.checked_add(NanoUsd(cost))?;
                total.priced_requests += n;
            }
            ("estimated", Some(cost)) => {
                total.estimated = total.estimated.checked_add(NanoUsd(cost))?;
                total.estimated_requests += n;
            }
            _ => {}
        }
        Ok(())
    };
    let verified =
        "EXISTS(SELECT 1 FROM rollup_state WHERE job='requests' AND verified_at_ms IS NOT NULL)";
    let columns = "family,priced_nano_usd,estimated_nano_usd,priced_requests,estimated_requests";
    let mut statement = db.prepare(&format!(
        "SELECT {columns} FROM spend_hourly WHERE bucket_ms>=?1 AND bucket_ms<?2 AND {verified}{inference}
         UNION ALL SELECT {columns} FROM spend_daily WHERE bucket_ms>=?2 AND {verified}{inference}"
    ))?;
    let mut rows = statement.query([window.hour, window.day])?;
    while let Some(r) = rows.next()? {
        let family = r.get_ref(0)?.as_str()?;
        add(family, "priced", Some(r.get(1)?), r.get(3)?)?;
        add(family, "estimated", Some(r.get(2)?), r.get(4)?)?;
    }
    drop(rows);
    drop(statement);
    // Raw edge with its frozen costs: one row per (request, family), or one
    // row with NULL family for a request not yet classified.
    let mut edge = Vec::<rollup::Raw>::new();
    let mut statement = db.prepare(&rollup::edge_sql(
        &format!(
            "{},c.family,c.cost_status,c.cost_nano_usd",
            rollup::raw_columns("r")
        ),
        "LEFT JOIN request_costs c ON c.request_id=r.id",
        &format!(" AND r.endpoint IN ({})", crate::rollups::inference_list()),
    ))?;
    let mut rows = statement.query([since, window.hour])?;
    while let Some(r) = rows.next()? {
        let raw = rollup::raw(r)?;
        if edge.last().is_none_or(|last| last.id != raw.id) {
            edge.push(raw);
        }
        if let Some(family) = r.get_ref(rollup::RAW_WIDTH)?.as_str_or_null()? {
            add(
                family,
                r.get_ref(rollup::RAW_WIDTH + 1)?.as_str()?,
                r.get(rollup::RAW_WIDTH + 2)?,
                1,
            )?;
        }
    }
    drop(rows);
    drop(statement);
    let latencies = if approximate {
        rollup::Latencies::Approximate(
            db.prepare(&rollup::histogram_sql(&format!(
                " AND dimension_key->>0 IN ({})",
                crate::rollups::inference_list()
            )))?
            .query_map([window.hour, window.day], |r| {
                Ok((r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? as u64))
            })?
            .collect::<rusqlite::Result<_>>()?,
        )
    } else {
        rollup::Latencies::Exact(
            db.prepare(&format!(
                "SELECT model,total_duration_ns,latency_ms FROM requests INDEXED BY requests_ts_latency
                 WHERE ts_ms>=?1{inference}"
            ))?
            .query_map([since], |r| {
                Ok((r.get(0)?, rollup::latency_ms(r.get(1)?, r.get(2)?)))
            })?
            .collect::<rusqlite::Result<_>>()?,
        )
    };
    let models = rollup::summarize(rollups, &edge, latencies, crate::rollups::TPS)?;
    warnings.extend(
        db.prepare("SELECT message FROM warnings WHERE resolved_at_ms IS NULL UNION ALL SELECT 'meter: rebuilding request history; usage is incomplete' FROM sync_state WHERE id=1 AND rebuilding=1 UNION ALL SELECT 'costs: frozen request costs are backfilling; spend is incomplete' WHERE EXISTS(SELECT 1 FROM cost_backfill WHERE completed_at_ms IS NULL OR after_id<target_id)")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?,
    );
    warnings.sort();
    Ok(UsageRows {
        models: models
            .into_iter()
            .filter(|(_, m)| m.agg.requests > 0)
            .collect(),
        spend: families.into_iter().zip(spend).collect(),
        warnings,
        approximate,
    })
}

/// Selected reference model per family at `at_ms`, in configuration order:
/// one statement for every family, with pricing's own tie order.
pub fn selected_models(
    store: &pricing::Store,
    families: &[String],
    at_ms: i64,
) -> Result<Vec<(String, Option<String>)>> {
    if families.is_empty() {
        return Ok(vec![]);
    }
    let sql = (1..=families.len())
        .map(|i| {
            format!(
                "SELECT {i},(SELECT model_id FROM reference_selection WHERE family=?{i} AND confirmed=1 AND effective_from_ms<=?{at}
                   ORDER BY effective_from_ms DESC,id DESC LIMIT 1)",
                at = families.len() + 1
            )
        })
        .collect::<Vec<_>>()
        .join(" UNION ALL ");
    let mut values: Vec<rusqlite::types::Value> =
        families.iter().map(|f| f.clone().into()).collect();
    values.push(at_ms.into());
    let mut selected: Vec<(usize, Option<String>)> = store
        .connection()
        .prepare(&sql)?
        .query_map(rusqlite::params_from_iter(values), |r| {
            Ok((r.get::<_, i64>(0)? as usize, r.get(1)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    selected.sort_by_key(|(i, _)| *i);
    Ok(selected
        .into_iter()
        .map(|(i, model)| (families[i - 1].clone(), model))
        .collect())
}

pub fn usage(store: &pricing::Store, range: String, rows: UsageRows) -> Result<Usage> {
    let requests = rows.models.values().map(|m| m.agg.requests).sum::<i64>();
    let totals = Totals {
        requests: usize::try_from(requests)?,
        prompt_tokens: u64::try_from(
            rows.models
                .values()
                .map(|m| m.agg.input_tokens)
                .sum::<i64>(),
        )?,
        output_tokens: u64::try_from(
            rows.models
                .values()
                .map(|m| m.agg.output_tokens)
                .sum::<i64>(),
        )?,
    };
    let families: Vec<String> = pricing::parse_references(pricing::DEFAULT_CONFIG)?
        .into_iter()
        .map(|r| r.name)
        .collect();
    let spend_avoided = selected_models(store, &families, crate::now_ms())?
        .into_iter()
        .map(|(family, model_id)| {
            let frozen = rows.spend.get(&family).copied().unwrap_or_default();
            Ok(SpendAvoided {
                model_id,
                usd: frozen.priced.display_usd(),
                estimated_usd: frozen.estimated.display_usd(),
                // Unpriced, or not yet classified while costs backfill (warned).
                unpriced_requests: totals
                    .requests
                    .checked_sub(frozen.priced_requests + frozen.estimated_requests)
                    .context("cost rows exceed inference requests")?,
                family,
            })
        })
        .collect::<Result<_>>()?;
    let models = rows
        .models
        .into_iter()
        .map(|(model, m)| {
            Ok(ModelUsage {
                model,
                requests: usize::try_from(m.agg.requests)?,
                prompt_tokens: u64::try_from(m.agg.input_tokens)?,
                output_tokens: u64::try_from(m.agg.output_tokens)?,
                avg_prompt_tps: m.agg.avg_prompt_tps(),
                avg_gen_tps: m.agg.avg_generation_tps(),
                p50_latency_ms: m.p50_ms,
                p95_latency_ms: m.p95_ms,
                total_load_ms: m.agg.load_ns as f64 / 1_000_000.0,
            })
        })
        .collect::<Result<_>>()?;
    Ok(Usage {
        range,
        generated_at_ms: crate::now_ms(),
        totals,
        spend_avoided,
        models,
        warnings: rows.warnings,
        percentiles_approximate: rows.approximate,
    })
}

pub async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(f)
        .await
        .context("blocking task failed")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn units_and_tps() {
        assert_eq!(ns_to_ms(2_750_000), 2.75);
        assert_eq!(tps(Some(23), Some(2_000_000_000)), Some(11.5));
        assert_eq!(tps(Some(23), Some(0)), None);
        assert_eq!(tps(None, Some(100)), None);
    }
    use crate::costs::{self, Status};

    #[test]
    fn priced_estimated_unpriced_and_missing_tokens() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("pricing.db");
        pricing::migrate(&path)?;
        let mut store = pricing::Store::open(&path)?;
        let references = pricing::parse_references("[[reference]]\nname='test'\nmatch='^model$'")?;
        let model = pricing::Model {
            model_id: "model".into(),
            input_micro_usd_per_mtok: 2_000_000,
            output_micro_usd_per_mtok: 8_000_000,
            released_at_ms: Some(1),
        };
        store.refresh(
            &references,
            std::slice::from_ref(&model),
            &[],
            100_000,
            vec![],
        )?;
        let rows: [(i64, Option<u64>, Option<u64>); 6] = [
            (120_999, Some(1_000_000), Some(250_000)),
            (99_999, Some(500_000), Some(250_000)),
            (121_000, None, Some(250_000)),
            (121_000, Some(10), None),
            (109_999, Some(250_000), Some(250_000)),
            (110_000, Some(250_000), Some(250_000)),
        ];
        let classify = |store: &pricing::Store| -> Result<Vec<costs::Cost>> {
            let history = costs::History::load(store, "test")?;
            rows.iter()
                .enumerate()
                .map(|(i, (ts, p, o))| costs::classify(&history, i as i64 + 1, *ts, *p, *o))
                .collect()
        };
        // No confirmed selection: unpriced, and complete-token rows await a price.
        let before = classify(&store)?;
        assert!(before.iter().all(|c| c.status == Status::Unpriced));
        assert_eq!(
            before.iter().map(|c| c.awaiting_price).collect::<Vec<_>>(),
            [true, true, false, false, true, true]
        );
        store.confirm("test", 110_000)?;
        // Later rates must not leak into either historical cost or pre-history estimates.
        let later = pricing::Model {
            input_micro_usd_per_mtok: 9_000_000,
            output_micro_usd_per_mtok: 30_000_000,
            ..model
        };
        store.refresh(&references, &[later], &[], 130_000, vec![])?;
        let after = classify(&store)?;
        assert_eq!(
            after
                .iter()
                .map(|c| (c.status, c.nano_usd))
                .collect::<Vec<_>>(),
            [
                (Status::Priced, Some(4_000_000_000)),
                (Status::Estimated, Some(3_000_000_000)),
                (Status::Unpriced, None),
                (Status::Unpriced, None),
                (Status::Estimated, Some(2_500_000_000)),
                (Status::Priced, Some(2_500_000_000)),
            ]
        );
        let first = after[0].provenance.as_ref().unwrap();
        assert_eq!(
            (
                first.model_id.as_str(),
                first.input_micro_usd_per_mtok,
                first.output_micro_usd_per_mtok
            ),
            ("model", 2_000_000, 8_000_000)
        );
        // Estimates carry the earliest confirmed selection and its earliest snapshot.
        assert_eq!(after[1].provenance, after[0].provenance);
        assert!(after[2].provenance.is_none() && !after[2].awaiting_price);
        Ok(())
    }

    #[test]
    fn costs_round_each_request_once_and_refuse_overflow() -> Result<()> {
        let mut store = pricing::Store::in_memory()?;
        let references = pricing::parse_references("[[reference]]\nname='test'\nmatch='^model$'")?;
        let mut model = pricing::Model {
            model_id: "model".into(),
            input_micro_usd_per_mtok: 1500,
            output_micro_usd_per_mtok: 0,
            released_at_ms: Some(1),
        };
        store.refresh(&references, std::slice::from_ref(&model), &[], 10, vec![])?;
        store.confirm("test", 11)?;
        let history = costs::History::load(&store, "test")?;
        let one = costs::classify(&history, 1, 11, Some(1), Some(0))?;
        assert_eq!((one.status, one.nano_usd), (Status::Priced, Some(2)));
        // Two half-up rounded requests total 4, not round(3.0) on aggregate tokens.
        assert_eq!(
            NanoUsd::checked_sum([NanoUsd(2), NanoUsd(one.nano_usd.unwrap())])?,
            NanoUsd(4)
        );
        let early = costs::classify(&history, 2, 10, Some(1), Some(0))?;
        assert_eq!((early.status, early.nano_usd), (Status::Estimated, Some(2)));
        // Zero tokens are a priced zero, never unpriced.
        let zero = costs::classify(&history, 3, 11, Some(0), Some(0))?;
        assert_eq!((zero.status, zero.nano_usd), (Status::Priced, Some(0)));
        model.input_micro_usd_per_mtok = i64::MAX;
        store.refresh(&references, &[model], &[], 12, vec![])?;
        let history = costs::History::load(&store, "test")?;
        // (1000 * i64::MAX + 500) / 1000 fits; one more token does not.
        assert_eq!(
            costs::classify(&history, 4, 12, Some(1000), Some(0))?.nano_usd,
            Some(i64::MAX)
        );
        assert!(costs::classify(&history, 5, 12, Some(1001), Some(0)).is_err());
        Ok(())
    }

    #[test]
    fn bulk_query_count_and_historical_ties() -> Result<()> {
        use factory_db::{Category, Scope, Tracked};
        let temp = tempfile::tempdir()?;
        let db = open(&temp.path().join("requests.db"))?;
        let pricing_path = temp.path().join("pricing.db");
        pricing::migrate(&pricing_path)?;
        let mut writer = pricing::Store::open(&pricing_path)?;
        let references = pricing::parse_references(pricing::DEFAULT_CONFIG)?;
        let model = pricing::Model {
            model_id: "anthropic/claude-sonnet-5.5".into(),
            input_micro_usd_per_mtok: 2_000_000,
            output_micro_usd_per_mtok: 7_000_000,
            released_at_ms: Some(1),
        };
        writer.refresh(&references, std::slice::from_ref(&model), &[], 10, vec![])?;
        writer.confirm("Claude Sonnet", 20)?;
        let secondary = pricing::Model {
            input_micro_usd_per_mtok: 90_000_000,
            ..model.clone()
        };
        // Same-millisecond refresh and source ties choose the latest refresh's primary rate.
        writer.refresh(
            &references,
            &[pricing::Model {
                input_micro_usd_per_mtok: 1_000_000,
                ..model.clone()
            }],
            &[],
            30,
            vec![],
        )?;
        writer.refresh(
            &references,
            std::slice::from_ref(&model),
            &[secondary],
            30,
            vec![],
        )?;
        let newer = pricing::Model {
            model_id: "anthropic/claude-sonnet-6".into(),
            input_micro_usd_per_mtok: 5_000_000,
            ..model.clone()
        };
        writer.refresh(&references, &[newer], &[], 40, vec![])?;
        writer.confirm("Claude Sonnet", 50)?;
        writer.connection().execute_batch(
            "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
             INSERT INTO price_snapshots(fetched_at_ms,source,model_id,input_micro_usd_per_mtok,output_micro_usd_per_mtok,released_at_ms,refresh_id) SELECT x,'openrouter','noise-'||(x%101),2,7,1,1 FROM n;
             WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<3000)
             INSERT INTO reference_selection(family,model_id,effective_from_ms,confirmed,refresh_id) SELECT 'noise-'||(x%37),'noise-'||(x%101),x,1,1 FROM n;
             WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000)
             INSERT INTO refreshes(fetched_at_ms) SELECT x FROM n;
             WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5000)
             INSERT INTO pricing_items(fetched_at_ms,kind,family,message,refresh_id) SELECT x,'warning','noise','fixture',1+x%1000 FROM n;
             ANALYZE;",
        )?;
        let history = Connection::open(&pricing_path)?;
        let mut reader =
            Tracked::new(pricing::Store::reader(history)?, pricing::Store::connection)?;
        let mut db = Tracked::new(db, |db| db)?;
        let row = |id| RequestRecord {
            id,
            ts: 30,
            endpoint: "/api/chat".into(),
            prompt_eval_count: Some(1_000_000),
            eval_count: Some(2_000_000),
            status: 200,
            ..Default::default()
        };
        let mut counts = vec![];
        let mut queries = Vec::new();
        let mut after = 0;
        let families = costs::families()?;
        for count in [1, 1000] {
            let loading = Scope::recording();
            let histories = reader.run(&loading, Category::Data, |store| {
                costs::load(store, &families)
            });
            // Three history reads per family, independent of the page size.
            assert_eq!(loading.counts().data, 3 * families.len());
            queries.extend(loading.statements());
            let mut page: Vec<_> = (after + 1..=count).map(row).collect();
            let (frozen, stopped) = costs::freeze(&histories, &mut page);
            assert!(stopped.is_none());
            db.run(&Scope::default(), Category::Setup, |db| {
                sync(db, page, &frozen)
            })?;
            after = count;
            let scope = Scope::recording();
            let rows = db.run(&scope, Category::Data, |db| {
                usage_records(db, 0, false, vec![])
            })?;
            let result = reader.run(&scope, Category::Data, |store| {
                usage(store, "30d".into(), rows)
            })?;
            assert_eq!(result.totals.requests, count as usize);
            assert_eq!(
                result
                    .spend_avoided
                    .iter()
                    .find(|s| s.family == "Claude Sonnet")
                    .unwrap()
                    .usd,
                count as f64 * 16.0
            );
            counts.push(scope.counts().data);
            reader.run(&scope, Category::Data, |store| {
                pricing_view(store, &references, vec![])
            })?;
            queries.extend(scope.statements());
        }
        // Long ranges swap the exact latency read for merged histograms.
        let scope = Scope::recording();
        let rows = db.run(&scope, Category::Data, |db| {
            usage_records(db, 0, true, vec![])
        })?;
        assert!(rows.approximate);
        assert_eq!(scope.counts().data, ONE_SELECTED_FAMILY_USAGE - 1);
        queries.extend(scope.statements());
        // Rollups, spend, raw edge, latencies and warnings, plus one selected-model read.
        const ONE_SELECTED_FAMILY_USAGE: usize = 6;
        assert_eq!(counts, [ONE_SELECTED_FAMILY_USAGE; 2]);
        // The model switch is effective at 50, never at its earlier observation.
        let history = reader.run(&Scope::default(), Category::Data, |store| {
            store.history("Claude Sonnet", 60)
        })?;
        assert_eq!(history.rates_at(19), None);
        assert_eq!(history.rates_at(20), Some((2_000_000, 7_000_000)));
        assert_eq!(history.rates_at(49), Some((2_000_000, 7_000_000)));
        assert_eq!(history.rates_at(50), Some((5_000_000, 7_000_000)));
        // Frozen-cost provenance selects exactly the rates pricing would.
        let frozen = reader.run(&Scope::default(), Category::Data, |store| {
            costs::History::load(store, "Claude Sonnet")
        })?;
        for at in [0, 9, 10, 19, 20, 29, 30, 31, 39, 40, 49, 50, 60] {
            assert_eq!(
                frozen
                    .at(at)
                    .map(|p| (p.input_micro_usd_per_mtok, p.output_micro_usd_per_mtok)),
                history.rates_at(at),
                "at {at}"
            );
        }
        assert_eq!(
            frozen
                .earliest
                .as_ref()
                .map(|p| (p.input_micro_usd_per_mtok, p.output_micro_usd_per_mtok)),
            history.earliest
        );
        // Replay actual traced templates with bound values, never expanded SQL.
        use factory_db::explain::{self, Exception, ExceptionKind, RequiredSearch};
        db.run(&Scope::default(), Category::Setup, |db| {
            db.execute_batch("ANALYZE")
        })?;
        queries.push("SELECT COALESCE(MAX(id),0) FROM requests".into());
        queries.sort();
        queries.dedup();
        let check = |connection: &Connection, sql: &str| -> Result<()> {
            let mut parameters = Vec::<rusqlite::types::Value>::new();
            let count = connection.prepare(sql)?.parameter_count();
            let requests = ["FROM requests", "FROM request_", "FROM spend_"]
                .iter()
                .any(|t| sql.contains(t));
            if requests {
                // Window bounds: since, then hour/day boundaries.
                parameters.extend((0..count).map(|_| 0.into()));
            } else if sql.starts_with("SELECT 1,(SELECT model_id") {
                // Selected models: every family, then the instant.
                parameters.extend((1..count).map(|_| "Claude Sonnet".to_owned().into()));
                parameters.push(60.into());
            } else if count > 0 {
                parameters.push(if requests {
                    0.into()
                } else if sql.contains("WHERE model_id=?1") {
                    "anthropic/claude-sonnet-5.5".to_owned().into()
                } else {
                    "Claude Sonnet".to_owned().into()
                });
            }
            if count > 1 && !requests && !sql.starts_with("SELECT 1,(SELECT model_id") {
                parameters.push(60.into());
            }
            let plan =
                explain::query_plan(connection, sql, rusqlite::params_from_iter(parameters))?;
            let mut required = Vec::new();
            let mut exceptions = Vec::new();
            if sql.contains("FROM request_hourly") {
                for table in ["request_hourly", "request_daily"] {
                    required.push(RequiredSearch { table, index: None });
                }
            } else if sql.contains("FROM request_latency_hourly") {
                for table in ["request_latency_hourly", "request_latency_daily"] {
                    required.push(RequiredSearch { table, index: None });
                }
            } else if sql.contains("FROM spend_hourly") {
                for table in ["spend_hourly", "spend_daily"] {
                    required.push(RequiredSearch { table, index: None });
                }
            } else if sql.contains("FROM requests r LEFT JOIN request_costs c") {
                // Raw edge: the partial first hour by time, then unrolled ids.
                required.push(RequiredSearch {
                    table: "r",
                    index: Some("requests_ts"),
                });
                required.push(RequiredSearch {
                    table: "c",
                    index: None,
                });
            } else if sql.contains("INDEXED BY requests_ts_latency") {
                required.push(RequiredSearch {
                    table: "requests",
                    index: Some("requests_ts_latency"),
                });
            } else if requests {
                required.push(RequiredSearch {
                    table: "requests",
                    index: sql.contains("ts_ms>=").then_some("requests_ts"),
                });
            } else if sql.contains("FROM warnings") {
                exceptions.push(Exception {
                    kind: ExceptionKind::SmallWholeSetRead,
                    table: "warnings",
                    reason: "complete warning set is part of the API response",
                });
                exceptions.push(Exception {
                    kind: ExceptionKind::SmallWholeSetRead,
                    table: "cost_backfill",
                    reason: "one state row per configured reference family",
                });
            } else if sql.contains("FROM price_snapshots") {
                required.push(RequiredSearch {
                    table: "price_snapshots",
                    index: Some(if sql.contains("ORDER BY fetched_at_ms,refresh_id") {
                        "snapshot_earliest"
                    } else {
                        "snapshot_lookup"
                    }),
                });
            } else if sql.contains("FROM pricing_items") {
                required.push(RequiredSearch {
                    table: "pricing_items",
                    index: Some("items_refresh"),
                });
            } else {
                if sql.starts_with("SELECT 1,(SELECT model_id") {
                    exceptions.push(Exception {
                        kind: ExceptionKind::SmallWholeSetRead,
                        table: "CONSTANT",
                        reason: "one constant row per configured reference family",
                    });
                }
                required.push(RequiredSearch {
                    table: "reference_selection",
                    index: Some(if sql.contains("confirmed=0") {
                        "selection_pending"
                    } else {
                        "selection_lookup"
                    }),
                });
            }
            explain::validate(&plan, &required, &exceptions)
                .with_context(|| format!("{sql}\n{plan:?}"))
        };
        for sql in queries {
            if [
                "FROM requests",
                "FROM request_",
                "FROM spend_",
                "FROM warnings",
            ]
            .iter()
            .any(|t| sql.contains(t))
            {
                db.run(&Scope::default(), Category::Setup, |db| check(db, &sql))?;
            } else {
                reader.run(&Scope::default(), Category::Setup, |store| {
                    check(store.connection(), &sql)
                })?;
            }
        }
        eprintln!("one-selected-family usage: {counts:?}");
        Ok(())
    }
}
