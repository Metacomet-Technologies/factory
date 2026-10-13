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
    pub uptime_ms: u64,
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
    Systemd,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
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
    pub reset_credits_available: Option<u64>,
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
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Agents {
    pub tools: Vec<AgentTool>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct StreamEvent {
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
