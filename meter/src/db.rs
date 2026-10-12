use crate::{migrate, storage};
use anyhow::{Result, bail};
use factory_db::{Pool, Scope};
pub use rusqlite::Connection;
use rusqlite::params;
use serde::Serialize;
use shared::{GpuSample, ModelStats, RequestRecord};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
    time::Instant,
};

pub enum Event {
    Request(Box<RequestRecord>),
    Gpu(Vec<GpuSample>),
}

#[derive(Default, Clone, Serialize, utoipa::ToSchema)]
pub struct QueueStatus {
    pub dropped_requests: u64,
    pub dropped_gpu_samples: u64,
    /// Accepted writes still outstanding, including the executing write.
    pub queue_depth: usize,
}

struct Episode {
    start: i64,
    requests: u64,
    gpu: u64,
}
#[derive(Default)]
struct State {
    status: QueueStatus,
    episode: Option<Episode>,
    warning: Option<Instant>,
    error: Option<String>,
}

#[derive(Clone)]
pub struct Db {
    pub pool: Arc<Pool>,
    state: Arc<Mutex<State>>,
    /// Explicit scope injection for endpoint query-budget tests; runtime uses a
    /// new scope per call instead of a process-global statement counter.
    pub scope: Option<Scope>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        // Read-only preflight before the pool can apply settings or create a file.
        migrate::require_v1(&migrate::readonly(path)?)?;
        let pool = Pool::open_sync(
            path.into(),
            Default::default(),
            |db, reader| {
                migrate::require_v1(&db)?;
                if !reader {
                    db.execute(
                        "DELETE FROM gpu_samples WHERE ts_ms < ?1",
                        [crate::now_ms() - 7 * 86_400_000],
                    )?;
                }
                Ok(db)
            },
            |c| c,
        )?;
        Ok(Self {
            pool: Arc::new(pool),
            state: Default::default(),
            scope: None,
        })
    }

    fn error(&self) -> Result<()> {
        if let Some(error) = &self.state.lock().unwrap().error {
            bail!("SQLite write failed: {error}; restart after repairing storage");
        }
        Ok(())
    }

    pub fn queue_status(&self) -> QueueStatus {
        self.state.lock().unwrap().status.clone()
    }

    /// Inference never waits for queue space or for SQLite. Only short admission
    /// bookkeeping shares a lock with the writer; no SQL executes under this lock.
    pub fn send(&self, event: Event) {
        let (requests, gpu) = match &event {
            Event::Request(_) => (1, 0),
            Event::Gpu(s) => (0, s.len() as u64),
        };
        let state = self.state.clone();
        let mut admission = self.state.lock().unwrap();
        let result = self
            .pool
            .try_write(&self.scope.clone().unwrap_or_default(), move |db| {
                let result = match event {
                    Event::Request(r) => storage::insert_request(db, None, &r),
                    Event::Gpu(samples) => (|| -> Result<()> {
                        let tx = db.transaction()?;
                        for sample in samples {
                            storage::insert_gpu(&tx, None, &sample)?;
                        }
                        tx.execute(
                            "DELETE FROM gpu_samples WHERE ts_ms < ?1",
                            [crate::now_ms() - 7 * 86_400_000],
                        )?;
                        tx.commit()?;
                        Ok(())
                    })(),
                };
                {
                    let mut state = state.lock().unwrap();
                    state.status.queue_depth -= 1;
                    remember_error(&mut state, result);
                }
                flush_episode(db, &state);
            });
        match result {
            Ok(()) => admission.status.queue_depth += 1,
            Err(error) if error.is::<factory_db::pool::Overloaded>() => {
                admission.status.dropped_requests += requests;
                admission.status.dropped_gpu_samples += gpu;
                if requests + gpu > 0 {
                    let episode = admission.episode.get_or_insert(Episode {
                        start: crate::now_ms(),
                        requests: 0,
                        gpu: 0,
                    });
                    episode.requests += requests;
                    episode.gpu += gpu;
                    if admission
                        .warning
                        .is_none_or(|t| t.elapsed().as_secs() >= 60)
                    {
                        tracing::warn!(
                            dropped_requests = admission.status.dropped_requests,
                            dropped_gpu_samples = admission.status.dropped_gpu_samples,
                            "meter write queue full; data lost"
                        );
                        admission.warning = Some(Instant::now());
                    }
                }
            }
            Err(error) => remember_error(&mut admission, Err(error)),
        }
    }

    pub async fn barrier(&self) -> Result<()> {
        let state = self.state.clone();
        self.pool
            .write(&self.scope.clone().unwrap_or_default(), move |db| {
                flush_episode(db, &state);
                Ok(())
            })
            .await?;
        self.error()
    }

    pub async fn read<R: Send + 'static>(
        &self,
        work: impl FnOnce(&Connection) -> Result<R> + Send + 'static,
    ) -> Result<R> {
        self.barrier().await?;
        self.pool
            .read(&self.scope.clone().unwrap_or_default(), work)
            .await
    }

    /// Awaited typed import for offline fixtures/bulk producers, never inference.
    /// Caller chooses explicit IDs; the transaction either imports all rows or none.
    pub async fn import(&self, requests: Vec<RequestRecord>, gpu: Vec<GpuSample>) -> Result<()> {
        self.pool
            .write(&self.scope.clone().unwrap_or_default(), move |db| {
                let tx = db.transaction()?;
                for r in requests {
                    storage::insert_request(&tx, Some(r.id), &r)?;
                }
                for s in gpu {
                    storage::insert_gpu(&tx, None, &s)?;
                }
                tx.execute(
                    "DELETE FROM gpu_samples WHERE ts_ms < ?1",
                    [crate::now_ms() - 7 * 86_400_000],
                )?;
                tx.commit()?;
                Ok(())
            })
            .await
    }

    pub async fn health(&self) -> Result<()> {
        self.read(|db| {
            db.prepare("SELECT id FROM requests LIMIT 0")?
                .query([])?
                .next()?;
            Ok(())
        })
        .await
    }

    pub async fn requests(&self, limit: usize, after: Option<i64>) -> Result<Vec<RequestRecord>> {
        self.read(move |db| {
            let (order, cursor) = match after {
                Some(id) => ("WHERE id > ?2 ORDER BY id ASC", id),
                None => ("ORDER BY id DESC", 0),
            };
            let mut query = db.prepare(&format!(
                "SELECT {} FROM requests {order} LIMIT ?1",
                storage::REQUEST_COLUMNS
            ))?;
            let values = if after.is_some() {
                vec![limit as i64, cursor]
            } else {
                vec![limit as i64]
            };
            Ok(query
                .query_map(rusqlite::params_from_iter(values), storage::request)?
                .collect::<rusqlite::Result<_>>()?)
        })
        .await
    }

    pub async fn stats(&self, since: i64, model: Option<String>) -> Result<Vec<ModelStats>> {
        self.read(move |db| {
            let filter = if model.is_some() { " AND model=?2" } else { "" };
            let mut query = db.prepare(&format!(
                "SELECT {} FROM requests WHERE ts_ms>=?1{filter}",
                storage::REQUEST_COLUMNS
            ))?;
            let rows = if let Some(model) = model {
                query
                    .query_map(params![since, model], storage::request)?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            } else {
                query
                    .query_map([since], storage::request)?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };
            Ok(stats(rows))
        })
        .await
    }

    pub async fn history(&self, since: i64) -> Result<Vec<GpuSample>> {
        self.read(move |db| {
            Ok(db
                .prepare(&format!(
                    "SELECT {} FROM gpu_samples WHERE ts_ms>=?1 ORDER BY ts_ms,id",
                    storage::GPU_COLUMNS
                ))?
                .query_map([since], storage::gpu)?
                .collect::<rusqlite::Result<_>>()?)
        })
        .await
    }

    pub async fn maintain(&self, optimize: bool) -> Result<()> {
        self.barrier().await?;
        self.pool.maintain(&Scope::default(), optimize).await?;
        Ok(())
    }

    pub async fn close(&self) -> Result<()> {
        self.pool.close().await?;
        self.error()
    }
}

fn remember_error(state: &mut State, result: Result<()>) {
    if let Err(error) = result {
        tracing::error!(%error, "SQLite write failed");
        state.error = Some(error.to_string());
    }
}

fn flush_episode(db: &Connection, state: &Mutex<State>) {
    let episode = {
        let mut state = state.lock().unwrap();
        if state.status.queue_depth != 0 {
            return;
        }
        state.episode.take()
    };
    if let Some(episode) = episode {
        let result = (|| -> Result<()> {
            db.execute("INSERT INTO drop_episodes(started_at_ms,ended_at_ms,dropped_requests,dropped_gpu_samples) VALUES (?1,?2,?3,?4)",
                params![episode.start, crate::now_ms().max(episode.start), i64::try_from(episode.requests)?, i64::try_from(episode.gpu)?])?;
            Ok(())
        })();
        remember_error(&mut state.lock().unwrap(), result);
    }
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
