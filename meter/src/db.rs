use crate::{migrate, rollup, storage};
use anyhow::Context;
use anyhow::{Result, bail};
use factory_db::rollup::{self as rollups, Latencies, Window};
use factory_db::{Pool, Scope};
pub use rusqlite::Connection;
use rusqlite::params;
use serde::Serialize;
use shared::{GpuSample, ModelStats, RequestRecord};
use std::{
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
/// Last rollup job outcome. A failed or lagging job is unhealthy maintenance;
/// the next five-minute run resumes from the committed checkpoint.
#[derive(Clone, Serialize, utoipa::ToSchema)]
pub struct Maintenance {
    /// "ok", "unhealthy", or "pending" before the first rollup run.
    pub status: String,
    pub detail: Option<String>,
    pub checked_at_ms: Option<i64>,
}

impl Default for Maintenance {
    fn default() -> Self {
        Self {
            status: "pending".into(),
            detail: None,
            checked_at_ms: None,
        }
    }
}

#[derive(Default)]
struct State {
    maintenance: Maintenance,
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
        migrate::require_current(&migrate::readonly(path)?)?;
        let pool = Pool::open_sync(
            path.into(),
            Default::default(),
            |db, reader| {
                migrate::require_current(&db)?;
                if !reader {
                    rollup::prune_gpu(&db, crate::now_ms())?;
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
                        rollup::prune_gpu(&tx, crate::now_ms())?;
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
                rollup::prune_gpu(&tx, crate::now_ms())?;
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

    /// Rollups plus a disjoint raw edge, in one read snapshot: at most three
    /// statements. Ranges up to 30 days keep exact raw nearest-rank percentiles
    /// from the covering latency index; longer ranges merge histograms.
    pub async fn stats(
        &self,
        since: i64,
        model: Option<String>,
        exact: bool,
    ) -> Result<Vec<ModelStats>> {
        self.read(move |db| stats(db, since, model.as_deref(), exact))
            .await
    }

    /// Raw samples within the seven-day raw retention. Older ranges add hourly
    /// means for hours before the raw boundary: at most two statements.
    pub async fn history(&self, since: i64) -> Result<Vec<rollup::GpuPoint>> {
        self.history_at(since, crate::now_ms()).await
    }

    /// History resolved at `now`, the request time `since` was derived from, so
    /// the resolution never depends on how long the read waited.
    pub async fn history_at(&self, since: i64, now: i64) -> Result<Vec<rollup::GpuPoint>> {
        self.read(move |db| history(db, since, now)).await
    }

    /// Bounded rollup catch-up on the writer, outside any ingestion transaction.
    pub async fn rollups(&self) -> Result<rollup::Progress> {
        let state = self.state.clone();
        let result = self
            .pool
            .write(&self.scope.clone().unwrap_or_default(), |db| {
                rollup::run(db, crate::now_ms(), rollup::BATCHES_PER_RUN)
            })
            .await;
        let maintenance = Maintenance {
            status: match &result {
                Ok(p) if p.caught_up && p.verified => "ok",
                _ => "unhealthy",
            }
            .into(),
            detail: match &result {
                Ok(p) if p.caught_up && p.verified => None,
                Ok(p) => Some(format!(
                    "rollup catch-up incomplete after {} batches; continuing on next run",
                    p.batches
                )),
                Err(e) => Some(format!("rollup job failed: {e:#}")),
            },
            checked_at_ms: Some(crate::now_ms()),
        };
        if let Some(detail) = &maintenance.detail {
            tracing::warn!(%detail, "meter rollups");
        }
        state.lock().unwrap().maintenance = maintenance;
        result
    }

    pub fn maintenance(&self) -> Maintenance {
        self.state.lock().unwrap().maintenance.clone()
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

fn stats(db: &Connection, since: i64, model: Option<&str>, exact: bool) -> Result<Vec<ModelStats>> {
    let window = Window::new(since);
    let filter = if model.is_some() { " AND model=?3" } else { "" };
    let edge_filter = if model.is_some() {
        " AND r.model=?3"
    } else {
        ""
    };
    let bind = |first: i64, second: i64| -> Vec<rusqlite::types::Value> {
        let mut values = vec![first.into(), second.into()];
        values.extend(model.map(|m| m.to_owned().into()));
        values
    };
    let rollup_rows = db
        .prepare(&rollups::rollup_sql(filter))?
        .query_map(
            rusqlite::params_from_iter(bind(window.hour, window.day)),
            |r| Ok((r.get::<_, Option<String>>(1)?, rollups::agg(r, 2)?)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let edge = db
        .prepare(&rollups::edge_sql(
            &rollups::raw_columns("r"),
            "",
            edge_filter,
        ))?
        .query_map(
            rusqlite::params_from_iter(bind(since, window.hour)),
            rollups::raw,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let latencies = if exact {
        Latencies::Exact(
            db.prepare(&format!(
                "SELECT model,total_duration_ns,latency_ms FROM requests INDEXED BY requests_ts_latency WHERE ts_ms>=?1{}",
                if model.is_some() { " AND model=?2" } else { "" }
            ))?
            .query_map(
                rusqlite::params_from_iter(
                    std::iter::once(rusqlite::types::Value::from(since))
                        .chain(model.map(|m| m.to_owned().into())),
                ),
                |r| Ok((r.get(0)?, rollups::latency_ms(r.get(1)?, r.get(2)?))),
            )?
            .collect::<rusqlite::Result<_>>()?,
        )
    } else {
        let filter = if model.is_some() {
            " AND dimension_key->>1=?3"
        } else {
            ""
        };
        Latencies::Approximate(
            db.prepare(&rollups::histogram_sql(filter))?
                .query_map(
                    rusqlite::params_from_iter(bind(window.hour, window.day)),
                    |r| Ok((r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? as u64)),
                )?
                .collect::<rusqlite::Result<_>>()?,
        )
    };
    let summaries = rollups::summarize(rollup_rows, &edge, latencies, rollup::TPS)?;
    summaries
        .into_iter()
        .filter(|(_, s)| s.agg.requests > 0)
        .map(|(model, s)| {
            Ok(ModelStats {
                model,
                requests: usize::try_from(s.agg.requests)?,
                input_tokens: u64::try_from(s.agg.input_tokens)?,
                output_tokens: u64::try_from(s.agg.output_tokens)?,
                avg_prompt_tokens_per_second: s.agg.avg_prompt_tps(),
                avg_generation_tokens_per_second: s.agg.avg_generation_tps(),
                p50_total_latency_ms: s.p50_ms.context("missing latency")?,
                p95_total_latency_ms: s.p95_ms.context("missing latency")?,
                percentiles_approximate: !exact,
            })
        })
        .collect()
}

fn history(db: &Connection, since: i64, now: i64) -> Result<Vec<rollup::GpuPoint>> {
    let raw = |r: &rusqlite::Row<'_>| {
        Ok(rollup::GpuPoint {
            sample: storage::gpu(r)?,
            samples: None,
        })
    };
    if since >= now - 7 * rollups::DAY_MS {
        return Ok(db
            .prepare(&format!(
                "SELECT {} FROM gpu_samples WHERE ts_ms>=?1 ORDER BY ts_ms,id",
                storage::GPU_COLUMNS
            ))?
            .query_map([since], raw)?
            .collect::<rusqlite::Result<_>>()?);
    }
    // Hourly means (including the hour overlapping `since`) before the first
    // whole hour of raw retention; raw samples from there on, plus any sample
    // not yet rolled up. Until rollups are verified, the checkpoint reads as 0,
    // so the second query returns every retained raw sample instead.
    let boundary = rollups::ceil(now - 7 * rollups::DAY_MS, rollups::HOUR_MS);
    let first = rollups::floor(since, rollups::HOUR_MS);
    let mut points = db
        .prepare(rollup::GPU_HOURLY_SQL)?
        .query_map(params![first, boundary], rollup::gpu_hourly_point)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    points.extend(
        db.prepare(&rollup::gpu_raw_sql())?
            .query_map(params![since, boundary], raw)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
    );
    points.sort_by_key(|p| (p.sample.ts, p.samples.is_none()));
    Ok(points)
}
