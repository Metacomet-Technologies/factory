mod api;
pub mod data;
pub mod fleet;

use anyhow::Result;
use serde::de::DeserializeOwned;
use shared::{GpuSample, RequestRecord, factory_api::*};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex, RwLock, broadcast};

#[derive(Clone)]
pub struct AppState {
    pub meter_url: String,
    pub db_path: PathBuf,
    pub pricing_db_path: PathBuf,
    pub config: Arc<fleet::Config>,
    pub client: reqwest::Client,
    /// Feed ingestion boundary, replaceable for offline integration tests.
    pub pricing_refresh:
        fn(&mut pricing::Store, &[pricing::Reference], i64) -> Result<Vec<pricing::Item>>,
    started: Instant,
    fleet: Arc<RwLock<Fleet>>,
    warnings: Arc<RwLock<BTreeMap<String, String>>>,
    events: broadcast::Sender<StreamEvent>,
    pricing_write: Arc<Mutex<()>>,
}
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
impl AppState {
    pub async fn new(
        meter_url: String,
        db_path: PathBuf,
        pricing_db_path: PathBuf,
        config: fleet::Config,
    ) -> Result<Self> {
        anyhow::ensure!(
            db_path != pricing_db_path,
            "request and pricing databases must differ"
        );
        let url = reqwest::Url::parse(&meter_url)?;
        anyhow::ensure!(
            matches!(url.scheme(), "http" | "https") && url.host_str().is_some(),
            "invalid meter URL"
        );
        let (requests, prices) = (db_path.clone(), pricing_db_path.clone());
        data::blocking(move || {
            data::open(&requests)?;
            pricing::Store::open(&prices)?;
            Ok(())
        })
        .await?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            meter_url: meter_url.trim_end_matches('/').into(),
            db_path,
            pricing_db_path,
            config: Arc::new(config),
            client,
            pricing_refresh: pricing::refresh_live,
            started: Instant::now(),
            fleet: Default::default(),
            warnings: Default::default(),
            events: broadcast::channel(1024).0,
            pricing_write: Default::default(),
        })
    }
    fn emit(&self, kind: &str, data: impl serde::Serialize) {
        let _ = self.events.send(StreamEvent {
            r#type: kind.into(),
            ts_ms: now_ms(),
            data: serde_json::to_value(data).expect("finite API data"),
        });
    }
    async fn warning(&self, source: &str, error: Option<String>) {
        let mut warnings = self.warnings.write().await;
        if let Some(error) = error {
            tracing::warn!(%source, %error);
            warnings.insert(source.into(), format!("{source}: {error}"));
        } else {
            warnings.remove(source);
        }
    }
    async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        Ok(self
            .client
            .get(format!("{}{path}", self.meter_url))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?)
    }
    pub async fn sync_meter(&self) -> Result<()> {
        let result = async {
            let records: Vec<RequestRecord> = self.get("/meter/requests?limit=500").await?;
            let path = self.db_path.clone();
            let new = data::blocking(move || data::sync(&path, records)).await?;
            for r in new {
                self.emit(
                    "llm.request",
                    LlmRequest {
                        model: r.model,
                        prompt_tokens: r.prompt_eval_count,
                        output_tokens: r.eval_count,
                        latency_ms: r.total_duration.map(data::ns_to_ms).unwrap_or(r.latency_ms),
                        client_hostname: r.client_hostname,
                    },
                );
            }
            Ok(())
        }
        .await;
        self.warning(
            "meter",
            result.as_ref().err().map(|e: &anyhow::Error| e.to_string()),
        )
        .await;
        result
    }
    pub async fn collect_fleet(&self) {
        let next = fleet::collect(self).await;
        let mut previous = self.fleet.write().await;
        for node in &next.nodes {
            for service in &node.services {
                let old = previous
                    .nodes
                    .iter()
                    .find(|n| n.name == node.name)
                    .and_then(|n| n.services.iter().find(|s| s.name == service.name));
                if old.is_none_or(|old| old.ok != service.ok) {
                    self.emit(
                        "fleet.change",
                        FleetChange {
                            node: node.name.clone(),
                            service: service.name.clone(),
                            ok: service.ok,
                        },
                    );
                }
            }
        }
        *previous = next;
    }
    pub async fn gpu_current(&self) -> (Option<GpuCurrent>, Vec<String>) {
        #[derive(serde::Deserialize)]
        struct MeterGpu {
            gpus: Vec<GpuSample>,
            ollama_ps: serde_json::Value,
        }
        match self.get::<MeterGpu>("/meter/gpu").await {
            Ok(gpu) => {
                self.warning("gpu", None).await;
                // v1 represents the first physical GPU; never use Ollama model size for memory.
                let current = gpu
                    .gpus
                    .into_iter()
                    .find(|g| g.index == 0)
                    .map(|g| GpuCurrent {
                        ts_ms: g.ts,
                        memory_used_mib: g.memory_used_mib,
                        memory_total_mib: g.memory_total_mib,
                        utilization_percent: g.utilization_percent,
                        temperature_c: g.temperature_c,
                        power_w: g.power_w,
                    });
                let loaded = gpu.ollama_ps["models"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|m| m["name"].as_str().or_else(|| m["model"].as_str()))
                    .map(str::to_owned)
                    .collect();
                (current, loaded)
            }
            Err(error) => {
                self.warning("gpu", Some(error.to_string())).await;
                (None, vec![])
            }
        }
    }
    pub async fn gpu(&self, range: &str, since: i64) -> Gpu {
        let (current, loaded_models) = self.gpu_current().await;
        // Meter accepts 24h/7d/30d, not 1h. Filter its 24h response for 1h.
        let upstream_range = if range == "1h" { "24h" } else { range };
        let history = match self
            .get::<Vec<GpuSample>>(&format!("/meter/gpu/history?range={upstream_range}"))
            .await
        {
            Ok(samples) => {
                self.warning("gpu history", None).await;
                samples
                    .into_iter()
                    .filter(|g| g.index == 0 && g.ts >= since)
                    .map(|g| GpuHistory {
                        ts_ms: g.ts,
                        memory_used_mib: g.memory_used_mib,
                        utilization_percent: g.utilization_percent,
                        temperature_c: g.temperature_c,
                        power_w: g.power_w,
                    })
                    .collect()
            }
            Err(error) => {
                self.warning("gpu history", Some(error.to_string())).await;
                vec![]
            }
        };
        Gpu {
            current,
            loaded_models,
            history,
        }
    }
    pub async fn pricing(&self) -> Result<Pricing> {
        let path = self.pricing_db_path.clone();
        let warning = self
            .warnings
            .read()
            .await
            .get("pricing")
            .cloned()
            .into_iter()
            .collect();
        data::blocking(move || {
            data::pricing_view(
                &pricing::Store::open(path)?,
                &pricing::parse_references(pricing::DEFAULT_CONFIG)?,
                warning,
            )
        })
        .await
    }
    pub async fn refresh_pricing(&self) -> Result<Pricing> {
        let _guard = self.pricing_write.lock().await;
        let before = self.pricing().await?;
        let path = self.pricing_db_path.clone();
        let refresh = self.pricing_refresh;
        let result = data::blocking(move || {
            let mut store = pricing::Store::open(path)?;
            refresh(
                &mut store,
                &pricing::parse_references(pricing::DEFAULT_CONFIG)?,
                data::ms_to_seconds(now_ms()),
            )?;
            Ok(())
        })
        .await;
        self.warning("pricing", result.err().map(|e| e.to_string()))
            .await;
        let after = self.pricing().await?;
        self.pricing_events(&before, &after);
        Ok(after)
    }
    fn pricing_events(&self, before: &Pricing, after: &Pricing) {
        for family in &after.families {
            let pending = family.pending.as_ref().map(|s| &s.model_id);
            let old = before
                .families
                .iter()
                .find(|f| f.family == family.family)
                .and_then(|f| f.pending.as_ref())
                .map(|s| &s.model_id);
            if old != pending {
                self.emit(
                    "pricing.changed",
                    PricingChanged {
                        family: family.family.clone(),
                        pending_model_id: pending.cloned(),
                    },
                );
            }
        }
    }
    pub async fn confirm_pricing(&self, family: String) -> Result<Pricing> {
        let _guard = self.pricing_write.lock().await;
        let before = self.pricing().await?;
        let path = self.pricing_db_path.clone();
        data::blocking(move || {
            pricing::Store::open(path)?.confirm(&family, data::ms_to_seconds(now_ms()))?;
            Ok(())
        })
        .await?;
        let after = self.pricing().await?;
        self.pricing_events(&before, &after);
        Ok(after)
    }
    pub async fn usage(&self, range: String, since: i64) -> Result<Usage> {
        let path = self.db_path.clone();
        let prices = self.pricing_db_path.clone();
        let warnings = self.warnings.read().await.values().cloned().collect();
        data::blocking(move || data::usage(&path, &prices, range, since, warnings)).await
    }
    pub fn start_collectors(&self) -> Vec<tokio::task::JoinHandle<()>> {
        let mut tasks = Vec::new();
        for kind in ["meter", "fleet", "gpu", "pricing"] {
            let state = self.clone();
            tasks.push(tokio::spawn(async move {
                let mut timer = tokio::time::interval(Duration::from_secs(match kind {
                    "pricing" => 86400,
                    "gpu" => 15,
                    _ => 30,
                }));
                timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    timer.tick().await;
                    match kind {
                        "meter" => {
                            let _ = state.sync_meter().await;
                        }
                        "fleet" => state.collect_fleet().await,
                        "gpu" => {
                            let (current, _) = state.gpu_current().await;
                            state.emit("gpu.sample", current);
                        }
                        _ => {
                            if let Err(error) = state.refresh_pricing().await {
                                tracing::error!(%error, "pricing refresh failed");
                            }
                        }
                    }
                }
            }));
        }
        tasks
    }
}
pub use api::router;
