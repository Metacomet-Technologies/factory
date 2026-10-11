use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
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
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY, ts_ms INTEGER NOT NULL, record TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts_ms);
        CREATE TABLE IF NOT EXISTS warnings(message TEXT PRIMARY KEY);")?;
    Ok(db)
}
pub fn sync(path: &Path, records: Vec<RequestRecord>) -> Result<Vec<RequestRecord>> {
    let mut db = open(path)?;
    let tx = db.transaction()?;
    let watermark: i64 =
        tx.query_row("SELECT COALESCE(MAX(id),0) FROM requests", [], |r| r.get(0))?;
    if let Some(oldest) = records.iter().map(|r| r.id).min()
        && oldest > watermark + 1
    {
        tx.execute(
            "INSERT OR IGNORE INTO warnings VALUES (?1)",
            [format!(
                "gap: meter ids {}..{} were not fetched (500-request window overflowed)",
                watermark + 1,
                oldest - 1
            )],
        )?;
    }
    let mut new = Vec::new();
    for record in records {
        anyhow::ensure!(record.id > 0, "invalid meter id");
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

// Pricing exposes dated cost but not the pre-history fallback. Read its append-only
// history here; never write its tables outside the pricing crate.
fn earliest_rate(db: &Connection, family: &str) -> Result<Option<(f64, f64)>> {
    Ok(db
        .query_row(
            "SELECT input_per_mtok,output_per_mtok FROM price_snapshots
        WHERE model_id=(SELECT model_id FROM reference_selection WHERE family=?1 AND confirmed=1
            ORDER BY effective_from,rowid LIMIT 1)
        ORDER BY fetched_at,refresh_id,(source='openrouter') DESC,rowid DESC LIMIT 1",
            [family],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}
pub fn spend(
    store: &pricing::Store,
    history: &Connection,
    family: &str,
    model_id: Option<String>,
    records: &[RequestRecord],
) -> Result<SpendAvoided> {
    let fallback = earliest_rate(history, family)?;
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
        match store.cost(family, prompt, output, ms_to_seconds(record.ts)) {
            Ok(usd) => result.usd += usd,
            Err(error) => {
                // Do not conceal SQLite failures as missing historical prices.
                if !matches!(
                    error.to_string().as_str(),
                    "no confirmed selection at this timestamp" | "no rates at this timestamp"
                ) {
                    return Err(error);
                }
                if let Some((input, output_rate)) = fallback {
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
    path: &Path,
    pricing_path: &Path,
    range: String,
    since: i64,
    mut warnings: Vec<String>,
) -> Result<Usage> {
    let db = open(path)?;
    let mut statement = db.prepare("SELECT record FROM requests WHERE ts_ms>=?1 ORDER BY id")?;
    let records = statement
        .query_map([since], |r| r.get::<_, String>(0))?
        .map(|r| Ok(serde_json::from_str::<RequestRecord>(&r?)?))
        .collect::<Result<Vec<_>>>()?;
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
    let store = pricing::Store::open(pricing_path)?;
    let history = Connection::open(pricing_path)?;
    let references = pricing::parse_references(pricing::DEFAULT_CONFIG)?;
    let spend_avoided = store
        .show(&references, ms_to_seconds(crate::now_ms()))?
        .into_iter()
        .map(|s| {
            spend(
                &store,
                &history,
                &s.family,
                s.selected.map(|s| s.model_id),
                &records,
            )
        })
        .collect::<Result<_>>()?;
    let mut groups = BTreeMap::<Option<String>, Vec<&RequestRecord>>::new();
    for record in &records {
        groups.entry(record.model.clone()).or_default().push(record);
    }
    let models = groups
        .into_iter()
        .map(|(model, rows)| {
            let average = |prompt: bool| {
                let rates: Vec<_> = rows
                    .iter()
                    .filter_map(|r| {
                        if prompt {
                            tps(r.prompt_eval_count, r.prompt_eval_duration)
                        } else {
                            tps(r.eval_count, r.eval_duration)
                        }
                    })
                    .collect();
                (!rates.is_empty()).then(|| rates.iter().sum::<f64>() / rates.len() as f64)
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
                model,
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
        let history = Connection::open(&path)?;
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
        assert_eq!(
            spend(&store, &history, "test", None, &rows)?.unpriced_requests,
            6
        );
        store.confirm("test", 110)?;
        // Later rates must not leak into either historical cost or pre-history estimates.
        let later = pricing::Model {
            input_per_mtok: 9.0,
            output_per_mtok: 30.0,
            ..model
        };
        store.refresh(&references, &[later], &[], 130, vec![])?;
        let spend = spend(&store, &history, "test", Some("model".into()), &rows)?;
        assert_eq!(
            (spend.usd, spend.estimated_usd, spend.unpriced_requests),
            (6.5, 5.5, 2)
        );
        Ok(())
    }
}
