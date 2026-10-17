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
  "/v1/devices/{device_id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * An enrolled remote device: stale after 45 s of transport or collection age, and
     *     `unknown` until its first fresh sample since factory-api started. `factory-gpu`
     *     is served the same way at its literal path.
     */
    get: operations["remote_device_current"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/devices/{device_id}/history": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["remote_device_history"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/devices/{device_id}/samples": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * One remote sample (docs/devices-ingest.md). Checks run in the contract's order:
     *     method, Sec-Fetch-Site, credential, device binding, content type, body size,
     *     JSON and schema, then rate. Errors use ApiError, adding `error.field` and, for
     *     `unsupported_schema_version`, `accepted_schema_versions`.
     */
    post: operations["ingest_sample"];
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
  "/v1/network": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Every registry target in layer order with its latest stored sample (null
     *     before the first tick), plus network and clock warnings.
     */
    get: operations["network"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/network/events": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Degraded and down episodes, newest first by started_ms then id, the open one included. */
    get: operations["network_events"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/network/history": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * 1h and 24h read raw bursts in at most 720 buckets per target; jitter is the
     *     mean of the bursts' mdev. 7d and 30d read hourly rollups; jitter is the
     *     nearest-rank p95 of each hour's mdev values. Loss is lost replies over sent.
     */
    get: operations["network_history"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/network/speed-tests": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Throughput tests that started within the range, for charts. */
    get: operations["network_speed_tests"];
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
    Burst: {
      /** Format: int32 */
      received: number;
      rtt?: null | components["schemas"]["Rtt"];
      /** Format: int32 */
      sent: number;
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
      ingest?: null | components["schemas"]["IngestView"];
      maintenance?: null | components["schemas"]["NodeMaintenance"];
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
      /** Format: int64 */
      unsafe_shutdowns?: number | null;
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
    IngestResult: {
      current_updated: boolean;
      device_id: string;
      history_written: boolean;
      /** Format: int64 */
      observed_at_ms: number;
      /** @description Null on stored, except `clock_unsynchronized`; `duplicate`, `out_of_order` or `expired` on ignored. */
      reason?: string | null;
      /** Format: int64 */
      received_at_ms: number;
      /** @description `stored` or `ignored`. */
      result: string;
      /** Format: int64 */
      seq: number;
      session_id: string;
    };
    IngestView: {
      agent_version?: string | null;
      /**
       * Format: int64
       * @description `sent_at_ms - received_at_ms` of the last accepted request, including latency.
       */
      clock_skew_ms?: number | null;
      /**
       * Format: int64
       * @description Sequence gaps within a session since factory-api started.
       */
      dropped_samples: number;
      identity_conflict: boolean;
      /**
       * Format: int64
       * @description Server clock when the last accepted sample arrived; null before the first one.
       */
      last_received_at_ms?: number | null;
      /** Format: int64 */
      seq?: number | null;
      session_id?: string | null;
      /** @description Always `remote`. */
      source: string;
    };
    /**
     * @description Declaration order is registry order; diagnosis blames the first failing layer.
     * @enum {string}
     */
    Layer: "lan" | "wan" | "dns" | "tailnet";
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
    MaintenanceProbe_AutoUpdate:
      | ({
          apply: boolean;
          check: boolean;
        } & {
          /** @enum {string} */
          availability: "available";
        })
      | {
          /** @enum {string} */
          availability: "unsupported";
          error?: string | null;
        }
      | {
          /** @enum {string} */
          availability: "error";
          error?: string | null;
        };
    MaintenanceProbe_HeldPackages:
      | ({
          packages: string[];
        } & {
          /** @enum {string} */
          availability: "available";
        })
      | {
          /** @enum {string} */
          availability: "unsupported";
          error?: string | null;
        }
      | {
          /** @enum {string} */
          availability: "error";
          error?: string | null;
        };
    MaintenanceProbe_JournalSize:
      | ({
          /** Format: int64 */
          value: number;
        } & {
          /** @enum {string} */
          availability: "available";
        })
      | {
          /** @enum {string} */
          availability: "unsupported";
          error?: string | null;
        }
      | {
          /** @enum {string} */
          availability: "error";
          error?: string | null;
        };
    MaintenanceProbe_RebootSetting:
      | ({
          value: boolean;
        } & {
          /** @enum {string} */
          availability: "available";
        })
      | {
          /** @enum {string} */
          availability: "unsupported";
          error?: string | null;
        }
      | {
          /** @enum {string} */
          availability: "error";
          error?: string | null;
        };
    MaintenanceProbe_UpdateCounts:
      | ({
          /** Format: int64 */
          other: number;
          /** Format: int64 */
          security: number;
        } & {
          /** @enum {string} */
          availability: "available";
        })
      | {
          /** @enum {string} */
          availability: "unsupported";
          error?: string | null;
        }
      | {
          /** @enum {string} */
          availability: "error";
          error?: string | null;
        };
    /** @enum {string} */
    MaintenanceServiceState: "enabled" | "disabled" | "absent" | "unknown";
    MaintenanceServices: {
      availability: components["schemas"]["ProbeAvailability"];
      error?: string | null;
      fstrim_timer: components["schemas"]["MaintenanceServiceState"];
      smartd: components["schemas"]["MaintenanceServiceState"];
      unattended_upgrades: components["schemas"]["MaintenanceServiceState"];
    };
    MaintenanceSnapshot: {
      held: components["schemas"]["MaintenanceProbe_HeldPackages"];
      journal_bytes: components["schemas"]["MaintenanceProbe_JournalSize"];
      /** Format: int64 */
      observed_at_ms: number;
      /** Format: int32 */
      schema: number;
      services: components["schemas"]["MaintenanceServices"];
      tailscale_auto_update: components["schemas"]["MaintenanceProbe_AutoUpdate"];
      unattended_auto_reboot: components["schemas"]["MaintenanceProbe_RebootSetting"];
      updates: components["schemas"]["MaintenanceProbe_UpdateCounts"];
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
    /** @enum {string} */
    NetworkEndReason: "recovered" | "changed" | "restart";
    /**
     * @description One degraded or down episode. `state`, `layer` and `reason` are the link
     *     state it records; it is never healthy.
     */
    NetworkEvent: components["schemas"]["NetworkLinkState"] & {
      end_reason?: null | components["schemas"]["NetworkEndReason"];
      /**
       * Format: int64
       * @description Null while the episode is open.
       */
      ended_ms?: number | null;
      /** Format: int64 */
      id: number;
      /**
       * Format: double
       * @description Peaks over the faulting layer's chosen targets while the episode lasted.
       */
      peak_loss_percent?: number | null;
      /** Format: int64 */
      peak_mdev_us?: number | null;
      /**
       * Format: int64
       * @description Average RTT; null while nothing came back.
       */
      peak_rtt_us?: number | null;
      /** Format: int64 */
      started_ms: number;
    };
    NetworkEvents: {
      /** @description Newest first: started_ms descending, then id descending. */
      events: components["schemas"]["NetworkEvent"][];
      /**
       * Format: int64
       * @description The last event's id, to pass as `before` for the next page; null on the last page.
       */
      next_before?: number | null;
    };
    NetworkHistory: {
      range: string;
      resolution: components["schemas"]["Resolution"];
      series: components["schemas"]["NetworkSeries"][];
    };
    NetworkLatency: {
      /** Format: double */
      avg?: number | null;
      /** Format: double */
      max?: number | null;
      /** Format: double */
      min?: number | null;
    };
    NetworkLinkState:
      | {
          /** @enum {string} */
          state: "healthy";
        }
      | {
          layer: components["schemas"]["Layer"];
          reason: components["schemas"]["NetworkReason"];
          /** @enum {string} */
          state: "degraded";
        }
      | {
          layer: components["schemas"]["Layer"];
          /** @enum {string} */
          state: "down";
        };
    NetworkPoint: {
      /**
       * Format: double
       * @description Raw buckets: mean of the bursts' mdev. Hourly points: nearest-rank p95.
       */
      jitter_ms?: number | null;
      /** @description Average is weighted by received replies; all null when nothing came back. */
      latency_ms: components["schemas"]["NetworkLatency"];
      /** Format: double */
      loss_percent: number;
      /** Format: int64 */
      sample_count: number;
      /** Format: int64 */
      ts_ms: number;
    };
    /** @enum {string} */
    NetworkReason: "loss" | "latency" | "jitter";
    NetworkSeries: {
      layer: components["schemas"]["Layer"];
      points: components["schemas"]["NetworkPoint"][];
      target: string;
    };
    /** @enum {string} */
    NetworkSpeedOutcome: "ok" | "failed" | "timeout";
    /** @description One stored throughput test. Rates are bits per second; latencies are average RTT to the first wan target. */
    NetworkSpeedTest: {
      /** @description Cloudflare colo code. The public IP is never stored. */
      colo?: string | null;
      /**
       * Format: int64
       * @description Nearest-rank p90 of per-request rates; null unless the outcome is ok.
       */
      download_bps?: number | null;
      /**
       * Format: int64
       * @description Bytes moved, for every outcome.
       */
      download_bytes: number;
      /**
       * Format: double
       * @description Bursts run while that direction transferred.
       */
      download_loaded_latency_ms?: number | null;
      /** Format: int64 */
      ended_ms: number;
      /** @description Always set for failed tests. */
      error?: string | null;
      /** Format: int64 */
      id: number;
      /**
       * Format: double
       * @description One burst before the transfers.
       */
      idle_latency_ms?: number | null;
      outcome: components["schemas"]["NetworkSpeedOutcome"];
      /** Format: int64 */
      started_ms: number;
      /** Format: int64 */
      upload_bps?: number | null;
      /** Format: int64 */
      upload_bytes: number;
      /** Format: double */
      upload_loaded_latency_ms?: number | null;
    };
    NetworkSpeedTests: {
      range: string;
      /** @description Oldest first. */
      tests: components["schemas"]["NetworkSpeedTest"][];
    };
    NetworkStatus: {
      device_id: string;
      /** Format: int64 */
      generated_at_ms: number;
      latest_speed_test?: null | components["schemas"]["NetworkSpeedTest"];
      open_event?: null | components["schemas"]["NetworkEvent"];
      /** @description The stored open event's state; healthy when none is open. */
      state: components["schemas"]["NetworkLinkState"];
      /** @description Registry order: lan, wan, dns, tailnet. */
      targets: components["schemas"]["NetworkTarget"][];
      warnings: string[];
    };
    NetworkTarget: {
      latest?: null | components["schemas"]["Sample"];
      layer: components["schemas"]["Layer"];
      probe: components["schemas"]["ProbeKind"];
      target: string;
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
    NodeMaintenance:
      | (components["schemas"]["MaintenanceSnapshot"] & {
          /** @enum {string} */
          availability: "available";
        })
      | (components["schemas"]["MaintenanceSnapshot"] & {
          /** @enum {string} */
          availability: "stale";
        })
      | {
          /** @enum {string} */
          availability: "permission_denied";
          error: string;
        }
      | {
          /** @enum {string} */
          availability: "unsupported";
          error: string;
        }
      | {
          /** @enum {string} */
          availability: "error";
          error: string;
        };
    Pricing: {
      families: components["schemas"]["Family"][];
      warnings: string[];
    };
    PricingChanged: {
      family: string;
      pending_model_id?: string | null;
    };
    /** @enum {string} */
    ProbeAvailability: "available" | "unsupported" | "error";
    /** @enum {string} */
    ProbeKind: "icmp" | "resolve" | "tcp_connect";
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
    /** @enum {string} */
    Resolution: "raw" | "hourly";
    Rtt: {
      /** Format: int64 */
      avg_us: number;
      /** Format: int64 */
      max_us: number;
      /**
       * Format: int64
       * @description Jitter, as iputils computes it: the population standard deviation.
       */
      mdev_us: number;
      /** Format: int64 */
      min_us: number;
    };
    Sample: components["schemas"]["Burst"] & {
      /**
       * @description What was probed: the gateway or WAN IP, the resolved name, or the
       *     resolved tailnet socket address. Null when it could not be found.
       */
      address?: string | null;
      layer: components["schemas"]["Layer"];
      target: string;
      /**
       * Format: int64
       * @description Start of the tick; every target in one tick shares it.
       */
      ts_ms: number;
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
       * @description Named SSE event: gpu.sample, ups.sample, ups.event, network.sample, network.speedtest,
       *     llm.request, fleet.change, pricing.changed, agents.usage, or devices.sample. ups.sample
       *     data is UpsCurrent or null on failure. devices.sample data is a device view, or null when
       *     the collector fails. History is not in the event.
       *     ups.event data is UpsEvent, sent once when an event opens and once when it closes.
       *     Zero-length self_test events send both an open frame and a closed frame.
       *     network.sample data is the array of Sample probed by one 30-second tick.
       *     network.speedtest data is the NetworkSpeedTest row, sent once after it is stored.
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
      /**
       * @description True when percentiles come from merged fixed-bucket latency histograms
       *     (ranges beyond 30 days); otherwise they are exact nearest-rank values.
       */
      percentiles_approximate?: boolean;
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
  remote_device_current: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        device_id: string;
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
  remote_device_history: {
    parameters: {
      query?: {
        /** @description 1h (default), 24h, or 7d */
        range?: string;
      };
      header?: never;
      path: {
        device_id: string;
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
  ingest_sample: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        device_id: string;
      };
      cookie?: never;
    };
    /** @description Schema version 1 sample; see docs/devices-ingest.md */
    requestBody: {
      content: {
        "application/json": Record<string, never>;
      };
    };
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["IngestResult"];
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
      401: {
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
      405: {
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
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      429: {
        headers: {
          /** @description Seconds before retrying */
          "Retry-After"?: number;
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
        /** @description 24h (default), 7d, 30d, 365d. Percentiles are exact nearest-rank values through 30d; 365d percentiles come from merged latency histograms and set percentiles_approximate. */
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
  network: {
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
          "application/json": components["schemas"]["NetworkStatus"];
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
  network_events: {
    parameters: {
      query?: {
        /** @description 1–200; default 50 */
        limit?: number;
        /** @description Exclusive cursor: an event id, such as the previous page's next_before. The page continues after that event in (started_ms, id) descending order; an unknown id is a 400. */
        before?: number;
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
          "application/json": components["schemas"]["NetworkEvents"];
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
  network_history: {
    parameters: {
      query?: {
        /** @description 1h, 24h (default), 7d, 30d */
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
          "application/json": components["schemas"]["NetworkHistory"];
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
  network_speed_tests: {
    parameters: {
      query?: {
        /** @description 24h, 7d (default), 30d, 365d */
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
          "application/json": components["schemas"]["NetworkSpeedTests"];
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
