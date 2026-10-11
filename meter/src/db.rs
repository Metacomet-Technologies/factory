use rusqlite::{Connection, params};
use shared::{GpuSample, ModelStats, RequestRecord};
use std::{collections::BTreeMap, path::Path};
use tokio::sync::{mpsc, oneshot};

pub enum Event {
    Request(Box<RequestRecord>),
    Gpu(Vec<GpuSample>),
    Query {
        sql: String,
        reply: oneshot::Sender<Result<serde_json::Value, String>>,
    },
}

#[derive(Clone)]
pub struct Db(pub mpsc::UnboundedSender<Event>);

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let connection = Connection::open(path)?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")?;
        let fields = [
            "ts",
            "endpoint",
            "model",
            "prompt_eval_count",
            "eval_count",
            "load_duration",
            "prompt_eval_duration",
            "eval_duration",
            "total_duration",
            "usage",
            "latency_ms",
            "status",
            "stream",
            "error",
            "client_ip",
            "client_hostname",
        ];
        let columns = fields
            .iter()
            .map(|f| format!("{f} GENERATED ALWAYS AS (json_extract(record, '$.{f}')) STORED"))
            .collect::<Vec<_>>()
            .join(",");
        let gpu_columns = [
            "index",
            "memory_used_mib",
            "memory_total_mib",
            "utilization_percent",
            "temperature_c",
            "power_w",
        ]
        .iter()
        .map(|f| format!("\"{f}\" GENERATED ALWAYS AS (json_extract(sample, '$.{f}')) STORED"))
        .collect::<Vec<_>>()
        .join(",");
        connection.execute_batch(&format!("CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY, record TEXT NOT NULL, {columns});
            CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
            CREATE INDEX IF NOT EXISTS requests_model_ts ON requests(model, ts);
            CREATE TABLE IF NOT EXISTS gpu_samples (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, sample TEXT NOT NULL, {gpu_columns});
            DELETE FROM gpu_samples WHERE ts < {};
            CREATE INDEX IF NOT EXISTS gpu_ts ON gpu_samples(ts);", crate::now_ms() - 7 * 86_400_000))?;
        // ponytail: an unbounded queue keeps writes off the request path; use a durable spool if sustained traffic exceeds disk throughput.
        let (tx, mut rx) = mpsc::unbounded_channel();
        std::thread::Builder::new()
            .name("sqlite-writer".into())
            .spawn(move || {
                let mut write_error: Option<String> = None;
                while let Some(event) = rx.blocking_recv() {
                    let result = match event {
                        Event::Request(record) => connection
                            .execute(
                                "INSERT INTO requests(record) VALUES (?1)",
                                [serde_json::to_string(&record).unwrap()],
                            )
                            .map(|_| ()),
                        Event::Gpu(samples) => (|| {
                            for sample in samples {
                                connection.execute(
                                    "INSERT INTO gpu_samples(ts,sample) VALUES (?1,?2)",
                                    params![sample.ts, serde_json::to_string(&sample).unwrap()],
                                )?;
                            }
                            connection.execute(
                                "DELETE FROM gpu_samples WHERE ts < ?1",
                                [crate::now_ms() - 7 * 86_400_000],
                            )?;
                            Ok(())
                        })(),
                        Event::Query { sql, reply } => {
                            let result = match &write_error {
                                Some(error) => Err(format!(
                                    "SQLite write failed: {error}; restart after repairing storage"
                                )),
                                None => query(&connection, &sql).map_err(|e| e.to_string()),
                            };
                            let _ = reply.send(result);
                            Ok(())
                        }
                    };
                    if let Err(error) = result {
                        tracing::error!(%error, "SQLite write failed");
                        write_error = Some(error.to_string());
                    }
                }
            })
            .expect("start SQLite writer");
        Ok(Self(tx))
    }

    pub async fn query(&self, sql: String) -> Result<serde_json::Value, String> {
        let (reply, rx) = oneshot::channel();
        self.0
            .send(Event::Query { sql, reply })
            .map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())?
    }

    pub fn send(&self, event: Event) {
        if let Err(error) = self.0.send(event) {
            tracing::error!(%error, "SQLite writer unavailable");
        }
    }
}

fn query(connection: &Connection, sql: &str) -> rusqlite::Result<serde_json::Value> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement
        .query_map([], |row| {
            let mut value: serde_json::Value =
                serde_json::from_str(&row.get::<_, String>(1)?).expect("stored JSON");
            if value.get("endpoint").is_some() {
                value["id"] = row.get::<_, i64>(0)?.into();
            }
            Ok(value)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.into())
}

pub fn stats(records: Vec<RequestRecord>) -> Vec<ModelStats> {
    let mut groups = BTreeMap::<Option<String>, Vec<RequestRecord>>::new();
    for record in records {
        groups.entry(record.model.clone()).or_default().push(record);
    }
    groups
        .into_iter()
        .map(|(model, records)| {
            let average = |prompt: bool| {
                let rates: Vec<_> = records
                    .iter()
                    .filter_map(|r| {
                        let (tokens, duration) = if prompt {
                            (r.prompt_eval_count, r.prompt_eval_duration)
                        } else {
                            (r.eval_count, r.eval_duration)
                        };
                        match (tokens, duration) {
                            (Some(t), Some(d)) if d > 0 => Some(t as f64 * 1e9 / d as f64),
                            _ => None,
                        }
                    })
                    .collect();
                (!rates.is_empty()).then(|| rates.iter().sum::<f64>() / rates.len() as f64)
            };
            let mut latencies: Vec<_> = records
                .iter()
                .map(|r| {
                    r.total_duration
                        .map(|n| n as f64 / 1e6)
                        .unwrap_or(r.latency_ms)
                })
                .collect();
            latencies.sort_by(f64::total_cmp);
            let percentile = |p: f64| {
                latencies[((latencies.len() as f64 * p).ceil() as usize).saturating_sub(1)]
            };
            ModelStats {
                model,
                requests: records.len(),
                input_tokens: records.iter().filter_map(|r| r.prompt_eval_count).sum(),
                output_tokens: records.iter().filter_map(|r| r.eval_count).sum(),
                avg_prompt_tokens_per_second: average(true),
                avg_generation_tokens_per_second: average(false),
                p50_total_latency_ms: percentile(0.5),
                p95_total_latency_ms: percentile(0.95),
            }
        })
        .collect()
}
