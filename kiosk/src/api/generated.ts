export interface paths {
  "/v1/agents": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["agents"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/fleet": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["fleet"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/gpu": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["gpu"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/health": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["health"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/llm/usage": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["usage"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/pricing": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["pricing"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/pricing/confirm/{family}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["confirm_selection"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/pricing/refresh": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["refresh"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/stream": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["stream"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    AgentTool: {
      note?: string | null;
      status: string;
      tool: string;
    };
    Agents: {
      tools: components["schemas"]["AgentTool"][];
    };
    ApiError: {
      error: components["schemas"]["ErrorDetail"];
    };
    ErrorDetail: {
      code: string;
      message: string;
    };
    Family: {
      family: string;
      pending?: null | components["schemas"]["Selection"];
      rates?: null | components["schemas"]["Rates"];
      selected?: null | components["schemas"]["Selection"];
    };
    Fleet: {
      /** Format: int64 */
      generated_at_ms: number;
      nodes: components["schemas"]["Node"][];
    };
    FleetChange: {
      node: string;
      ok: boolean;
      service: string;
    };
    Gpu: {
      current?: null | components["schemas"]["GpuCurrent"];
      history: components["schemas"]["GpuHistory"][];
      loaded_models: string[];
    };
    GpuCurrent: {
      /** Format: double */
      memory_total_mib: number;
      /** Format: double */
      memory_used_mib: number;
      /** Format: double */
      power_w: number;
      /** Format: double */
      temperature_c: number;
      /** Format: int64 */
      ts_ms: number;
      /** Format: double */
      utilization_percent: number;
    };
    GpuHistory: {
      /** Format: double */
      memory_used_mib: number;
      /** Format: double */
      power_w: number;
      /** Format: double */
      temperature_c: number;
      /** Format: int64 */
      ts_ms: number;
      /** Format: double */
      utilization_percent: number;
    };
    Health: {
      /** Format: int64 */
      built_at_ms: number;
      git_dirty: boolean;
      git_sha: string;
      status: string;
      /** Format: int64 */
      uptime_ms: number;
      version: string;
    };
    LlmRequest: {
      client_hostname: string;
      /** Format: double */
      latency_ms: number;
      model?: string | null;
      /** Format: int64 */
      output_tokens?: number | null;
      /** Format: int64 */
      prompt_tokens?: number | null;
    };
    ModelUsage: {
      /** Format: double */
      avg_gen_tps?: number | null;
      /** Format: double */
      avg_prompt_tps?: number | null;
      model?: string | null;
      /** Format: int64 */
      output_tokens: number;
      /** Format: double */
      p50_latency_ms?: number | null;
      /** Format: double */
      p95_latency_ms?: number | null;
      /** Format: int64 */
      prompt_tokens: number;
      requests: number;
      /** Format: double */
      total_load_ms: number;
    };
    Node: {
      /** Format: int64 */
      last_seen_ms?: number | null;
      name: string;
      online: boolean;
      os?: string | null;
      services: components["schemas"]["Service"][];
      tailscale_ip?: string | null;
    };
    Pricing: {
      families: components["schemas"]["Family"][];
      warnings: string[];
    };
    PricingChanged: {
      family: string;
      pending_model_id?: string | null;
    };
    Rates: {
      /** Format: int64 */
      fetched_at_ms: number;
      /** Format: double */
      input_per_mtok: number;
      /** Format: double */
      output_per_mtok: number;
      source: string;
    };
    Selection: {
      /** Format: int64 */
      effective_from_ms: number;
      model_id: string;
    };
    Service: {
      /** Format: int64 */
      built_at_ms?: number | null;
      /** Format: int64 */
      checked_at_ms: number;
      detail?: string | null;
      git_dirty?: boolean | null;
      git_sha?: string | null;
      kind: components["schemas"]["ServiceKind"];
      /** Format: double */
      latency_ms?: number | null;
      name: string;
      ok: boolean;
      target: string;
      version?: string | null;
    };
    /** @enum {string} */
    ServiceKind: "http" | "tcp" | "systemd";
    SpendAvoided: {
      /** Format: double */
      estimated_usd: number;
      family: string;
      model_id?: string | null;
      unpriced_requests: number;
      /** Format: double */
      usd: number;
    };
    StreamEvent: {
      data: unknown;
      /** Format: int64 */
      ts_ms: number;
      type: string;
    };
    Totals: {
      /** Format: int64 */
      output_tokens: number;
      /** Format: int64 */
      prompt_tokens: number;
      requests: number;
    };
    Usage: {
      /** Format: int64 */
      generated_at_ms: number;
      models: components["schemas"]["ModelUsage"][];
      range: string;
      spend_avoided: components["schemas"]["SpendAvoided"][];
      totals: components["schemas"]["Totals"];
      warnings: string[];
    };
  };
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  agents: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Agents"];
        };
      };
    };
  };
  fleet: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Fleet"];
        };
      };
    };
  };
  gpu: {
    parameters: {
      query?: {
        /** @description 1h (default), 24h, 7d */
        range?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Gpu"];
        };
      };
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  health: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Health"];
        };
      };
    };
  };
  usage: {
    parameters: {
      query?: {
        /** @description 24h (default), 7d, 30d */
        range?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Usage"];
        };
      };
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  pricing: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Pricing"];
        };
      };
    };
  };
  confirm_selection: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        family: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Pricing"];
        };
      };
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  refresh: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Pricing"];
        };
      };
    };
  };
  stream: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "text/event-stream": components["schemas"]["StreamEvent"];
        };
      };
    };
  };
}
