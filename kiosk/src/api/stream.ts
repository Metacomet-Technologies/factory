import { useEffect, useReducer, useState } from "react";
import { apiUrl } from "./client";
import { DEVICE_ID } from "../lib/devices";
import type { Agents, DeviceView, GpuSample, UpsCurrent, StreamEvent } from "./types";

export interface LiveState {
  gpu: GpuSample | null | undefined;
  ups: UpsCurrent | null | undefined;
  upsAt: number;
  upsSamples: UpsCurrent[];
  upsWarningRevision: number;
  upsEventRevision: number;
  agents: Agents | null;
  requests: Extract<StreamEvent, { type: "llm.request" }>[];
  fleetRevision: number;
  pricingRevision: number;
  agentsRevision: number;
  devices: DeviceView | null | undefined;
  devicesAt: number;
  devicesRevision: number;
  /** Latest pushed view per remote device; factory-gpu stays in `devices`. */
  remoteDevices: Record<string, DeviceView>;
  networkRevision: number;
}
export const initialLiveState: LiveState = {
  gpu: undefined,
  ups: undefined,
  upsAt: 0,
  upsSamples: [],
  upsWarningRevision: 0,
  upsEventRevision: 0,
  agents: null,
  requests: [],
  fleetRevision: 0,
  pricingRevision: 0,
  agentsRevision: 0,
  devices: undefined,
  devicesAt: 0,
  devicesRevision: 0,
  remoteDevices: {},
  networkRevision: 0,
};
export function streamReducer(state: LiveState, event: StreamEvent): LiveState {
  switch (event.type) {
    case "gpu.sample":
      return { ...state, gpu: event.data };
    case "ups.sample":
      return {
        ...state,
        ups: event.data,
        upsAt: event.ts_ms,
        upsWarningRevision: state.upsWarningRevision + (event.data === null ? 1 : 0),
        upsSamples: event.data
          ? [
              ...state.upsSamples.filter(
                (sample) =>
                  sample.ts_ms > event.ts_ms - 900_000 && sample.ts_ms < event.data!.ts_ms,
              ),
              event.data,
            ].slice(-180)
          : state.upsSamples,
      };
    case "ups.event":
      return { ...state, upsEventRevision: state.upsEventRevision + 1 };
    case "llm.request":
      return { ...state, requests: [event, ...state.requests].slice(0, 6) };
    case "fleet.change":
      return { ...state, fleetRevision: state.fleetRevision + 1 };
    case "pricing.changed":
      return { ...state, pricingRevision: state.pricingRevision + 1 };
    case "agents.usage":
      return { ...state, agents: event.data, agentsRevision: state.agentsRevision + 1 };
    case "devices.sample":
      // Null keeps its phase-1 meaning (the factory-gpu collector failed); remote devices never send it.
      if (event.data && event.data.device.device_id !== "factory-gpu")
        return {
          ...state,
          remoteDevices: { ...state.remoteDevices, [event.data.device.device_id]: event.data },
          devicesRevision: state.devicesRevision + 1,
        };
      return {
        ...state,
        devices: event.data,
        devicesAt: event.ts_ms,
        devicesRevision: state.devicesRevision + 1,
      };
    case "network.sample":
    case "network.speedtest":
      return { ...state, networkRevision: state.networkRevision + 1 };
  }
}

// Named factory-api events carry the JSON envelope. Default messages remain
// accepted for older fixture servers; malformed payloads never reach the UI.
export function parseEvent(value: unknown): StreamEvent | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("type" in value) ||
    !("ts_ms" in value) ||
    !("data" in value) ||
    typeof value.ts_ms !== "number" ||
    !Number.isFinite(value.ts_ms)
  )
    return null;
  const data = value.data;
  if (
    (value.type === "gpu.sample" ||
      value.type === "ups.sample" ||
      value.type === "devices.sample") &&
    data === null
  )
    return value as StreamEvent;
  if (!data || typeof data !== "object") return null;
  const fields = data as Record<string, unknown>;
  const numbers = (keys: string[]) =>
    keys.every((key) => typeof fields[key] === "number" && Number.isFinite(fields[key]));
  const strings = (keys: string[]) => keys.every((key) => typeof fields[key] === "string");
  switch (value.type) {
    case "ups.event":
      if (
        numbers(["id", "started_ms"]) &&
        ["on_battery", "low_battery", "replace_battery", "comms_lost", "self_test"].includes(
          String(fields.kind),
        ) &&
        ["ended_ms", "min_charge_percent", "min_runtime_s"].every(
          (key) =>
            fields[key] == null ||
            (typeof fields[key] === "number" && Number.isFinite(fields[key])),
        ) &&
        ["detail", "end_reason"].every(
          (key) => fields[key] == null || typeof fields[key] === "string",
        )
      )
        return value as StreamEvent;
      break;
    case "ups.sample":
      if (
        numbers(["ts_ms"]) &&
        Array.isArray(fields.flags) &&
        fields.flags.every((flag: unknown) => typeof flag === "string") &&
        ["status", "model", "test_result"].every(
          (key) => fields[key] == null || typeof fields[key] === "string",
        ) &&
        ["on_line", "on_battery", "low_battery", "replace_battery"].every(
          (key) => fields[key] == null || typeof fields[key] === "boolean",
        ) &&
        [
          "charge_percent",
          "charge_low_percent",
          "charge_warning_percent",
          "runtime_s",
          "runtime_low_s",
          "load_percent",
          "load_w",
          "load_nominal_w",
          "input_v",
          "output_v",
          "battery_v",
        ].every(
          (key) =>
            fields[key] == null ||
            (typeof fields[key] === "number" && Number.isFinite(fields[key])),
        )
      )
        return value as StreamEvent;
      break;
    case "gpu.sample":
      if (
        numbers([
          "memory_used_mib",
          "memory_total_mib",
          "utilization_percent",
          "temperature_c",
          "power_w",
          "ts_ms",
        ])
      )
        return value as StreamEvent;
      break;
    case "llm.request":
      if (
        strings(["client_hostname"]) &&
        (fields.model == null || typeof fields.model === "string") &&
        ["prompt_tokens", "output_tokens"].every(
          (key) =>
            fields[key] == null ||
            (typeof fields[key] === "number" &&
              Number.isSafeInteger(fields[key]) &&
              fields[key] >= 0),
        ) &&
        numbers(["latency_ms"])
      )
        return value as StreamEvent;
      break;
    case "fleet.change":
      if (strings(["node", "service"]) && typeof fields.ok === "boolean")
        return value as StreamEvent;
      break;
    case "pricing.changed":
      if (
        strings(["family"]) &&
        (fields.pending_model_id == null || typeof fields.pending_model_id === "string")
      )
        return value as StreamEvent;
      break;
    case "devices.sample": {
      const device = fields.device;
      if (
        typeof fields.generated_at_ms !== "number" ||
        !Array.isArray(fields.warnings) ||
        !device ||
        typeof device !== "object"
      )
        break;
      const host = device as Record<string, unknown>;
      const health = host.health as Record<string, unknown> | undefined;
      const cpu = host.cpu as Record<string, unknown> | undefined;
      const utilization = cpu?.utilization as Record<string, unknown> | undefined;
      if (
        typeof host.device_id === "string" &&
        DEVICE_ID.test(host.device_id) &&
        health &&
        ["critical", "warning", "healthy", "unknown", "stale"].includes(String(health.status)) &&
        utilization &&
        (utilization.value == null ||
          (typeof utilization.value === "number" && Number.isFinite(utilization.value)))
      )
        return value as StreamEvent;
      break;
    }
    case "network.sample":
      if (
        Array.isArray(data) &&
        data.every(
          (sample: unknown) =>
            !!sample &&
            typeof sample === "object" &&
            "ts_ms" in sample &&
            Number.isFinite(sample.ts_ms) &&
            "target" in sample &&
            typeof sample.target === "string",
        )
      )
        return value as StreamEvent;
      break;
    case "network.speedtest":
      if (
        numbers(["id", "started_ms", "ended_ms"]) &&
        ["ok", "failed", "timeout"].includes(String(fields.outcome))
      )
        return value as StreamEvent;
      break;
    case "agents.usage":
      if (
        Array.isArray(fields.tools) &&
        fields.tools.every((tool: unknown) => {
          if (!tool || typeof tool !== "object") return false;
          const t = tool as Record<string, unknown>;
          const balance = (value: unknown) => {
            if (!value || typeof value !== "object") return false;
            const b = value as Record<string, unknown>;
            return (
              ["unit", "amount", "remaining"].every((key) => typeof b[key] === "string") &&
              ["label", "total"].every((key) => b[key] == null || typeof b[key] === "string")
            );
          };
          return (
            ["tool", "status"].every((key) => typeof t[key] === "string") &&
            ["source", "cli_version", "plan", "reason"].every(
              (key) => t[key] == null || typeof t[key] === "string",
            ) &&
            (t.observed_at_ms == null || Number.isSafeInteger(t.observed_at_ms)) &&
            (t.balance == null || balance(t.balance)) &&
            Array.isArray(t.balances) &&
            t.balances.every(balance) &&
            Array.isArray(t.windows) &&
            t.windows.every((window: unknown) => {
              if (!window || typeof window !== "object") return false;
              const w = window as Record<string, unknown>;
              return (
                typeof w.name === "string" &&
                typeof w.used_percent === "number" &&
                Number.isFinite(w.used_percent) &&
                (w.resets_at_ms == null || Number.isSafeInteger(w.resets_at_ms))
              );
            })
          );
        })
      )
        return value as StreamEvent;
      break;
  }
  return null;
}

export type StreamStatus = "connecting" | "live" | "reconnecting";

const EVENT_TYPES = [
  "gpu.sample",
  "ups.sample",
  "ups.event",
  "llm.request",
  "fleet.change",
  "pricing.changed",
  "agents.usage",
  "devices.sample",
  "network.sample",
  "network.speedtest",
];
/** factory-api emits gpu.sample every 15 s even without a GPU, so 45 s of silence means a dead socket. */
export const STREAM_SILENCE_MS = 45_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
// EventSource.CLOSED; read as a literal because tests stub the global without static fields.
const CLOSED = 2;

/**
 * Live SSE connection with three layers of recovery on top of the browser's own retry:
 * a silence watchdog that drops and reopens a socket that stopped delivering events,
 * a jittered exponential backoff when the browser gave up (readyState CLOSED after an
 * HTTP error), and an immediate reopen when the tab regains network or visibility.
 * Every reopen after the first bumps `snapshotRevision` so REST views refetch what the
 * stream may have missed.
 */
export function useStream() {
  const [state, dispatch] = useReducer(streamReducer, initialLiveState);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [snapshotRevision, setSnapshotRevision] = useState(0);
  useEffect(() => {
    let source: EventSource | null = null;
    let opened = false;
    let attempts = 0;
    let disposed = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const lost = () => {
      setStatus("reconnecting");
      dispatch({ type: "gpu.sample", ts_ms: Date.now(), data: null });
      dispatch({ type: "devices.sample", ts_ms: Date.now(), data: null });
    };
    const close = () => {
      clearTimeout(watchdog);
      clearTimeout(retry);
      source?.close();
      source = null;
    };
    const schedule = () => {
      clearTimeout(retry);
      const base = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** attempts);
      attempts += 1;
      retry = setTimeout(open, base * (0.5 + Math.random() * 0.5));
    };
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        lost();
        close();
        schedule();
      }, STREAM_SILENCE_MS);
    };
    const receive = (message: MessageEvent<string>) => {
      armWatchdog();
      try {
        const event = parseEvent(JSON.parse(message.data));
        if (event) dispatch(event);
      } catch {
        /* Ignore malformed frames; the socket itself is still healthy. */
      }
    };
    function open() {
      if (disposed) return;
      close();
      const next = new EventSource(apiUrl("/v1/stream"));
      source = next;
      next.onopen = () => {
        attempts = 0;
        setStatus("live");
        if (opened) setSnapshotRevision((revision) => revision + 1);
        opened = true;
        armWatchdog();
      };
      next.onerror = () => {
        lost();
        clearTimeout(watchdog);
        // While CONNECTING the browser retries by itself; once CLOSED it never will.
        if (next.readyState === CLOSED) {
          close();
          schedule();
        }
      };
      next.onmessage = receive;
      for (const type of EVENT_TYPES) next.addEventListener(type, receive);
    }
    const resume = () => {
      if (document.visibilityState === "hidden") return;
      if (!source || source.readyState === CLOSED) {
        attempts = 0;
        open();
      }
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pageshow", resume);
    open();
    return () => {
      disposed = true;
      close();
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pageshow", resume);
    };
  }, []);
  return { ...state, status, connected: status === "live", snapshotRevision };
}
