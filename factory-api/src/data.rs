use crate::types::*;
use anyhow::{Context, Result};
use factory_db::money::{MicroUsdPerMtok, NanoUsd, request_cost};
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
        version == 4 || (version == 0 && empty),
        "requests requires user_version=4, found {version}; stop factory-api, take a verified backup, then run factory-api migrate --requests-db <path>"
    );
    Ok(())
}

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
            Ok(())
        },
    )?;
    Ok(())
}

pub const REQUEST_COLUMNS: &str = "id,ts_ms,endpoint,model,prompt_eval_count,eval_count,load_duration_ns,prompt_eval_duration_ns,eval_duration_ns,total_duration_ns,usage_json,latency_ms,status,stream,error,client_ip,client_hostname,user_key,actor_kind";

pub fn sync(db: &mut Connection, records: Vec<RequestRecord>) -> Result<Vec<RequestRecord>> {
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

pub fn spend(
    store: &pricing::Store,
    family: &str,
    model_id: Option<String>,
    records: &[RequestRecord],
) -> Result<SpendAvoided> {
    let history = store.history(family, records.iter().map(|r| r.ts).max().unwrap_or(0))?;
    let mut result = SpendAvoided {
        family: family.into(),
        model_id,
        usd: 0.0,
        estimated_usd: 0.0,
        unpriced_requests: 0,
    };
    let mut priced = NanoUsd::default();
    let mut estimated = NanoUsd::default();
    for record in records {
        let (Some(prompt), Some(output)) = (record.prompt_eval_count, record.eval_count) else {
            result.unpriced_requests += 1;
            continue;
        };
        match history.rates_at(record.ts) {
            Some((input, output_rate)) => {
                priced = priced.checked_add(request_cost(
                    prompt,
                    output,
                    MicroUsdPerMtok(input),
                    MicroUsdPerMtok(output_rate),
                )?)?;
            }
            None => {
                if let Some((input, output_rate)) = history.earliest {
                    estimated = estimated.checked_add(request_cost(
                        prompt,
                        output,
                        MicroUsdPerMtok(input),
                        MicroUsdPerMtok(output_rate),
                    )?)?;
                } else {
                    result.unpriced_requests += 1;
                }
            }
        }
    }
    result.usd = priced.display_usd();
    result.estimated_usd = estimated.display_usd();
    Ok(result)
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
pub fn usage_records(
    db: &Connection,
    since: i64,
    mut warnings: Vec<String>,
) -> Result<(Vec<RequestRecord>, Vec<String>)> {
    let mut statement = db.prepare(&format!(
        "SELECT {REQUEST_COLUMNS} FROM requests WHERE ts_ms>=?1 ORDER BY ts_ms,id"
    ))?;
    let mut rows = statement.query([since])?;
    let mut records = Vec::new();
    while let Some(row) = rows.next()? {
        let unsigned = |column| -> Result<Option<u64>> {
            Ok(row
                .get::<_, Option<i64>>(column)?
                .map(u64::try_from)
                .transpose()?)
        };
        let record = RequestRecord {
            id: row.get(0)?,
            ts: row.get(1)?,
            endpoint: row.get(2)?,
            model: row.get(3)?,
            prompt_eval_count: unsigned(4)?,
            eval_count: unsigned(5)?,
            load_duration: unsigned(6)?,
            prompt_eval_duration: unsigned(7)?,
            eval_duration: unsigned(8)?,
            total_duration: unsigned(9)?,
            usage: row
                .get::<_, Option<String>>(10)?
                .map(|s| serde_json::from_str(&s))
                .transpose()?,
            latency_ms: row.get(11)?,
            status: row.get(12)?,
            stream: row.get(13)?,
            error: row.get(14)?,
            client_ip: row.get(15)?,
            client_hostname: row.get(16)?,
            user_key: row.get(17)?,
            actor_kind: row.get(18)?,
        };
        if crate::INFERENCE_ENDPOINTS.contains(&record.endpoint.as_str()) {
            records.push(record);
        }
    }
    warnings.extend(
        db.prepare("SELECT message FROM warnings WHERE resolved_at_ms IS NULL UNION ALL SELECT 'meter: rebuilding request history; usage is incomplete' FROM sync_state WHERE id=1 AND rebuilding=1")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?,
    );
    warnings.sort();
    Ok((records, warnings))
}

pub fn usage(
    store: &pricing::Store,
    range: String,
    records: Vec<RequestRecord>,
    warnings: Vec<String>,
) -> Result<Usage> {
    let totals = Totals {
        requests: records.len(),
        prompt_tokens: records.iter().filter_map(|r| r.prompt_eval_count).sum(),
        output_tokens: records.iter().filter_map(|r| r.eval_count).sum(),
    };
    let references = pricing::parse_references(pricing::DEFAULT_CONFIG)?;
    let spend_avoided = store
        .show(&references, crate::now_ms())?
        .into_iter()
        .map(|s| spend(store, &s.family, s.selected.map(|s| s.model_id), &records))
        .collect::<Result<_>>()?;
    let mut groups = BTreeMap::<Option<&str>, Vec<&RequestRecord>>::new();
    for record in &records {
        groups
            .entry(record.model.as_deref())
            .or_default()
            .push(record);
    }
    let models = groups
        .into_iter()
        .map(|(model, rows)| {
            let average = |prompt: bool| {
                let (sum, count) = rows
                    .iter()
                    .filter_map(|r| {
                        if prompt {
                            tps(r.prompt_eval_count, r.prompt_eval_duration)
                        } else {
                            tps(r.eval_count, r.eval_duration)
                        }
                    })
                    .fold((0.0, 0usize), |(sum, count), rate| (sum + rate, count + 1));
                (count > 0).then(|| sum / count as f64)
            };
            let mut latencies: Vec<_> = rows
                .iter()
                .map(|r| r.total_duration.map(ns_to_ms).unwrap_or(r.latency_ms))
                .collect();
            latencies.sort_by(f64::total_cmp);
            let percentile = |p: f64| {
                latencies
                    .get((latencies.len() as f64 * p).ceil() as usize - 1)
                    .copied()
            };
            ModelUsage {
                model: model.map(str::to_owned),
                requests: rows.len(),
                prompt_tokens: rows.iter().filter_map(|r| r.prompt_eval_count).sum(),
                output_tokens: rows.iter().filter_map(|r| r.eval_count).sum(),
                avg_prompt_tps: average(true),
                avg_gen_tps: average(false),
                p50_latency_ms: percentile(0.5),
                p95_latency_ms: percentile(0.95),
                total_load_ms: rows
                    .iter()
                    .filter_map(|r| r.load_duration)
                    .map(ns_to_ms)
                    .sum(),
            }
        })
        .collect();
    Ok(Usage {
        range,
        generated_at_ms: crate::now_ms(),
        totals,
        spend_avoided,
        models,
        warnings,
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
        let record = |ts, prompt| RequestRecord {
            ts,
            prompt_eval_count: prompt,
            eval_count: Some(250_000),
            ..Default::default()
        };
        let rows = vec![
            record(120_999, Some(1_000_000)),
            record(99_999, Some(500_000)),
            record(121_000, None),
            RequestRecord {
                eval_count: None,
                ..record(121_000, Some(10))
            },
            record(109_999, Some(250_000)),
            record(110_000, Some(250_000)),
        ];
        assert_eq!(spend(&store, "test", None, &rows)?.unpriced_requests, 6);
        store.confirm("test", 110_000)?;
        // Later rates must not leak into either historical cost or pre-history estimates.
        let later = pricing::Model {
            input_micro_usd_per_mtok: 9_000_000,
            output_micro_usd_per_mtok: 30_000_000,
            ..model
        };
        store.refresh(&references, &[later], &[], 130_000, vec![])?;
        let spend = spend(&store, "test", Some("model".into()), &rows)?;
        assert_eq!(
            (spend.usd, spend.estimated_usd, spend.unpriced_requests),
            (6.5, 5.5, 2)
        );
        Ok(())
    }

    #[test]
    fn spend_rounds_each_request_once_and_checks_totals() -> Result<()> {
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
        let row = RequestRecord {
            ts: 11,
            prompt_eval_count: Some(1),
            eval_count: Some(0),
            ..Default::default()
        };
        let rows = [row.clone(), row.clone()];
        let result = spend(&store, "test", None, &rows)?;
        assert_eq!(result.usd, 0.000000004);
        assert_eq!(result.estimated_usd, 0.0);
        assert_eq!(store.cost("test", 1, 0, 11)?.0, 2);
        let early = [
            RequestRecord {
                ts: 10,
                ..row.clone()
            },
            RequestRecord {
                ts: 10,
                ..row.clone()
            },
        ];
        assert_eq!(
            spend(&store, "test", None, &early)?.estimated_usd,
            0.000000004
        );
        model.input_micro_usd_per_mtok = i64::MAX;
        store.refresh(&references, &[model], &[], 11, vec![])?;
        let large = RequestRecord {
            prompt_eval_count: Some(1000),
            ..row
        };
        assert!(spend(&store, "test", None, &[large.clone(), large.clone()]).is_err());
        assert!(
            spend(
                &store,
                "test",
                None,
                &[RequestRecord {
                    prompt_eval_count: Some(1001),
                    ..large
                }]
            )
            .is_err()
        );
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
        for count in [1, 1000] {
            db.run(&Scope::default(), Category::Setup, |db| {
                sync(db, (after + 1..=count).map(row).collect())
            })?;
            after = count;
            let scope = Scope::recording();
            let (records, warnings) =
                db.run(&scope, Category::Data, |db| usage_records(db, 0, vec![]))?;
            let result = reader.run(&scope, Category::Data, |store| {
                usage(store, "30d".into(), records, warnings)
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
        const ONE_SELECTED_FAMILY_USAGE: usize = 13;
        assert_eq!(counts, [ONE_SELECTED_FAMILY_USAGE; 2]);
        // The model switch is effective at 50, never at its earlier observation.
        let history = reader.run(&Scope::default(), Category::Data, |store| {
            store.history("Claude Sonnet", 60)
        })?;
        assert_eq!(history.rates_at(19), None);
        assert_eq!(history.rates_at(20), Some((2_000_000, 7_000_000)));
        assert_eq!(history.rates_at(49), Some((2_000_000, 7_000_000)));
        assert_eq!(history.rates_at(50), Some((5_000_000, 7_000_000)));
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
            let requests = sql.contains("FROM requests");
            if count > 0 {
                parameters.push(if requests {
                    0.into()
                } else if sql.contains("WHERE model_id=?1") {
                    "anthropic/claude-sonnet-5.5".to_owned().into()
                } else {
                    "Claude Sonnet".to_owned().into()
                });
            }
            if count > 1 {
                parameters.push(60.into());
            }
            let plan =
                explain::query_plan(connection, sql, rusqlite::params_from_iter(parameters))?;
            let mut required = Vec::new();
            let mut exceptions = Vec::new();
            if requests {
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
            if sql.contains("FROM requests") || sql.contains("FROM warnings") {
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
