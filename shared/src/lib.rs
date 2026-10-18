use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_kind: Option<String>,
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
    pub version: String,
    pub git_sha: String,
    pub git_dirty: bool,
    pub built_at_ms: u64,
    pub inputs_fingerprint: String,
}

/// Identity embedded at compilation, shared by the meter and aggregation API.
pub fn build_info(inputs_fingerprint: &str) -> Health {
    Health {
        status: "ok".into(),
        version: env!("FACTORY_VERSION").into(),
        git_sha: env!("FACTORY_GIT_SHA").into(),
        git_dirty: env!("FACTORY_GIT_DIRTY") == "true",
        built_at_ms: env!("FACTORY_BUILT_AT_MS").parse().unwrap(),
        inputs_fingerprint: inputs_fingerprint.into(),
    }
}

/// `<binary> --build-info`: print the health build fields as one JSON line and
/// exit 0. Call first in `main`, before any database, socket or config.
pub fn exit_if_build_info(inputs_fingerprint: &str) {
    if std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == "--build-info")
    {
        let mut info = serde_json::to_value(build_info(inputs_fingerprint)).unwrap();
        info.as_object_mut().unwrap().remove("status");
        println!("{info}");
        std::process::exit(0);
    }
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
    /// True when percentiles come from merged fixed-bucket histograms (ranges
    /// beyond 30 days); otherwise they are exact nearest-rank raw values.
    #[serde(default)]
    pub percentiles_approximate: bool,
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
