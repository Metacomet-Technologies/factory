import { useEffect, useReducer, useState } from "react";
import { apiUrl } from "./client";
import type { GpuSample, StreamEvent } from "./types";

export interface LiveState {
  gpu: GpuSample | null | undefined;
  requests: Extract<StreamEvent, { type: "llm.request" }>[];
  fleetRevision: number;
  pricingRevision: number;
}
export const initialLiveState: LiveState = {
  gpu: undefined,
  requests: [],
  fleetRevision: 0,
  pricingRevision: 0,
};
export function streamReducer(state: LiveState, event: StreamEvent): LiveState {
  switch (event.type) {
    case "gpu.sample":
      return { ...state, gpu: event.data };
    case "llm.request":
      return { ...state, requests: [event, ...state.requests].slice(0, 6) };
    case "fleet.change":
      return { ...state, fleetRevision: state.fleetRevision + 1 };
    case "pricing.changed":
      return { ...state, pricingRevision: state.pricingRevision + 1 };
  }
}

// The contract leaves SSE event names unspecified. Accept named events and default messages;
// the JSON envelope is authoritative in either case.
export function parseEvent(value: unknown): StreamEvent | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("type" in value) ||
    !("ts_ms" in value) ||
    !("data" in value) ||
    typeof value.ts_ms !== "number"
  )
    return null;
  const data = value.data;
  if (value.type === "gpu.sample" && data === null) return value as StreamEvent;
  if (!data || typeof data !== "object") return null;
  const fields = data as Record<string, unknown>;
  const numbers = (keys: string[]) =>
    keys.every((key) => typeof fields[key] === "number" && Number.isFinite(fields[key]));
  const strings = (keys: string[]) => keys.every((key) => typeof fields[key] === "string");
  switch (value.type) {
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
        strings(["model", "client_hostname"]) &&
        numbers(["prompt_tokens", "output_tokens", "latency_ms"])
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
        (fields.pending_model_id === null || typeof fields.pending_model_id === "string")
      )
        return value as StreamEvent;
      break;
  }
  return null;
}

export function useStream() {
  const [state, dispatch] = useReducer(streamReducer, initialLiveState);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const source = new EventSource(apiUrl("/v1/stream"));
    source.onopen = () => setConnected(true);
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
    for (const type of ["gpu.sample", "llm.request", "fleet.change", "pricing.changed"])
      source.addEventListener(type, receive);
    return () => source.close();
  }, []);
  return { ...state, connected };
}
