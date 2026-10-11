use anyhow::{Context, Result};
use rusqlite::{Connection, params};
use shared::{RequestRecord, factory_api::*};
use std::{collections::BTreeMap, path::Path};

pub fn ms_to_seconds(ms: i64) -> i64 {
    ms.div_euclid(1000)
}
pub fn seconds_to_ms(seconds: i64) -> i64 {
    seconds * 1000
}
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
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY, ts_ms INTEGER NOT NULL, record TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts_ms);
        CREATE TABLE IF NOT EXISTS warnings(message TEXT PRIMARY KEY);")?;
    Ok(db)
}
pub fn sync(db: &mut Connection, records: Vec<RequestRecord>) -> Result<Vec<RequestRecord>> {
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let watermark: i64 =
        tx.query_row("SELECT COALESCE(MAX(id),0) FROM requests", [], |r| r.get(0))?;
    let mut previous = watermark;
    let mut new = Vec::new();
    for record in records {
        anyhow::ensure!(record.id > 0, "invalid meter id");
        if record.id > previous + 1 {
            tx.execute(
                "INSERT OR IGNORE INTO warnings VALUES (?1)",
                [format!(
                    "gap: meter ids {}..{} are absent from cursor history",
                    previous + 1,
                    record.id - 1
                )],
            )?;
        }
        previous = previous.max(record.id);
        tx.execute("INSERT INTO requests VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET ts_ms=excluded.ts_ms, record=excluded.record",
            params![record.id, record.ts, serde_json::to_string(&record)?])?;
        if record.id > watermark {
            new.push(record);
        }
    }
    tx.commit()?;
    new.sort_by_key(|r| r.id);
    Ok(new)
}

pub fn spend(
    store: &pricing::Store,
    family: &str,
    model_id: Option<String>,
    records: &[RequestRecord],
) -> Result<SpendAvoided> {
    let history = store.history(
        family,
        records
            .iter()
            .map(|r| ms_to_seconds(r.ts))
            .max()
            .unwrap_or(0),
    )?;
    let mut result = SpendAvoided {
        family: family.into(),
        model_id,
        usd: 0.0,
        estimated_usd: 0.0,
        unpriced_requests: 0,
    };
    for record in records {
        let (Some(prompt), Some(output)) = (record.prompt_eval_count, record.eval_count) else {
            result.unpriced_requests += 1;
            continue;
        };
        match history.rates_at(ms_to_seconds(record.ts)) {
            Some((input, output_rate)) => {
                result.usd += (prompt as f64 * input + output as f64 * output_rate) / 1_000_000.0
            }
            None => {
                if let Some((input, output_rate)) = history.earliest {
                    result.estimated_usd +=
                        (prompt as f64 * input + output as f64 * output_rate) / 1_000_000.0;
                } else {
                    result.unpriced_requests += 1;
                }
            }
        }
    }
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
        .show(references, ms_to_seconds(crate::now_ms()))?
        .into_iter()
        .map(|s| Family {
            family: s.family,
            selected: s.selected.map(|s| Selection {
                model_id: s.model_id,
                effective_from_ms: seconds_to_ms(s.effective_from),
            }),
            pending: s.pending.map(|s| Selection {
                model_id: s.model_id,
                effective_from_ms: seconds_to_ms(s.effective_from),
            }),
            rates: s.rates.map(|r| Rates {
                input_per_mtok: r.model.input_per_mtok,
                output_per_mtok: r.model.output_per_mtok,
                source: r.source,
                fetched_at_ms: seconds_to_ms(r.fetched_at),
            }),
        })
        .collect();
    Ok(Pricing { families, warnings })
}
pub fn usage(
    db: &Connection,
    store: &pricing::Store,
    range: String,
    since: i64,
    mut warnings: Vec<String>,
) -> Result<Usage> {
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
    let totals = Totals {
        requests: records.len(),
        prompt_tokens: records.iter().filter_map(|r| r.prompt_eval_count).sum(),
        output_tokens: records.iter().filter_map(|r| r.eval_count).sum(),
    };
    let references = pricing::parse_references(pricing::DEFAULT_CONFIG)?;
    let spend_avoided = store
        .show(&references, ms_to_seconds(crate::now_ms()))?
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
        assert_eq!(ms_to_seconds(1_791_695_440_999), 1_791_695_440);
        assert_eq!(seconds_to_ms(1_791_695_440), 1_791_695_440_000);
        assert_eq!(ns_to_ms(2_750_000), 2.75);
        assert_eq!(tps(Some(23), Some(2_000_000_000)), Some(11.5));
        assert_eq!(tps(Some(23), Some(0)), None);
        assert_eq!(tps(None, Some(100)), None);
    }
    #[test]
    fn priced_estimated_unpriced_and_missing_tokens() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("pricing.db");
        let mut store = pricing::Store::open(&path)?;
        let references = pricing::parse_references("[[reference]]\nname='test'\nmatch='^model$'")?;
        let model = pricing::Model {
            model_id: "model".into(),
            input_per_mtok: 2.0,
            output_per_mtok: 8.0,
            released_at: Some(1),
        };
        store.refresh(&references, std::slice::from_ref(&model), &[], 100, vec![])?;
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
        store.confirm("test", 110)?;
        // Later rates must not leak into either historical cost or pre-history estimates.
        let later = pricing::Model {
            input_per_mtok: 9.0,
            output_per_mtok: 30.0,
            ..model
        };
        store.refresh(&references, &[later], &[], 130, vec![])?;
        let spend = spend(&store, "test", Some("model".into()), &rows)?;
        assert_eq!(
            (spend.usd, spend.estimated_usd, spend.unpriced_requests),
            (6.5, 5.5, 2)
        );
        Ok(())
    }

    #[test]
    fn bulk_query_count_is_constant_and_hot_queries_use_indexes() -> Result<()> {
        use rusqlite::trace::{TraceEvent, TraceEventCodes};
        use std::cell::RefCell;
        thread_local! { static QUERIES: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) }; }
        fn trace(event: TraceEvent<'_>) {
            if let TraceEvent::Stmt(statement, sql) = event
                && sql.trim_start().starts_with("SELECT")
            {
                QUERIES.with_borrow_mut(|queries| queries.push(statement.expanded_sql().unwrap()));
            }
        }
        let temp = tempfile::tempdir()?;
        let mut db = open(&temp.path().join("requests.db"))?;
        let pricing_path = temp.path().join("pricing.db");
        let mut writer = pricing::Store::open(&pricing_path)?;
        let references = pricing::parse_references(pricing::DEFAULT_CONFIG)?;
        let model = pricing::Model {
            model_id: "anthropic/claude-sonnet-5.5".into(),
            input_per_mtok: 2.0,
            output_per_mtok: 7.0,
            released_at: Some(1),
        };
        writer.refresh(&references, std::slice::from_ref(&model), &[], 10, vec![])?;
        writer.confirm("Claude Sonnet", 20)?;
        let secondary = pricing::Model {
            input_per_mtok: 90.0,
            ..model.clone()
        };
        // Same-second refresh and source ties must choose the latest refresh's primary rate.
        writer.refresh(
            &references,
            &[pricing::Model {
                input_per_mtok: 1.0,
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
            input_per_mtok: 5.0,
            ..model.clone()
        };
        writer.refresh(&references, &[newer], &[], 40, vec![])?;
        writer.confirm("Claude Sonnet", 50)?;
        let history = Connection::open(&pricing_path)?;
        history.trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(trace));
        let reader = pricing::Store::reader(history)?;
        db.trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(trace));
        let row = |id| RequestRecord {
            id,
            ts: 30_000,
            endpoint: "/api/chat".into(),
            prompt_eval_count: Some(1_000_000),
            eval_count: Some(2_000_000),
            ..Default::default()
        };
        let mut counts = vec![];
        for count in [1, 1000] {
            sync(&mut db, (1..=count).map(row).collect())?;
            QUERIES.with_borrow_mut(Vec::clear);
            let result = usage(&db, &reader, "30d".into(), 0, vec![])?;
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
            let queries = QUERIES.with_borrow(|q| q.clone());
            counts.push(queries.len());
        }
        assert_eq!(counts[0], counts[1], "per-row SQL returned: {counts:?}");
        assert!(counts[1] <= 20, "unexpected bulk query count: {counts:?}");
        pricing_view(&reader, &references, vec![])?;
        let queries = QUERIES.with_borrow(|q| q.clone());
        let prices = Connection::open(pricing_path)?;
        for sql in queries.iter().chain(std::iter::once(
            &"SELECT COALESCE(MAX(id),0) FROM requests".to_owned(),
        )) {
            let connection = if sql.contains("FROM requests") || sql.contains("FROM warnings") {
                &db
            } else {
                &prices
            };
            let plan = connection
                .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?
                .query_map([], |r| r.get::<_, String>(3))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert!(
                !plan
                    .iter()
                    .any(|line| line.starts_with("SCAN ") && !line.contains("USING")),
                "full table scan: {sql}\n{plan:?}"
            );
        }
        // The model switch is effective at 50, never at its earlier observation.
        let history = reader.history("Claude Sonnet", 60)?;
        assert_eq!(history.rates_at(19), None);
        assert_eq!(history.rates_at(20), Some((2.0, 7.0)));
        assert_eq!(history.rates_at(49), Some((2.0, 7.0)));
        assert_eq!(history.rates_at(50), Some((5.0, 7.0)));
        eprintln!(
            "usage SELECT count: 1 row={}, 1000 rows={}; all hot query plans indexed",
            counts[0], counts[1]
        );
        Ok(())
    }
}
