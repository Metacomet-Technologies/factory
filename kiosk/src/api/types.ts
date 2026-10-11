export type UsageRange = "24h" | "7d" | "30d";
export type GpuRange = "1h" | "24h" | "7d";
export interface Health {
  status: "ok";
  version: string;
  uptime_ms: number;
}
export interface Service {
  name: string;
  kind: "http" | "tcp" | "systemd";
  target: string;
  ok: boolean;
  latency_ms: number | null;
  detail: string | null;
  checked_at_ms: number;
}
export interface Fleet {
  generated_at_ms: number;
  nodes: {
    name: string;
    tailscale_ip: string;
    online: boolean;
    last_seen_ms: number | null;
    os: string | null;
    services: Service[];
  }[];
}
export interface ModelUsage {
  model: string;
  requests: number;
  prompt_tokens: number;
  output_tokens: number;
  avg_prompt_tps: number | null;
  avg_gen_tps: number | null;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  total_load_ms: number;
}
export interface Usage {
  range: UsageRange;
  generated_at_ms: number;
  totals: { requests: number; prompt_tokens: number; output_tokens: number };
  spend_avoided: {
    family: string;
    model_id: string | null;
    usd: number;
    estimated_usd: number;
    unpriced_requests: number;
  }[];
  models: ModelUsage[];
  warnings: string[];
}
export interface GpuSample {
  memory_used_mib: number;
  memory_total_mib: number;
  utilization_percent: number;
  temperature_c: number;
  power_w: number;
  ts_ms: number;
}
export interface Gpu {
  current: GpuSample | null;
  loaded_models: string[];
  history: Omit<GpuSample, "memory_total_mib">[];
}
export interface Pricing {
  families: {
    family: string;
    selected: { model_id: string; effective_from_ms: number } | null;
    rates: {
      input_per_mtok: number;
      output_per_mtok: number;
      source: string;
      fetched_at_ms: number;
    } | null;
    pending: { model_id: string; effective_from_ms: number } | null;
  }[];
  warnings: string[];
}
export interface Agents {
  tools: { tool: string; status: "not_tracked"; note: string | null }[];
}
export interface LlmRequest {
  model: string;
  prompt_tokens: number;
  output_tokens: number;
  latency_ms: number;
  client_hostname: string;
}
export type StreamEvent = { ts_ms: number } & (
  | { type: "gpu.sample"; data: GpuSample | null }
  | { type: "llm.request"; data: LlmRequest }
  | { type: "fleet.change"; data: { node: string; service: string; ok: boolean } }
  | { type: "pricing.changed"; data: { family: string; pending_model_id: string | null } }
);
export interface Endpoints {
  "/v1/health": Health;
  "/v1/fleet": Fleet;
  "/v1/llm/usage": Usage;
  "/v1/gpu": Gpu;
  "/v1/pricing": Pricing;
  "/v1/agents": Agents;
}
