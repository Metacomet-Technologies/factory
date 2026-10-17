pub mod alerts;
mod api;
pub mod data;
pub mod devices;
pub mod devices_history;
pub mod fleet;
mod kiosk;
pub mod network;
pub mod network_history;
pub mod pool;
pub mod types;
pub mod ups;
pub mod ups_history;
mod usage;

use anyhow::Result;
use serde::de::DeserializeOwned;
use shared::{GpuSample, RequestRecord};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicI64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{RwLock, broadcast};
use tokio_util::sync::CancellationToken;
use types::*;

pub const INFERENCE_ENDPOINTS: [&str; 6] = [
    "/api/generate",
    "/api/chat",
    "/api/embed",
    "/v1/chat/completions",
    "/v1/completions",
    "/v1/embeddings",
];

#[derive(Clone)]
pub struct AppState {
    pub meter_url: String,
    pub db_path: PathBuf,
    pub pricing_db_path: PathBuf,
    pub static_dir: PathBuf,
    pub usage_snapshot: PathBuf,
    pub usage_trigger: PathBuf,
    /// MET-74 backup status file read by the alert engine.
    pub backup_status: PathBuf,
    pub devices_root: PathBuf,
    pub reboot_status: PathBuf,
    pub alerts: Arc<alerts::Alerting>,
    usage_refresh_lock: Arc<std::sync::Mutex<()>>,
    pub config: Arc<fleet::Config>,
    pub client: reqwest::Client,
    pub pricing_sources: [String; 2],
    pub disable_pricing_collector: bool,
    pub ups_addr: String,
    pub ups_name: String,
    /// Network probe registry, built once from NetworkConfig in layer order.
    pub network: Arc<[network::Target]>,
    pricing_client: reqwest::Client,
    pub db: Arc<pool::Pool>,
    /// Explicit request/job handle propagated to both database pools.
    pub query_scope: factory_db::Scope,
    pub shutdown: CancellationToken,
    started: Instant,
    fleet: Arc<RwLock<Fleet>>,
    fleet_discovered: Arc<AtomicBool>,
    gpu_latest: Arc<std::sync::Mutex<Option<(i64, f64)>>>,
    ups_latest: Arc<RwLock<alerts::UpsRead>>,
    ups_changed: Arc<tokio::sync::Notify>,
    devices_latest: Arc<RwLock<Option<devices::DeviceView>>>,
    devices_guard: Arc<AtomicBool>,
    meter_synced_at_ms: Arc<AtomicI64>,
    warnings: Arc<RwLock<BTreeMap<String, String>>>,
    events: broadcast::Sender<StreamEvent>,
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
        let db = Arc::new(pool::Pool::open(db_path.clone(), pricing_db_path.clone()).await?);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            meter_url: meter_url.trim_end_matches('/').into(),
            db_path,
            pricing_db_path,
            static_dir: "/var/lib/factory-api/kiosk".into(),
            usage_snapshot: "/var/lib/factory-usage/usage.json".into(),
            usage_trigger: "/var/lib/factory-usage-trigger/request".into(),
            backup_status: alerts::DEFAULT_BACKUP_STATUS.into(),
            devices_root: PathBuf::from("/"),
            reboot_status: devices::DEFAULT_REBOOT_STATUS.into(),
            alerts: Arc::new(alerts::Alerting::new(alerts::Config::default())),
            usage_refresh_lock: Default::default(),
            config: Arc::new(config),
            client,
            pricing_sources: [pricing::OPENROUTER_URL.into(), pricing::LITELLM_URL.into()],
            disable_pricing_collector: false,
            ups_addr: "127.0.0.1:3493".into(),
            ups_name: "cyberpower".into(),
            // main installs the configured registry; embedders and tests probe nothing.
            network: Arc::new([]),
            pricing_client: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .user_agent("factory-pricing/0.1")
                .build()?,
            db,
            query_scope: factory_db::Scope::default(),
            shutdown: CancellationToken::new(),
            started: Instant::now(),
            fleet: Default::default(),
            fleet_discovered: Default::default(),
            gpu_latest: Default::default(),
            ups_latest: Arc::new(RwLock::new(alerts::UpsRead {
                current: None,
                last_success_ms: now_ms(),
            })),
            ups_changed: Default::default(),
            devices_latest: Default::default(),
            devices_guard: Default::default(),
            meter_synced_at_ms: Arc::new(AtomicI64::new(now_ms())),
            warnings: Default::default(),
            events: broadcast::channel(1024).0,
        })
    }
    pub async fn check_clock(&self) -> bool {
        let synchronized =
            fleet::command("timedatectl", &["show", "-p", "NTPSynchronized", "--value"])
                .await
                .is_ok_and(|value| value.trim() == "yes");
        self.db
            .clock_synchronized
            .store(synchronized, Ordering::Release);
        self.warning(
            "clock",
            (!synchronized)
                .then(|| "not synchronized; pricing refreshes and data writes paused".into()),
        )
        .await;
        synchronized
    }
    fn require_clock(&self) -> Result<()> {
        anyhow::ensure!(
            self.db.clock_synchronized.load(Ordering::Acquire),
            "clock not synchronized; data writes paused"
        );
        Ok(())
    }
    async fn read_warnings(&self) -> Vec<String> {
        let mut warnings: Vec<_> = self.warnings.read().await.values().cloned().collect();
        if self.require_clock().is_err() && !warnings.iter().any(|w| w.starts_with("clock:")) {
            warnings
                .push("clock: not synchronized; pricing refreshes and data writes paused".into());
        }
        warnings
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
            self.require_clock()?;
            let mut cursor: i64 = self
                .db
                .requests
                .read(&self.query_scope, |db| {
                    Ok(db.query_row("SELECT COALESCE(MAX(id),0) FROM requests", [], |r| r.get(0))?)
                })
                .await?;
            loop {
                let response = self
                    .client
                    .get(format!(
                        "{}/meter/requests?after_id={cursor}&limit=500",
                        self.meter_url
                    ))
                    .send()
                    .await?
                    .error_for_status()?;
                let next: i64 = response
                    .headers()
                    .get("next_after_id")
                    .ok_or_else(|| anyhow::anyhow!("meter missing next_after_id"))?
                    .to_str()?
                    .parse()?;
                let records: Vec<RequestRecord> = response.json().await?;
                anyhow::ensure!(
                    records.len() <= 500
                        && records
                            .iter()
                            .map(|r| r.id)
                            .try_fold(cursor, |previous, id| { (id > previous).then_some(id) })
                            == Some(next),
                    "invalid meter cursor page"
                );
                if records.is_empty() {
                    break;
                }
                let new = self
                    .db
                    .write(&self.query_scope, move |db| data::sync(db, records))
                    .await?;
                cursor = next;
                for r in new
                    .into_iter()
                    .filter(|r| INFERENCE_ENDPOINTS.contains(&r.endpoint.as_str()))
                {
                    self.emit(
                        "llm.request",
                        LlmRequest {
                            model: r.model,
                            prompt_tokens: r.prompt_eval_count,
                            output_tokens: r.eval_count,
                            latency_ms: r
                                .total_duration
                                .map(data::ns_to_ms)
                                .unwrap_or(r.latency_ms),
                            client_hostname: r.client_hostname,
                        },
                    );
                }
            }
            Ok(())
        }
        .await;
        if result.is_ok() {
            self.meter_synced_at_ms.store(now_ms(), Ordering::Release);
        }
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
                *self.gpu_latest.lock().expect("GPU sample lock") =
                    current.as_ref().map(|g| (g.ts_ms, g.temperature_c));
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
                *self.gpu_latest.lock().expect("GPU sample lock") = None;
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
        let warning = self
            .read_warnings()
            .await
            .into_iter()
            .filter(|w| w.starts_with("pricing:") || w.starts_with("clock:"))
            .collect();
        self.db
            .pricing
            .read(&self.query_scope, move |db| {
                data::pricing_view(
                    db,
                    &pricing::parse_references(pricing::DEFAULT_CONFIG)?,
                    warning,
                )
            })
            .await
    }
    pub async fn refresh_pricing(&self) -> Result<Pricing> {
        if self.require_clock().is_err() {
            return self.pricing().await;
        }
        let before = self.pricing().await?;
        // No connection, transaction, or mutex is held while either feed is fetched.
        let fetch = |index: usize| async move {
            let text = self
                .pricing_client
                .get(&self.pricing_sources[index])
                .send()
                .await?
                .error_for_status()?
                .text()
                .await?;
            data::blocking(move || {
                let models = if index == 0 {
                    pricing::parse_openrouter(&text)?
                } else {
                    pricing::parse_litellm(&text)?
                };
                anyhow::ensure!(!models.is_empty(), "source returned no usable models");
                Ok(models)
            })
            .await
        };
        let (primary, secondary) = tokio::join!(fetch(0), fetch(1));
        let result = self
            .db
            .write_pricing(&self.query_scope, move |db| {
                let at = now_ms();
                let mut items = vec![];
                let mut source = |result: Result<Vec<pricing::Model>>, name: &str| match result {
                    Ok(models) => models,
                    Err(error) => {
                        items.push(pricing::Item {
                            fetched_at_ms: at,
                            kind: "warning".into(),
                            family: "*".into(),
                            message: format!("{name} unavailable: {error:#}"),
                        });
                        vec![]
                    }
                };
                let primary = source(primary, "openrouter");
                let secondary = source(secondary, "litellm");
                anyhow::ensure!(
                    !primary.is_empty() || !secondary.is_empty(),
                    "both pricing sources unavailable: {}",
                    items
                        .iter()
                        .map(|i| i.message.as_str())
                        .collect::<Vec<_>>()
                        .join("; ")
                );
                db.refresh(
                    &pricing::parse_references(pricing::DEFAULT_CONFIG)?,
                    &primary,
                    &secondary,
                    at,
                    items,
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
        self.require_clock()?;
        let before = self.pricing().await?;
        self.db
            .write_pricing(&self.query_scope, move |db| {
                db.confirm(&family, now_ms())?;
                Ok(())
            })
            .await?;
        let after = self.pricing().await?;
        self.pricing_events(&before, &after);
        Ok(after)
    }
    pub async fn usage(&self, range: String, since: i64) -> Result<Usage> {
        let warnings = self.read_warnings().await;
        let (records, warnings) = self
            .db
            .requests
            .read(&self.query_scope, move |db| {
                data::usage_records(db, since, warnings)
            })
            .await?;
        self.db
            .pricing
            .read(&self.query_scope, move |db| {
                data::usage(db, range, records, warnings)
            })
            .await
    }
    pub async fn ups(&self) -> ups::Ups {
        let result = ups::read(&self.ups_addr, &self.ups_name).await;
        let warnings = result
            .as_ref()
            .err()
            .map(|e| format!("ups: {e}"))
            .into_iter()
            .collect();
        self.warning("ups", result.as_ref().err().map(ToString::to_string))
            .await;
        ups::Ups {
            generated_at_ms: now_ms(),
            current: result.ok(),
            warnings,
        }
    }
    pub async fn devices_view(&self) -> devices::DeviceView {
        let now = now_ms();
        let stored = self.devices_latest.read().await.clone();
        devices::freshen(&stored.unwrap_or_else(|| devices::unavailable(now)), now)
    }
    pub async fn collect_devices(&self, sampler: &mut devices::Sampler) {
        if self.devices_guard.swap(true, Ordering::AcqRel) {
            return;
        }
        let root = self.devices_root.clone();
        let backup = self.backup_status.clone();
        let reboot = self.reboot_status.clone();
        let (gpu, _) = self.gpu_current().await;
        let ups = self.ups_latest.read().await.current.clone();
        let services = {
            let fleet = self.fleet.read().await;
            fleet
                .nodes
                .iter()
                .find(|node| node.name == devices::DEVICE_ID)
                .map(|node| node.services.clone())
                .unwrap_or_default()
        };
        let clock = self.db.clock_synchronized.load(Ordering::Acquire);
        let now = now_ms();
        let mut owned = std::mem::take(sampler);
        let joined = tokio::task::spawn_blocking(move || {
            let inputs = devices::Inputs {
                now_ms: now,
                gpu,
                ups,
                services,
                backup_path: backup,
                reboot_path: reboot,
                clock_synchronized: clock,
            };
            let view = devices::sample(&root, &mut owned, &inputs);
            (view, owned)
        })
        .await;
        self.devices_guard.store(false, Ordering::Release);
        let (view, owned) = match joined {
            Ok(pair) => pair,
            Err(error) => {
                self.emit("devices.sample", &None::<devices::DeviceView>);
                self.warning("devices", Some(error.to_string())).await;
                return;
            }
        };
        *sampler = owned;
        self.emit("devices.sample", &view);
        *self.devices_latest.write().await = Some(view.clone());
        let result = self
            .db
            .write(&self.query_scope, move |db| {
                devices_history::record_view(db, &view)
            })
            .await;
        self.warning("devices history", result.err().map(|e| e.to_string()))
            .await;
    }
    pub async fn network(&self) -> Result<network::NetworkStatus> {
        let warnings = self
            .read_warnings()
            .await
            .into_iter()
            .filter(|w| w.starts_with("network") || w.starts_with("clock:"))
            .collect();
        let keys: Vec<String> = self.network.iter().map(|t| t.key.clone()).collect();
        let mut latest = self
            .db
            .requests
            .read(&self.query_scope, move |db| {
                network_history::latest(db, network::DEVICE_ID, &keys)
            })
            .await?;
        let targets = self
            .network
            .iter()
            .map(|t| network::NetworkTarget {
                layer: t.layer,
                target: t.key.clone(),
                probe: t.probe.kind(),
                latest: latest
                    .iter()
                    .position(|s| s.target == t.key)
                    .map(|i| latest.swap_remove(i)),
            })
            .collect();
        Ok(network::NetworkStatus {
            generated_at_ms: now_ms(),
            device_id: network::DEVICE_ID.into(),
            targets,
            warnings,
        })
    }
    pub async fn collect_network(&self) {
        let ts_ms = now_ms();
        let mut samples = Vec::new();
        let mut errors = Vec::new();
        for result in network::probe_all(&self.network, ts_ms).await {
            match result {
                Ok(sample) => samples.push(sample),
                Err(error) => errors.push(format!("{error:#}")),
            }
        }
        let batch = samples.clone();
        let stored = if samples.is_empty() {
            Ok(())
        } else {
            self.db
                .write(&self.query_scope, move |db| {
                    network_history::record(db, network::DEVICE_ID, &batch)
                })
                .await
        };
        self.warning("network history", stored.err().map(|e| e.to_string()))
            .await;
        self.emit("network.sample", &samples);
        self.warning("network", (!errors.is_empty()).then(|| errors.join("; ")))
            .await;
    }
    pub fn start_collectors(&self) -> Vec<tokio::task::JoinHandle<()>> {
        let mut tasks = vec![self.start_usage_collector()];
        tasks.extend(self.start_alerts());
        if self.disable_pricing_collector {
            tracing::info!(
                "pricing collector disabled; manual refresh and confirmation remain enabled"
            );
        }
        for kind in [
            "meter", "fleet", "gpu", "ups", "devices", "network", "pricing", "clock", "database",
        ] {
            if kind == "pricing" && self.disable_pricing_collector {
                continue;
            }
            let mut state = self.clone();
            tasks.push(tokio::spawn(async move {
                let mut timer = tokio::time::interval(Duration::from_secs(match kind {
                    // Retry promptly after clock synchronization; feed attempts stay daily.
                    "pricing" | "clock" => 2,
                    "gpu" | "devices" => 15,
                    "ups" => 10,
                    "database" => 300,
                    _ => 30,
                }));
                timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                let mut last_pricing = None::<Instant>;
                let mut last_optimize = Instant::now();
                let mut ups_collector = None::<ups_history::Collector>;
                let mut devices_sampler = devices::Sampler::default();
                loop {
                    tokio::select! { biased;
                        _ = state.shutdown.cancelled() => break,
                        _ = timer.tick() => (),
                    }
                    state.query_scope = factory_db::Scope::default();
                    let collect = async {
                        match kind {
                            "meter" => {
                                let _ = state.sync_meter().await;
                            }
                            "fleet" => state.collect_fleet().await,
                            "network" => state.collect_network().await,
                            "gpu" => {
                                let (current, _) = state.gpu_current().await;
                                state.emit("gpu.sample", current);
                            }
                            "ups" => {
                                let sample = state.ups().await.current;
                                state.emit("ups.sample", &sample);
                                let reading = sample.clone();
                                let collector = ups_collector.clone();
                                let result = state
                                    .db
                                    .write(&state.query_scope, move |db| {
                                        let mut collector = match collector {
                                            Some(c) => c,
                                            None => ups_history::Collector::new(db, now_ms())?,
                                        };
                                        let events =
                                            collector.record(db, sample.as_ref(), now_ms())?;
                                        Ok((collector, events))
                                    })
                                    .await;
                                match result {
                                    Ok((collector, events)) => {
                                        ups_collector = Some(collector);
                                        for event in events {
                                            state.emit("ups.event", event);
                                        }
                                        state.warning("ups history", None).await;
                                    }
                                    Err(e) => {
                                        state.warning("ups history", Some(e.to_string())).await
                                    }
                                }
                                // Publish after history commits so recovery sees restart endings.
                                let mut latest = state.ups_latest.write().await;
                                if let Some(s) = &reading {
                                    latest.last_success_ms = s.ts_ms;
                                }
                                latest.current = reading;
                                drop(latest);
                                state.ups_changed.notify_one();
                            }
                            "devices" => state.collect_devices(&mut devices_sampler).await,
                            "clock" => {
                                state.check_clock().await;
                            }
                            "database" => {
                                let optimize =
                                    last_optimize.elapsed() >= Duration::from_secs(86400);
                                let retention = state
                                    .db
                                    .write(&state.query_scope, |db| {
                                        ups_history::retain(db, now_ms())
                                    })
                                    .await;
                                state
                                    .warning(
                                        "ups retention",
                                        retention.err().map(|e| e.to_string()),
                                    )
                                    .await;
                                let device_retention = state
                                    .db
                                    .write(&state.query_scope, |db| {
                                        devices_history::retain(db, now_ms())
                                    })
                                    .await;
                                state
                                    .warning(
                                        "devices retention",
                                        device_retention.err().map(|e| e.to_string()),
                                    )
                                    .await;
                                let network_retention = state
                                    .db
                                    .write(&state.query_scope, |db| {
                                        network_history::retain(db, now_ms())
                                    })
                                    .await;
                                state
                                    .warning(
                                        "network retention",
                                        network_retention.err().map(|e| e.to_string()),
                                    )
                                    .await;
                                let result = async {
                                    let requests = state
                                        .db
                                        .requests
                                        .maintain(&state.query_scope, optimize)
                                        .await?;
                                    let pricing = state
                                        .db
                                        .pricing
                                        .maintain(&state.query_scope, optimize)
                                        .await?;
                                    tracing::debug!(
                                        ?requests,
                                        ?pricing,
                                        "passive database checkpoints"
                                    );
                                    anyhow::Ok(())
                                }
                                .await;
                                if result.is_ok() && optimize {
                                    last_optimize = Instant::now();
                                }
                                state
                                    .warning(
                                        "database maintenance",
                                        result.err().map(|e| e.to_string()),
                                    )
                                    .await;
                            }
                            _ => {
                                if state.require_clock().is_ok()
                                    && last_pricing
                                        .is_none_or(|at| at.elapsed() >= Duration::from_secs(86400))
                                {
                                    if let Err(error) = state.refresh_pricing().await {
                                        tracing::error!(%error, "pricing refresh failed");
                                    }
                                    if state.require_clock().is_ok() {
                                        last_pricing = Some(Instant::now());
                                    }
                                }
                            }
                        }
                    };
                    tokio::select! { biased;
                        _ = state.shutdown.cancelled() => break,
                        _ = collect => (),
                    }
                }
            }));
        }
        tasks
    }
}
pub use api::router;
