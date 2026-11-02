import { describe, expect, it } from "vite-plus/test";
import type { Resource } from "../api/client";
import type { Fleet } from "../api/types";
import { verdict, type VerdictInput } from "./verdict";

const loaded = <T>(data: unknown): Resource<T> => ({
  data: data as T,
  error: null,
  loading: false,
});
const loading: Resource<never> = { data: null, error: null, loading: true };
const failed: Resource<never> = { data: null, error: "HTTP 503", loading: false };
const fleet = {
  generated_at_ms: 0,
  nodes: [
    {
      name: "factory-gpu",
      online: true,
      tailscale_ip: null,
      os: null,
      last_seen_ms: null,
      services: [
        { name: "meter-http", kind: "http", target: "", ok: true, latency_ms: 2 },
        { name: "backup", kind: "http", target: "", ok: false, latency_ms: null, detail: "x" },
      ],
    },
    {
      name: "factory-console",
      online: false,
      tailscale_ip: null,
      os: null,
      last_seen_ms: 1,
      services: [],
    },
  ],
};
const pricing = { families: [{ pending: true }, { pending: false }], warnings: [] };
const base: VerdictInput = {
  fleet: loaded<Fleet>(fleet),
  gpu: loaded({}),
  usage: loaded({}),
  pricing: loaded(pricing),
  agents: loading,
  devices: loaded({ devices: [{ device_id: "factory-gpu", health: "warning", href: "" }] }),
  network: loaded({}),
  networkBadge: { label: "Degraded · WAN loss", tone: "warn" },
  ups: "Online",
  upsCurrent: {} as VerdictInput["upsCurrent"],
  stream: "live",
};

describe("verdict", () => {
  it("lists failures before warnings and counts the checks that pass", () => {
    const result = verdict(base);
    expect(result.issues).toEqual([
      { tone: "fail", label: "backup failing on factory-gpu" },
      { tone: "fail", label: "factory-console offline" },
      { tone: "warn", label: "factory-gpu host warning" },
      { tone: "warn", label: "1 pricing family pending" },
      { tone: "warn", label: "Network degraded · WAN loss" },
    ]);
    // Fleet, factory-gpu, meter-http, Hosts, GPU, Local LLM, Pricing, Network, UPS, stream.
    expect(result.okCount).toBe(10);
  });
  it("reports an errored section once and ignores sections still loading", () => {
    const result = verdict({ ...base, fleet: failed, pricing: loading, stream: "reconnecting" });
    expect(result.issues.map((issue) => issue.label)).toEqual([
      "Fleet unavailable",
      "factory-gpu host warning",
      "Network degraded · WAN loss",
      "Stream reconnecting",
    ]);
    expect(result.okCount).toBe(5);
  });
  it("keeps an offline satellite and its stale host out of the verdict", () => {
    const nodes = fleet.nodes.map((node) =>
      node.name === "factory-console" ? { ...node, satellite: true } : node,
    );
    const result = verdict({
      ...base,
      fleet: loaded<Fleet>({ ...fleet, nodes }),
      devices: loaded({
        devices: [{ device_id: "factory-console", health: "critical", href: "" }],
      }),
    });
    expect(result.issues.map((issue) => issue.label)).not.toContain("factory-console offline");
    expect(result.issues.map((issue) => issue.label)).not.toContain(
      "factory-console host critical",
    );
  });
  it("downgrades an online satellite's failures to warnings", () => {
    const console = {
      ...fleet.nodes[1]!,
      satellite: true,
      online: true,
      services: [{ name: "rdp", kind: "rdp", target: "", ok: false, latency_ms: null }],
    };
    const result = verdict({
      ...base,
      fleet: loaded<Fleet>({ ...fleet, nodes: [fleet.nodes[0]!, console] }),
      devices: loaded({
        devices: [{ device_id: "factory-console", health: "critical", href: "" }],
      }),
    });
    expect(result.issues).toContainEqual({ tone: "warn", label: "rdp failing on factory-console" });
    expect(result.issues).toContainEqual({ tone: "warn", label: "factory-console host critical" });
  });
});
