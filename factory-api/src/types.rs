//! Factory aggregation API v1. All timestamps are Unix milliseconds.
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Health {
    pub status: String,
    pub version: String,
    pub git_sha: String,
    pub git_dirty: bool,
    pub built_at_ms: u64,
    pub inputs_fingerprint: String,
    /// SHA-256 (first 12 hex) of the served `/openapi.json`, byte-identical to
    /// the committed `factory-api/openapi.json` snapshot: the kiosk's API contract.
    pub openapi_sha256: String,
    /// SHA-256 (first 12 hex) of the whole `meter/openapi.json` used at build time.
    pub meter_openapi_expected: String,
    /// Meter's served contract hash; null when unreachable or not reported.
    pub meter_openapi_sha256: Option<String>,
    pub uptime_ms: u64,
    pub retention: RequestRetention,
}
/// Raw request retention of the API copy (MET-206): rows older than 365 days,
/// only when the verified rollup, the cost backfill and frozen costs cover them.
/// Runs after each five-minute rollup run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct RequestRetention {
    /// "pending" before the first run; "ok"; "skipped" when a gate is unmet;
    /// "failed" when the job errored, leaving every row in place.
    pub status: String,
    /// Skip reasons, error, or a note that pruning continues next run.
    pub detail: Option<String>,
    pub checked_at_ms: Option<i64>,
    /// Rows with `ts_ms` strictly below this were eligible in the last run.
    pub cutoff_ms: Option<i64>,
    /// Lowest request ID still cached after the last run; null when empty.
    pub oldest_retained_id: Option<i64>,
    /// Last run that was allowed to prune, and the rows it deleted.
    pub pruned_at_ms: Option<i64>,
    pub pruned_rows: u64,
    /// Rows deleted by every run since this process started.
    pub pruned_rows_since_start: u64,
    /// Start of the current streak of skipped or failed runs; alerts after 24 h.
    pub skipped_since_ms: Option<i64>,
}
impl Default for RequestRetention {
    fn default() -> Self {
        Self {
            status: "pending".into(),
            detail: None,
            checked_at_ms: None,
            cutoff_ms: None,
            oldest_retained_id: None,
            pruned_at_ms: None,
            pruned_rows: 0,
            pruned_rows_since_start: 0,
            skipped_since_ms: None,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ErrorDetail {
    pub code: String,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ApiError {
    pub error: ErrorDetail,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ServiceKind {
    Http,
    Tcp,
    /// X.224 negotiation canary for an `host:port` RDP server (MET-260).
    Rdp,
    Systemd,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct Service {
    pub name: String,
    pub kind: ServiceKind,
    pub target: String,
    pub ok: bool,
    pub latency_ms: Option<f64>,
    pub detail: Option<String>,
    pub checked_at_ms: i64,
    pub version: Option<String>,
    pub git_sha: Option<String>,
    pub git_dirty: Option<bool>,
    pub built_at_ms: Option<u64>,
    pub inputs_fingerprint: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Node {
    pub name: String,
    pub tailscale_ip: Option<String>,
    pub online: bool,
    pub last_seen_ms: Option<i64>,
    pub os: Option<String>,
    pub services: Vec<Service>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct Fleet {
    pub generated_at_ms: i64,
    pub nodes: Vec<Node>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct Totals {
    pub requests: usize,
    pub prompt_tokens: u64,
    pub output_tokens: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SpendAvoided {
    pub family: String,
    pub model_id: Option<String>,
    pub usd: f64,
    pub estimated_usd: f64,
    pub unpriced_requests: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ModelUsage {
    pub model: Option<String>,
    pub requests: usize,
    pub prompt_tokens: u64,
    pub output_tokens: u64,
    pub avg_prompt_tps: Option<f64>,
    pub avg_gen_tps: Option<f64>,
    pub p50_latency_ms: Option<f64>,
    pub p95_latency_ms: Option<f64>,
    pub total_load_ms: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Usage {
    pub range: String,
    pub generated_at_ms: i64,
    pub totals: Totals,
    pub spend_avoided: Vec<SpendAvoided>,
    pub models: Vec<ModelUsage>,
    pub warnings: Vec<String>,
    /// True when percentiles come from merged fixed-bucket latency histograms
    /// (ranges beyond 30 days); otherwise they are exact nearest-rank values.
    #[serde(default)]
    pub percentiles_approximate: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GpuCurrent {
    pub memory_used_mib: f64,
    pub memory_total_mib: f64,
    pub utilization_percent: f64,
    pub temperature_c: f64,
    pub power_w: f64,
    pub ts_ms: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GpuHistory {
    pub ts_ms: i64,
    pub memory_used_mib: f64,
    pub utilization_percent: f64,
    pub temperature_c: f64,
    pub power_w: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Gpu {
    pub current: Option<GpuCurrent>,
    pub loaded_models: Vec<String>,
    pub history: Vec<GpuHistory>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Selection {
    pub model_id: String,
    pub effective_from_ms: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Rates {
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    pub source: String,
    pub fetched_at_ms: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Family {
    pub family: String,
    pub selected: Option<Selection>,
    pub rates: Option<Rates>,
    pub pending: Option<Selection>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Pricing {
    pub families: Vec<Family>,
    pub warnings: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AgentTool {
    pub tool: String,
    pub status: String,
    pub note: Option<String>,
    pub reason: Option<String>,
    pub observed_at_ms: Option<i64>,
    pub source: Option<String>,
    pub cli_version: Option<String>,
    pub plan: Option<String>,
    pub windows: Vec<AgentWindow>,
    /// Primary balance; the first item in balances, not an additional pool.
    pub balance: Option<AgentBalance>,
    /// Amp has independent USD and normalized orb-hour pools. Never sum units.
    pub balances: Vec<AgentBalance>,
    /// Cursor cycle spend details in USD; empty for every other tool.
    #[serde(default)]
    pub breakdown: Vec<AgentSpendItem>,
    pub reset_credits_available: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AgentSpendItem {
    /// Unique within the tool: 1–64 characters from [a-z0-9._ -].
    pub label: String,
    /// USD decimal string with the same precision rules as balance amounts.
    pub amount: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AgentWindow {
    pub name: String,
    pub used_percent: f64,
    pub resets_at_ms: Option<i64>,
    pub window_minutes: Option<u64>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct AgentBalance {
    /// Decimal strings preserve provider precision; amount equals remaining.
    pub amount: String,
    pub unit: String,
    pub remaining: String,
    pub total: Option<String>,
    /// Optional pool label; workspace USD has no inferred total.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Agents {
    pub tools: Vec<AgentTool>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AgentsRefresh {
    /// Always "accepted"; completion arrives through agents.usage SSE.
    pub status: String,
    pub next_allowed_at_ms: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AgentsRefreshCooldown {
    pub error: ErrorDetail,
    pub next_allowed_at_ms: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct StreamEvent {
    /// Named SSE event: gpu.sample, ups.sample, ups.event, network.sample, network.speedtest,
    /// llm.request, fleet.change, pricing.changed, agents.usage, or devices.sample. ups.sample
    /// data is UpsCurrent or null on failure. devices.sample data is a device view, or null when
    /// the collector fails. History is not in the event.
    /// ups.event data is UpsEvent, sent once when an event opens and once when it closes.
    /// Zero-length self_test events send both an open frame and a closed frame.
    /// network.sample data is the array of Sample probed by one 30-second tick.
    /// network.speedtest data is the NetworkSpeedTest row, sent once after it is stored.
    pub r#type: String,
    pub ts_ms: i64,
    pub data: serde_json::Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct LlmRequest {
    pub model: Option<String>,
    pub prompt_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub latency_ms: f64,
    pub client_hostname: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FleetChange {
    pub node: String,
    pub service: String,
    pub ok: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct PricingChanged {
    pub family: String,
    pub pending_model_id: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum AlertSeverity {
    Critical,
    Warning,
    /// Posted once; clears without a recovery message.
    Info,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ActiveAlert {
    pub key: String,
    pub severity: AlertSeverity,
    pub summary: String,
    pub opened_at_ms: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ClearedAlert {
    pub key: String,
    pub severity: AlertSeverity,
    pub summary: String,
    pub opened_at_ms: i64,
    pub cleared_at_ms: i64,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct Alerts {
    pub active: Vec<ActiveAlert>,
    /// Last 20 cleared alerts, newest first.
    pub recent: Vec<ClearedAlert>,
}
