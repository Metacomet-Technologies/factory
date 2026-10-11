import type {
  Agents,
  Fleet,
  Gpu,
  Health,
  Pricing,
  Usage,
  UsageRange,
  GpuRange,
} from "../src/api/types.ts";

export function fixtures(
  outage = false,
  usageRange: UsageRange = "24h",
  gpuRange: GpuRange = "1h",
  now = Date.now(),
) {
  const health: Health = { status: "ok", version: "1.0.0-mock", uptime_ms: 9_840_000 };
  const fleet: Fleet = {
    generated_at_ms: now,
    nodes: [
      {
        name: "factory-gpu",
        tailscale_ip: "100.91.20.10",
        online: !outage,
        last_seen_ms: outage ? null : now - 800,
        os: outage ? null : "Linux",
        services: [
          {
            name: "meter",
            kind: "http",
            target: "http://factory-gpu:11434/meter/health",
            ok: !outage,
            latency_ms: outage ? null : 4,
            detail: outage ? "Upstream unavailable" : null,
            checked_at_ms: now,
          },
          {
            name: "Ollama",
            kind: "http",
            target: "http://factory-gpu:11434/api/version",
            ok: !outage,
            latency_ms: outage ? null : 12,
            detail: null,
            checked_at_ms: now,
          },
        ],
      },
      {
        name: "factory-console",
        tailscale_ip: "100.91.20.11",
        online: true,
        last_seen_ms: now - 1200,
        os: "Linux",
        services: [
          {
            name: "factory-api",
            kind: "http",
            target: "http://factory-console:8080/v1/health",
            ok: true,
            latency_ms: 7,
            detail: null,
            checked_at_ms: now,
          },
          {
            name: "backup",
            kind: "systemd",
            target: "factory-backup.service",
            ok: false,
            latency_ms: null,
            detail: "Unit is inactive",
            checked_at_ms: now,
          },
        ],
      },
      {
        name: "factory-edge",
        tailscale_ip: "100.91.20.12",
        online: false,
        last_seen_ms: now - 8_100_000,
        os: null,
        services: [],
      },
    ],
  };
  const scale = usageRange === "24h" ? 1 : usageRange === "7d" ? 7 : 30;
  const usage: Usage = {
    range: usageRange,
    generated_at_ms: now,
    totals: {
      requests: outage ? 0 : 1284 * scale,
      prompt_tokens: outage ? 0 : 1_240_000 * scale,
      output_tokens: outage ? 0 : 386_200 * scale,
    },
    spend_avoided: [
      {
        family: "factory-assist",
        model_id: outage ? null : "claude-sonnet-4.6",
        usd: outage ? 0 : 3.41 * scale,
        estimated_usd: outage ? 0 : 1.12 * scale,
        unpriced_requests: outage ? 0 : 8,
      },
      {
        family: "factory-code",
        model_id: outage ? null : "gpt-5.4",
        usd: outage ? 0 : 6.82 * scale,
        estimated_usd: 0,
        unpriced_requests: outage ? 0 : 3,
      },
    ],
    models: outage
      ? []
      : [
          {
            model: "factory-assist:latest",
            requests: 812 * scale,
            prompt_tokens: 760_000 * scale,
            output_tokens: 218_000 * scale,
            avg_prompt_tps: 1456.2,
            avg_gen_tps: 81.4,
            p50_latency_ms: 812,
            p95_latency_ms: 2460,
            total_load_ms: 14500 * scale,
          },
          {
            model: "factory-code:latest",
            requests: 472 * scale,
            prompt_tokens: 480_000 * scale,
            output_tokens: 168_200 * scale,
            avg_prompt_tps: null,
            avg_gen_tps: 56.8,
            p50_latency_ms: 1280,
            p95_latency_ms: 4120,
            total_load_ms: 9200 * scale,
          },
        ],
    warnings: outage
      ? ["Meter unavailable. Usage cannot be retrieved."]
      : ["11 requests have no reference price. They are excluded from priced spend avoided."],
  };
  const current: Gpu["current"] = outage
    ? null
    : {
        memory_used_mib: 21480,
        memory_total_mib: 32768,
        utilization_percent: 64,
        temperature_c: 62,
        power_w: 248,
        ts_ms: now,
      };
  const window = gpuRange === "1h" ? 3_600_000 : gpuRange === "24h" ? 86_400_000 : 604_800_000;
  const gpu: Gpu = {
    current,
    loaded_models: outage ? [] : ["factory-assist:latest", "factory-code:latest"],
    history: outage
      ? []
      : Array.from({ length: 36 }, (_, index) => ({
          ts_ms: now - ((35 - index) * window) / 35,
          memory_used_mib: 19000 + Math.round(Math.sin(index / 4) * 2400),
          utilization_percent: 40 + Math.round(Math.sin(index / 3) * 20 + index / 3),
          temperature_c: 58 + (index % 6),
          power_w: 210 + (index % 40),
        })),
  };
  const pricing: Pricing = {
    families: [
      {
        family: "factory-assist",
        selected: outage
          ? null
          : { model_id: "claude-sonnet-4.6", effective_from_ms: now - 86_400_000 },
        rates: outage
          ? null
          : {
              input_per_mtok: 3,
              output_per_mtok: 15,
              source: "OpenRouter",
              fetched_at_ms: now - 300_000,
            },
        pending: outage ? null : { model_id: "claude-sonnet-4.7", effective_from_ms: now },
      },
      {
        family: "factory-code",
        selected: outage ? null : { model_id: "gpt-5.4", effective_from_ms: now - 86_400_000 },
        rates: outage
          ? null
          : {
              input_per_mtok: 2.5,
              output_per_mtok: 15,
              source: "OpenRouter",
              fetched_at_ms: now - 300_000,
            },
        pending: null,
      },
    ],
    warnings: outage ? ["Pricing provider unavailable. Reference rates are unknown."] : [],
  };
  const agents: Agents = {
    tools: [
      {
        tool: "Claude Code",
        status: "not_tracked",
        note: "CLI usage will appear when tracking is connected.",
      },
      { tool: "Codex", status: "not_tracked", note: null },
      { tool: "Gemini CLI", status: "not_tracked", note: null },
    ],
  };
  return { health, fleet, usage, gpu, pricing, agents };
}
