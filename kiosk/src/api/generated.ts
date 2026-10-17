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
  "/v1/agents/refresh": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["refresh_agents"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/alerts": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Active alerts and the last 20 cleared ones, as posted to Slack `#factory-alerts`. */
    get: operations["alerts"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/devices": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["devices_list"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/devices/factory-gpu": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["device_current"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/devices/factory-gpu/history": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["device_history"];
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
  "/v1/settings/ups": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["get_ups_settings"];
    put: operations["put_ups_settings"];
    post?: never;
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
  "/v1/ups": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["ups"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/ups/energy": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Costs round half-up once per range. Coverage counts intervals between reads
     *     no more than 30s apart. An expired leading partial hour is omitted, not estimated.
     *     GPU energy uses the same covered UPS intervals and right-endpoint rounding.
     *     It is null if GPU coverage is missing or its energy exceeds the UPS load.
     */
    get: operations["ups_energy"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/ups/events": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["ups_events"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/ups/history": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Raw ranges use at most 720 time buckets. All metrics expose min/avg/max;
     *     runtime is the minimum. Longer ranges include the overlapping hourly bucket.
     */
    get: operations["ups_history"];
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
    ActiveAlert: {
      key: string;
      /** Format: int64 */
      opened_at_ms: number;
      severity: components["schemas"]["AlertSeverity"];
      summary: string;
    };
    AgentBalance: {
      /** @description Decimal strings preserve provider precision; amount equals remaining. */
      amount: string;
      /** @description Optional pool label; workspace USD has no inferred total. */
      label?: string | null;
      remaining: string;
      total?: string | null;
      unit: string;
    };
    AgentTool: {
      balance?: null | components["schemas"]["AgentBalance"];
      /** @description Amp has independent USD and normalized orb-hour pools. Never sum units. */
      balances: components["schemas"]["AgentBalance"][];
      cli_version?: string | null;
      note?: string | null;
      /** Format: int64 */
      observed_at_ms?: number | null;
      plan?: string | null;
      reason?: string | null;
      /** Format: int64 */
      reset_credits_available?: number | null;
      source?: string | null;
      status: string;
      tool: string;
      windows: components["schemas"]["AgentWindow"][];
    };
    AgentWindow: {
      name: string;
      /** Format: int64 */
      resets_at_ms?: number | null;
      /** Format: double */
      used_percent: number;
      /** Format: int64 */
      window_minutes?: number | null;
    };
    Agents: {
      tools: components["schemas"]["AgentTool"][];
    };
    AgentsRefresh: {
      /** Format: int64 */
      next_allowed_at_ms: number;
      /** @description Always "accepted"; completion arrives through agents.usage SSE. */
      status: string;
    };
    AgentsRefreshCooldown: {
      error: components["schemas"]["ErrorDetail"];
      /** Format: int64 */
      next_allowed_at_ms: number;
    };
    /** @enum {string} */
    AlertSeverity: "critical" | "warning" | "info";
    Alerts: {
      active: components["schemas"]["ActiveAlert"][];
      /** @description Last 20 cleared alerts, newest first. */
      recent: components["schemas"]["ClearedAlert"][];
    };
    ApiError: {
      error: components["schemas"]["ErrorDetail"];
    };
    /** @enum {string} */
    Availability: "available" | "unsupported" | "permission_denied" | "stale" | "error";
    BackupView: {
      availability: components["schemas"]["Availability"];
      error?: string | null;
      /** Format: int64 */
      last_attempt_ms?: number | null;
      /** Format: int64 */
      last_success_ms?: number | null;
      /** Format: int64 */
      observed_at_ms: number;
    };
    ClearedAlert: {
      /** Format: int64 */
      cleared_at_ms: number;
      key: string;
      /** Format: int64 */
      opened_at_ms: number;
      severity: components["schemas"]["AlertSeverity"];
      summary: string;
    };
    ClockView: {
      availability: components["schemas"]["Availability"];
      /** Format: int64 */
      observed_at_ms: number;
      synchronized?: boolean | null;
    };
    CollectorHealth: {
      detail?: string | null;
      drives: components["schemas"]["Availability"];
      /** Format: int64 */
      fast_interval_ms: number;
      fast_ok: boolean;
      filesystems: components["schemas"]["Availability"];
      /** Format: int64 */
      last_fast_ms?: number | null;
      /** Format: int64 */
      last_slow_ms?: number | null;
      /** Format: int64 */
      slow_interval_ms: number;
      smart: components["schemas"]["Availability"];
    };
    Cooling: {
      fans: components["schemas"]["NamedMetric"][];
      fans_availability: components["schemas"]["Availability"];
      temperatures: components["schemas"]["NamedMetric"][];
      temperatures_availability: components["schemas"]["Availability"];
    };
    Cpu: {
      iowait: components["schemas"]["Metric"];
      load1: components["schemas"]["Metric"];
      load15: components["schemas"]["Metric"];
      load5: components["schemas"]["Metric"];
      temperature: components["schemas"]["Metric"];
      utilization: components["schemas"]["Metric"];
    };
    DeviceHistory: {
      device_id: string;
      /** Format: int64 */
      generated_at_ms: number;
      points: components["schemas"]["DevicePoint"][];
      range: string;
    };
    DeviceList: {
      devices: components["schemas"]["DeviceSummary"][];
      /** Format: int64 */
      generated_at_ms: number;
    };
    DeviceMetric: {
      /** Format: double */
      avg?: number | null;
      /** Format: double */
      max?: number | null;
      /** Format: double */
      min?: number | null;
    };
    DevicePoint: {
      cpu_percent: components["schemas"]["DeviceMetric"];
      cpu_temp_c: components["schemas"]["DeviceMetric"];
      disk_read_bps: components["schemas"]["DeviceMetric"];
      disk_write_bps: components["schemas"]["DeviceMetric"];
      load1: components["schemas"]["DeviceMetric"];
      memory_used_bytes: components["schemas"]["DeviceMetric"];
      net_rx_bps: components["schemas"]["DeviceMetric"];
      net_tx_bps: components["schemas"]["DeviceMetric"];
      /** Format: int64 */
      sample_count: number;
      /** Format: int64 */
      ts_ms: number;
    };
    DeviceSummary: {
      device_id: string;
      health: components["schemas"]["HealthStatus"];
      href: string;
    };
    DeviceView: {
      device: components["schemas"]["HostSnapshot"];
      /** Format: int64 */
      generated_at_ms: number;
      warnings: string[];
    };
    DiskIo: {
      read: components["schemas"]["Metric"];
      write: components["schemas"]["Metric"];
    };
    Drive: {
      available_spare: components["schemas"]["Metric"];
      id: string;
      kernel: string;
      media_critical: boolean;
      media_errors: components["schemas"]["Metric"];
      model?: string | null;
      size: components["schemas"]["Metric"];
      smart: components["schemas"]["SmartStatus"];
      /** Format: double */
      spare_threshold_percent?: number | null;
      temperature: components["schemas"]["Metric"];
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
    Filesystem: {
      fstype: string;
      id: string;
      inodes_used_percent: components["schemas"]["Metric"];
      mountpoint: string;
      size: components["schemas"]["Metric"];
      source: string;
      used: components["schemas"]["Metric"];
      used_percent: components["schemas"]["Metric"];
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
    GpuSlot: {
      /** Format: int64 */
      index: number;
      memory_total: components["schemas"]["Metric"];
      memory_used: components["schemas"]["Metric"];
      power: components["schemas"]["Metric"];
      temperature: components["schemas"]["Metric"];
      utilization: components["schemas"]["Metric"];
    };
    Health: {
      /** Format: int64 */
      built_at_ms: number;
      git_dirty: boolean;
      git_sha: string;
      inputs_fingerprint: string;
      status: string;
      /** Format: int64 */
      uptime_ms: number;
      version: string;
    };
    HealthReason: {
      detail: string;
      metric: string;
      status: components["schemas"]["HealthStatus"];
      threshold: string;
      /** Format: double */
      value?: number | null;
    };
    HealthReport: {
      reasons: components["schemas"]["HealthReason"][];
      status: components["schemas"]["HealthStatus"];
    };
    /** @enum {string} */
    HealthStatus: "critical" | "warning" | "healthy" | "unknown" | "stale";
    HostIdentity: {
      boot_id?: string | null;
      hostname?: string | null;
      uptime: components["schemas"]["Metric"];
    };
    HostSnapshot: {
      collector: components["schemas"]["CollectorHealth"];
      cooling: components["schemas"]["Cooling"];
      cpu: components["schemas"]["Cpu"];
      device_id: string;
      disk_io: components["schemas"]["DiskIo"];
      drives: components["schemas"]["Drive"][];
      filesystems: components["schemas"]["Filesystem"][];
      gpus: components["schemas"]["GpuSlot"][];
      health: components["schemas"]["HealthReport"];
      identity: components["schemas"]["HostIdentity"];
      maintenance: components["schemas"]["Maintenance"];
      memory: components["schemas"]["Ram"];
      network: components["schemas"]["Network"];
      /** Format: int64 */
      observed_at_ms: number;
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
    Maintenance: {
      backup: components["schemas"]["BackupView"];
      clock: components["schemas"]["ClockView"];
      reboot: components["schemas"]["RebootView"];
      services: components["schemas"]["Service"][];
      ups: components["schemas"]["UpsSummary"];
    };
    Metric: {
      availability: components["schemas"]["Availability"];
      detail?: string | null;
      /** Format: int64 */
      observed_at_ms: number;
      unit: string;
      /** Format: double */
      value?: number | null;
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
    NamedMetric: {
      metric: components["schemas"]["Metric"];
      name: string;
    };
    Network: {
      rx: components["schemas"]["Metric"];
      tx: components["schemas"]["Metric"];
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
    Ram: {
      available: components["schemas"]["Metric"];
      swap_free: components["schemas"]["Metric"];
      swap_total: components["schemas"]["Metric"];
      total: components["schemas"]["Metric"];
      used: components["schemas"]["Metric"];
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
    RebootView: {
      alert_due?: boolean | null;
      availability: components["schemas"]["Availability"];
      /** Format: int64 */
      consecutive_skips?: number | null;
      /** Format: int64 */
      days_pending?: number | null;
      detail?: string | null;
      /** Format: int64 */
      last_check_ms?: number | null;
      last_decision?: string | null;
      /** Format: int64 */
      pending_since_ms?: number | null;
      reboot_required?: boolean | null;
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
      inputs_fingerprint?: string | null;
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
    SmartStatus: {
      availability: components["schemas"]["Availability"];
      detail?: string | null;
      /** Format: int64 */
      observed_at_ms: number;
      passed?: boolean | null;
    };
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
      /**
       * @description Named SSE event: gpu.sample, ups.sample, ups.event, llm.request, fleet.change,
       *     pricing.changed, agents.usage, or devices.sample. ups.sample data is UpsCurrent or null
       *     on failure. devices.sample data is a device view, or null when the collector fails.
       *     History is not in the event.
       *     ups.event data is UpsEvent, sent once when an event opens and once when it closes.
       *     Zero-length self_test events send both an open frame and a closed frame.
       */
      type: string;
    };
    Totals: {
      /** Format: int64 */
      output_tokens: number;
      /** Format: int64 */
      prompt_tokens: number;
      requests: number;
    };
    Ups: {
      current?: null | components["schemas"]["UpsCurrent"];
      /** Format: int64 */
      generated_at_ms: number;
      warnings: string[];
    };
    UpsCurrent: {
      /** Format: double */
      battery_v?: number | null;
      /** Format: double */
      charge_low_percent?: number | null;
      /** Format: double */
      charge_percent?: number | null;
      /** Format: double */
      charge_warning_percent?: number | null;
      flags: string[];
      /** Format: double */
      input_v?: number | null;
      /** Format: double */
      load_nominal_w?: number | null;
      /** Format: double */
      load_percent?: number | null;
      /** Format: double */
      load_w?: number | null;
      low_battery?: boolean | null;
      model?: string | null;
      on_battery?: boolean | null;
      on_line?: boolean | null;
      /** Format: double */
      output_v?: number | null;
      replace_battery?: boolean | null;
      /** Format: int64 */
      runtime_low_s?: number | null;
      /** Format: int64 */
      runtime_s?: number | null;
      status?: string | null;
      test_result?: string | null;
      /** Format: int64 */
      ts_ms: number;
    };
    UpsEnergy: {
      /** Format: int64 */
      cost_nano_usd?: number | null;
      /** Format: double */
      coverage_percent: number;
      /** Format: int64 */
      electricity_rate_micro_usd_per_kwh?: number | null;
      /** Format: int64 */
      energy_mwh: number;
      /** Format: int64 */
      gpu_energy_mwh?: number | null;
    };
    UpsEvent: {
      detail?: string | null;
      end_reason?: string | null;
      /** Format: int64 */
      ended_ms?: number | null;
      /** Format: int64 */
      id: number;
      kind: string;
      /** Format: double */
      min_charge_percent?: number | null;
      /** Format: int64 */
      min_runtime_s?: number | null;
      /** Format: int64 */
      started_ms: number;
    };
    UpsEvents: {
      events: components["schemas"]["UpsEvent"][];
      /** Format: int64 */
      next_before_id?: number | null;
      /**
       * Format: int64
       * @description Pass both cursor fields to avoid skipping simultaneous transitions.
       */
      next_before_ms?: number | null;
    };
    UpsMetric: {
      /** Format: double */
      avg?: number | null;
      /** Format: double */
      max?: number | null;
      /** Format: double */
      min?: number | null;
    };
    UpsPoint: {
      charge_percent: components["schemas"]["UpsMetric"];
      input_v: components["schemas"]["UpsMetric"];
      load_w: components["schemas"]["UpsMetric"];
      /** Format: int64 */
      runtime_s?: number | null;
      /** Format: int64 */
      sample_count: number;
      /** Format: int64 */
      ts_ms: number;
    };
    UpsSettings: {
      /** Format: int64 */
      battery_installed_ms: number | null;
      /** Format: int64 */
      electricity_rate_micro_usd_per_kwh: number | null;
    };
    UpsSummary: {
      availability: components["schemas"]["Availability"];
      /** Format: double */
      charge_percent?: number | null;
      detail?: string | null;
      href: string;
      /** Format: int64 */
      observed_at_ms: number;
      status?: string | null;
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
  refresh_agents: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AgentsRefresh"];
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
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      429: {
        headers: {
          /** @description Seconds until next refresh, rounded up */
          "Retry-After"?: number;
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AgentsRefreshCooldown"];
        };
      };
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  alerts: {
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
          "application/json": components["schemas"]["Alerts"];
        };
      };
    };
  };
  devices_list: {
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
          "application/json": components["schemas"]["DeviceList"];
        };
      };
    };
  };
  device_current: {
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
          "application/json": components["schemas"]["DeviceView"];
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
    };
  };
  device_history: {
    parameters: {
      query?: {
        /** @description 1h (default), 24h, or 7d */
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
          "application/json": components["schemas"]["DeviceHistory"];
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
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
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
  get_ups_settings: {
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
          "application/json": components["schemas"]["UpsSettings"];
        };
      };
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  put_ups_settings: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["UpsSettings"];
      };
    };
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["UpsSettings"];
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
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
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
  ups: {
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
          "application/json": components["schemas"]["Ups"];
        };
      };
    };
  };
  ups_energy: {
    parameters: {
      query?: {
        /** @description 1h, 24h (default), 7d, 30d, 365d */
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
          "application/json": components["schemas"]["UpsEnergy"];
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
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  ups_events: {
    parameters: {
      query?: {
        /** @description 1–200; default 50 */
        limit?: number;
        /** @description Exclusive timestamp cursor */
        before_ms?: number;
        /** @description Use with next_before_ms to page simultaneous events without loss */
        before_id?: number;
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
          "application/json": components["schemas"]["UpsEvents"];
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
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  ups_history: {
    parameters: {
      query?: {
        /** @description 1h, 24h (default), 7d, 30d, 365d */
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
          "application/json": components["schemas"]["UpsPoint"][];
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
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
}
