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

const build = {
  version: "0.2.0",
  git_sha: "a1b2c3d",
  git_dirty: false,
  built_at_ms: 1_790_000_000_000,
};

export function agentFixtures(
  status: "ok" | "stale" | "unknown" | "not_tracked" = "ok",
  now = Date.now(),
): Agents {
  const tools: Agents["tools"] = [
    {
      tool: "amp",
      status,
      plan: "Gigawatt",
      source: "amp-cli",
      cli_version: "0.0.1791763306-ged595a",
      observed_at_ms: now - 7 * 60_000,
      windows: [
        {
          name: "agent",
          used_percent: 14,
          resets_at_ms: now + 29 * 86_400_000,
          window_minutes: null,
        },
        { name: "orb", used_percent: 0, resets_at_ms: now + 29 * 86_400_000, window_minutes: null },
      ],
      balances: [
        { amount: "171.27", remaining: "171.27", total: "200", unit: "usd" },
        { amount: "998.1", remaining: "998.1", total: "1000", unit: "orb_hours" },
      ],
    },
    {
      tool: "claude-code",
      status,
      plan: null,
      source: "claude-usage",
      cli_version: "2.1.296",
      observed_at_ms: now - 4 * 60_000,
      windows: [
        {
          name: "five_hour",
          used_percent: 13,
          resets_at_ms: now + 95 * 60_000,
          window_minutes: 300,
        },
        {
          name: "weekly",
          used_percent: 12,
          resets_at_ms: now + 3 * 86_400_000,
          window_minutes: 10080,
        },
        {
          name: "weekly_fable",
          used_percent: 0,
          resets_at_ms: now + 3 * 86_400_000,
          window_minutes: 10080,
        },
      ],
      balances: [],
      balance: null,
    },
    {
      tool: "codex",
      status,
      plan: "pro",
      source: "codex-app-server",
      cli_version: "0.162.1",
      observed_at_ms: now - 2 * 60_000,
      windows: [
        {
          name: "weekly",
          used_percent: 17,
          resets_at_ms: now + 6 * 86_400_000,
          window_minutes: 10080,
        },
      ],
      balances: [
        {
          amount: "62500.0000000000",
          remaining: "62500.0000000000",
          total: null,
          unit: "codex_credits",
        },
      ],
    },
  ];
  for (const tool of tools) {
    tool.balance = tool.balances[0] ?? null;
    if (status === "stale") tool.observed_at_ms = now - 51 * 60_000;
    if (status === "unknown" || status === "not_tracked") {
      tool.plan = null;
      tool.observed_at_ms = null;
      tool.windows = [];
      tool.balances = [];
      tool.balance = null;
      tool.reason = status === "unknown" ? "usage source unavailable" : null;
    }
  }
  tools.push(
    ...["cursor", "kimi"].map((tool) => ({
      tool,
      status: "not_tracked",
      windows: [],
      balances: [],
    })),
  );
  return { tools };
}

export function fixtures(
  outage = false,
  usageRange: UsageRange = "24h",
  gpuRange: GpuRange = "1h",
  now = Date.now(),
) {
  const health: Health = { status: "ok", ...build, uptime_ms: 9_840_000 };
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
            name: "meter-http",
            kind: "http",
            target: "http://factory-gpu:11434/meter/health",
            ok: !outage,
            latency_ms: outage ? null : 4,
            detail: outage ? "Upstream unavailable" : null,
            checked_at_ms: now,
            ...build,
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
          {
            name: "factory-api",
            kind: "http",
            target: "http://127.0.0.1:8080/v1/health",
            ok: true,
            latency_ms: 7,
            detail: null,
            checked_at_ms: now,
            ...build,
          },
        ],
      },
      {
        name: "factory-console",
        tailscale_ip: "100.91.20.11",
        online: true,
        last_seen_ms: null,
        os: "Linux",
        services: [
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
        family: "Claude Sonnet",
        model_id: outage ? null : "anthropic/claude-sonnet-5.5",
        usd: outage ? 0 : 3.41 * scale,
        estimated_usd: outage ? 0 : 1.12 * scale,
        unpriced_requests: outage ? 0 : 8,
      },
      {
        family: "ChatGPT mid-tier",
        model_id: outage ? null : "openai/gpt-6.1-sol",
        usd: outage ? 0 : 6.82 * scale,
        estimated_usd: 0,
        unpriced_requests: outage ? 0 : 3,
      },
    ],
    models: outage
      ? []
      : [
          {
            model: "factory-assist",
            requests: 812 * scale,
            prompt_tokens: 760_000 * scale,
            output_tokens: 218_000 * scale,
            avg_prompt_tps: 130.2,
            avg_gen_tps: 61.2,
            p50_latency_ms: 6302,
            p95_latency_ms: 6333,
            total_load_ms: 14500 * scale,
          },
          {
            model: "factory-code",
            requests: 372 * scale,
            prompt_tokens: 380_000 * scale,
            output_tokens: 138_200 * scale,
            avg_prompt_tps: null,
            avg_gen_tps: 56.8,
            p50_latency_ms: 1280,
            p95_latency_ms: 4120,
            total_load_ms: 9200 * scale,
          },
          {
            model: "factory-assist-max",
            requests: 96 * scale,
            prompt_tokens: 100_000 * scale,
            output_tokens: 30_000 * scale,
            avg_prompt_tps: 92.4,
            avg_gen_tps: 24.7,
            p50_latency_ms: 3800,
            p95_latency_ms: 8100,
            total_load_ms: 18600 * scale,
          },
          {
            model: null,
            requests: 4 * scale,
            prompt_tokens: 0,
            output_tokens: 0,
            avg_prompt_tps: null,
            avg_gen_tps: null,
            p50_latency_ms: 104,
            p95_latency_ms: 150,
            total_load_ms: 0,
          },
        ],
    warnings: outage
      ? ["Meter unavailable. Usage cannot be retrieved."]
      : ["11 requests have no reference price. They are excluded from priced spend avoided."],
  };
  const current: Gpu["current"] = outage
    ? null
    : {
        memory_used_mib: 9255,
        memory_total_mib: 12288,
        utilization_percent: 64,
        temperature_c: 62,
        power_w: 138,
        ts_ms: now,
      };
  const window = gpuRange === "1h" ? 3_600_000 : gpuRange === "24h" ? 86_400_000 : 604_800_000;
  const gpu: Gpu = {
    current,
    loaded_models: outage ? [] : ["factory-assist:latest"],
    history: outage
      ? []
      : Array.from({ length: 36 }, (_, index) => ({
          ts_ms: now - ((35 - index) * window) / 35,
          memory_used_mib: 9255 + Math.round(Math.sin(index / 4) * 300),
          utilization_percent: 40 + Math.round(Math.sin(index / 3) * 20 + index / 3),
          temperature_c: 58 + (index % 6),
          power_w: 110 + (index % 40),
        })),
  };
  const pricing: Pricing = {
    families: [
      {
        family: "Claude Sonnet",
        selected: outage
          ? null
          : { model_id: "anthropic/claude-sonnet-5.5", effective_from_ms: now - 86_400_000 },
        rates: outage
          ? null
          : {
              input_per_mtok: 3,
              output_per_mtok: 15,
              source: "OpenRouter",
              fetched_at_ms: now - 300_000,
            },
        pending: outage
          ? null
          : { model_id: "anthropic/claude-sonnet-5.6", effective_from_ms: now },
      },
      {
        family: "ChatGPT mid-tier",
        selected: outage
          ? null
          : { model_id: "openai/gpt-6.1-sol", effective_from_ms: now - 86_400_000 },
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
  const agents = agentFixtures(outage ? "unknown" : "ok", now);
  return { health, fleet, usage, gpu, pricing, agents };
}
