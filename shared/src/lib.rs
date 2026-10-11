use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

pub mod factory_api;

/// Durations reported by Ollama are nanoseconds. Timestamps are Unix milliseconds.
#[derive(Debug, Default, Clone, Serialize, Deserialize, ToSchema)]
pub struct RequestRecord {
    pub id: i64,
    pub ts: i64,
    pub endpoint: String,
    pub model: Option<String>,
    pub prompt_eval_count: Option<u64>,
    pub eval_count: Option<u64>,
    pub load_duration: Option<u64>,
    pub prompt_eval_duration: Option<u64>,
    pub eval_duration: Option<u64>,
    pub total_duration: Option<u64>,
    /// The unmodified OpenAI usage object, when provided by upstream.
    pub usage: Option<serde_json::Value>,
    pub latency_ms: f64,
    pub status: u16,
    pub stream: bool,
    pub error: Option<String>,
    pub client_ip: String,
    pub client_hostname: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GpuSample {
    pub ts: i64,
    pub index: u32,
    pub memory_used_mib: f64,
    pub memory_total_mib: f64,
    pub utilization_percent: f64,
    pub temperature_c: f64,
    pub power_w: f64,
}

#[derive(Serialize, ToSchema)]
pub struct GpuResponse {
    pub gpus: Vec<GpuSample>,
    pub ollama_ps: serde_json::Value,
}

#[derive(Serialize, ToSchema)]
pub struct Health {
    pub status: String,
}

#[derive(Serialize, ToSchema)]
pub struct ApiError {
    pub error: String,
}

#[derive(Serialize, ToSchema)]
pub struct ModelStats {
    pub model: Option<String>,
    pub requests: usize,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub avg_prompt_tokens_per_second: Option<f64>,
    pub avg_generation_tokens_per_second: Option<f64>,
    pub p50_total_latency_ms: f64,
    pub p95_total_latency_ms: f64,
}

#[derive(Default, Deserialize, ToSchema)]
pub struct MeterQuery {
    pub range: Option<String>,
    pub model: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Default, Deserialize, ToSchema)]
pub struct MeterRequestsQuery {
    pub limit: Option<usize>,
    pub after_id: Option<i64>,
}
