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
    let db = Connection::open(path)?;
    factory_db::settings::apply(&db, false, 65_536)?;
    initialize(&db)?;
    Ok(db)
}
pub fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY, ts_ms INTEGER NOT NULL, record TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts_ms);
        CREATE TABLE IF NOT EXISTS warnings(message TEXT PRIMARY KEY);")?;
    Ok(())
}
pub fn sync(db: &mut Connection, records: Vec<RequestRecord>) -> Result<Vec<RequestRecord>> {
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let watermark: i64 =
        tx.query_row("SELECT COALESCE(MAX(id),0) FROM requests", [], |r| r.get(0))?;
    let mut previous = watermark;
    let mut warnings = Vec::new();
    for record in &records {
        anyhow::ensure!(record.id > 0, "invalid meter id");
        if record.id > previous.saturating_add(1) {
            warnings.push(format!(
                "gap: meter ids {}..{} are absent from cursor history",
                previous + 1,
                record.id - 1
            ));
        }
        previous = previous.max(record.id);
    }
    for chunk in warnings.chunks(100) {
        let values = std::iter::repeat_n("(?)", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        tx.execute(
            &format!("INSERT OR IGNORE INTO warnings VALUES {values}"),
            rusqlite::params_from_iter(chunk),
        )?;
    }
    for chunk in records.chunks(100) {
        let values = std::iter::repeat_n("(?,?,?)", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let mut parameters = Vec::<rusqlite::types::Value>::with_capacity(chunk.len() * 3);
        for record in chunk {
            parameters.extend([
                record.id.into(),
                record.ts.into(),
                serde_json::to_string(record)?.into(),
            ]);
        }
        tx.execute(&format!("INSERT INTO requests VALUES {values} ON CONFLICT(id) DO UPDATE SET ts_ms=excluded.ts_ms, record=excluded.record"), rusqlite::params_from_iter(parameters))?;
    }
    tx.commit()?;
    let mut new: Vec<_> = records
        .into_iter()
        .filter(|record| record.id > watermark)
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
    let mut statement =
        db.prepare("SELECT record FROM requests WHERE ts_ms>=?1 ORDER BY ts_ms,id")?;
    let mut rows = statement.query([since])?;
    let mut records = Vec::new();
    while let Some(row) = rows.next()? {
        let record: RequestRecord = serde_json::from_str(row.get_ref(0)?.as_str()?)?;
        if crate::INFERENCE_ENDPOINTS.contains(&record.endpoint.as_str()) {
            records.push(record);
        }
    }
    warnings.extend(
        db.prepare("SELECT message FROM warnings ORDER BY message")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?,
    );
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
            ..Default::default()
        };
        let mut counts = vec![];
        let mut queries = Vec::new();
        for count in [1, 1000] {
            db.run(&Scope::default(), Category::Setup, |db| {
                sync(db, (1..=count).map(row).collect())
            })?;
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
