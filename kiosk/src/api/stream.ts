import { useEffect, useReducer, useState } from "react";
import { apiUrl } from "./client";
import type { Agents, GpuSample, UpsCurrent, StreamEvent } from "./types";

export interface LiveState {
  gpu: GpuSample | null | undefined;
  ups: UpsCurrent | null | undefined;
  upsAt: number;
  agents: Agents | null;
  requests: Extract<StreamEvent, { type: "llm.request" }>[];
  fleetRevision: number;
  pricingRevision: number;
  agentsRevision: number;
}
export const initialLiveState: LiveState = {
  gpu: undefined,
  ups: undefined,
  upsAt: 0,
  agents: null,
  requests: [],
  fleetRevision: 0,
  pricingRevision: 0,
  agentsRevision: 0,
};
export function streamReducer(state: LiveState, event: StreamEvent): LiveState {
  switch (event.type) {
    case "gpu.sample":
      return { ...state, gpu: event.data };
    case "ups.sample":
      return { ...state, ups: event.data, upsAt: event.ts_ms };
    case "llm.request":
      return { ...state, requests: [event, ...state.requests].slice(0, 6) };
    case "fleet.change":
      return { ...state, fleetRevision: state.fleetRevision + 1 };
    case "pricing.changed":
      return { ...state, pricingRevision: state.pricingRevision + 1 };
    case "agents.usage":
      return { ...state, agents: event.data, agentsRevision: state.agentsRevision + 1 };
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
  if ((value.type === "gpu.sample" || value.type === "ups.sample") && data === null)
    return value as StreamEvent;
  if (!data || typeof data !== "object") return null;
  const fields = data as Record<string, unknown>;
  const numbers = (keys: string[]) =>
    keys.every((key) => typeof fields[key] === "number" && Number.isFinite(fields[key]));
  const strings = (keys: string[]) => keys.every((key) => typeof fields[key] === "string");
  switch (value.type) {
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

export function useStream() {
  const [state, dispatch] = useReducer(streamReducer, initialLiveState);
  const [connected, setConnected] = useState(false);
  const [snapshotRevision, setSnapshotRevision] = useState(0);
  useEffect(() => {
    const source = new EventSource(apiUrl("/v1/stream"));
    let opened = false;
    source.onopen = () => {
      setConnected(true);
      if (opened) setSnapshotRevision((revision) => revision + 1);
      opened = true;
    };
    source.onerror = () => {
      setConnected(false);
      dispatch({ type: "gpu.sample", ts_ms: Date.now(), data: null });
    };
    const receive = (message: MessageEvent<string>) => {
      try {
        const event = parseEvent(JSON.parse(message.data));
        if (event) dispatch(event);
      } catch {
        /* Ignore malformed frames; native EventSource owns reconnection. */
      }
    };
    source.onmessage = receive;
    for (const type of [
      "gpu.sample",
      "ups.sample",
      "llm.request",
      "fleet.change",
      "pricing.changed",
      "agents.usage",
    ])
      source.addEventListener(type, receive);
    return () => source.close();
  }, []);
  return { ...state, connected, snapshotRevision };
}
