import type { components, paths } from "./generated";

export type UsageRange = "24h" | "7d" | "30d";
export type GpuRange = "1h" | "24h" | "7d";
export type Health = components["schemas"]["Health"];
export type Service = components["schemas"]["Service"];
export type Fleet = components["schemas"]["Fleet"];
export type ModelUsage = components["schemas"]["ModelUsage"];
export type Usage = components["schemas"]["Usage"];
export type GpuSample = components["schemas"]["GpuCurrent"];
export type Gpu = components["schemas"]["Gpu"];
export type Ups = components["schemas"]["Ups"];
export type UpsCurrent = components["schemas"]["UpsCurrent"];
export type UpsEvent = components["schemas"]["UpsEvent"];
export type UpsPoint = components["schemas"]["UpsPoint"];
export type UpsSettings = components["schemas"]["UpsSettings"];
export type UpsRange = "1h" | "24h" | "7d" | "30d" | "365d";
export type Pricing = components["schemas"]["Pricing"];
export type Agents = components["schemas"]["Agents"];
export type LlmRequest = components["schemas"]["LlmRequest"];

// OpenAPI exposes an untyped SSE envelope. Payloads still come from its schemas;
// event names and the nullable GPU payload are the documented transport contract.
export type StreamEvent = Omit<components["schemas"]["StreamEvent"], "type" | "data"> &
  (
    | { type: "gpu.sample"; data: GpuSample | null }
    | { type: "ups.sample"; data: UpsCurrent | null }
    | { type: "ups.event"; data: UpsEvent }
    | { type: "llm.request"; data: LlmRequest }
    | { type: "fleet.change"; data: components["schemas"]["FleetChange"] }
    | { type: "pricing.changed"; data: components["schemas"]["PricingChanged"] }
    | { type: "agents.usage"; data: Agents }
  );
export type Endpoints = {
  [
    K in keyof paths as K extends "/v1/stream"
      ? never
      : paths[K] extends { get: unknown }
        ? K
        : never
  ]: paths[K] extends {
    get: { responses: { 200: { content: { "application/json": infer Response } } } };
  }
    ? Response
    : never;
};
