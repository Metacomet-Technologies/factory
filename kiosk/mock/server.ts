import { createServer } from "node:http";
import { agentFixtures, fixtures } from "./fixtures.ts";
import { networkFixtures, siteFixtures, type NetworkMode } from "./site-fixtures.ts";
import type {
  DeviceRange,
  GpuRange,
  NetworkRange,
  UsageRange,
  UpsRange,
  StreamEvent,
} from "../src/api/types.ts";

const port = Number(process.env.MOCK_PORT ?? 4179);
const outage = process.env.MOCK_OUTAGE === "1";
const agentStatus = process.env.MOCK_AGENTS_STATUS ?? (outage ? "unknown" : "ok");
if (!["ok", "stale", "unknown", "not_tracked"].includes(agentStatus))
  throw new Error("Invalid MOCK_AGENTS_STATUS");
// A refresh, like the API's, stamps every tracked tool with a new observation and pushes it on
// /v1/stream; the next one is allowed 3 minutes later.
let refreshedAt: number | null = null;
let nextRefreshAt = 0;
const streams = new Set<(event: StreamEvent) => void>();
// Families whose pending reference model was confirmed through POST /v1/pricing/confirm/.
const confirmed = new Set<string>();
function pricingView(pricing: ReturnType<typeof fixtures>["pricing"]) {
  for (const family of pricing.families)
    if (confirmed.has(family.family) && family.pending) {
      family.selected = family.pending;
      family.pending = null;
    }
  return pricing;
}
const agents = () => {
  const data = agentFixtures(agentStatus as Parameters<typeof agentFixtures>[0]);
  if (refreshedAt !== null && agentStatus === "ok")
    for (const tool of data.tools) tool.observed_at_ms = refreshedAt;
  return data;
};
const networkMode = (process.env.MOCK_NETWORK ?? "healthy") as NetworkMode;
if (!["healthy", "degraded", "down"].includes(networkMode)) throw new Error("Invalid MOCK_NETWORK");
createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  response.setHeader("Access-Control-Allow-Origin", "*");
  if (request.method === "POST" && url.pathname === "/v1/agents/refresh") {
    const now = Date.now();
    const json = { "Content-Type": "application/json" };
    if (now < nextRefreshAt) {
      response
        .writeHead(429, { ...json, "Retry-After": String(Math.ceil((nextRefreshAt - now) / 1000)) })
        .end(
          JSON.stringify({
            error: { code: "cooldown", message: "usage refresh is cooling down" },
            next_allowed_at_ms: nextRefreshAt,
          }),
        );
      return;
    }
    nextRefreshAt = now + 180_000;
    setTimeout(() => {
      refreshedAt = Date.now();
      const event: StreamEvent = { type: "agents.usage", ts_ms: refreshedAt, data: agents() };
      for (const send of streams) send(event);
    }, 1500);
    response
      .writeHead(202, json)
      .end(JSON.stringify({ status: "accepted", next_allowed_at_ms: nextRefreshAt }));
    return;
  }
  const confirm = url.pathname.match(/^\/v1\/pricing\/confirm\/([^/]+)$/);
  if (request.method === "POST" && confirm) {
    const family = decodeURIComponent(confirm[1] ?? "");
    const pricing = pricingView(fixtures(outage).pricing);
    const target = pricing.families.find((f) => f.family === family);
    if (!target) return void response.writeHead(404).end();
    if (!target.pending) return void response.writeHead(409).end();
    confirmed.add(family);
    const event: StreamEvent = {
      type: "pricing.changed",
      ts_ms: Date.now(),
      data: { family, pending_model_id: null },
    };
    for (const send of streams) send(event);
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(pricingView(fixtures(outage).pricing)));
    return;
  }
  if (request.method !== "GET") {
    response.writeHead(405).end();
    return;
  }
  if (url.pathname === "/v1/stream") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write(": connected\n\n");
    const send = (event: StreamEvent) =>
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    streams.add(send);
    let index = 0;
    const gpu = setInterval(() => {
      const data = fixtures(outage).gpu.current;
      if (data) {
        data.utilization_percent = 50 + (index++ % 27);
        data.power_w = 120 + (index % 35);
      }
      send({ type: "gpu.sample", ts_ms: Date.now(), data: data ?? null });
    }, 3000);
    const llm = setInterval(() => {
      if (!outage)
        send({
          type: "llm.request",
          ts_ms: Date.now(),
          data: {
            model: index % 3 === 0 ? null : index % 2 ? "factory-assist" : "factory-code",
            prompt_tokens: index % 3 === 0 ? null : 18 + index,
            output_tokens: index % 3 === 0 ? null : 32 + index,
            latency_ms: 6302 + index * 8,
            client_hostname: "factory-console",
          },
        });
    }, 5000);
    const usage = setInterval(
      () => send({ type: "agents.usage", ts_ms: Date.now(), data: agents() }),
      15000,
    );
    const site = setInterval(() => {
      const live = siteFixtures(outage);
      send({ type: "ups.sample", ts_ms: Date.now(), data: live.ups.current ?? null });
      send({ type: "devices.sample", ts_ms: Date.now(), data: live.deviceView });
      const network = networkFixtures(networkMode, outage).status;
      send({
        type: "network.sample",
        ts_ms: Date.now(),
        data: network.targets.flatMap((target) => (target.latest ? [target.latest] : [])),
      });
    }, 15000);
    const keepalive = setInterval(() => response.write(": keepalive\n\n"), 15000);
    response.on("close", () => {
      streams.delete(send);
      clearInterval(gpu);
      clearInterval(llm);
      clearInterval(usage);
      clearInterval(site);
      clearInterval(keepalive);
    });
    return;
  }
  const range = url.searchParams.get("range");
  if (
    (url.pathname === "/v1/llm/usage" && range !== null && !["24h", "7d", "30d"].includes(range)) ||
    (url.pathname === "/v1/gpu" && range !== null && !["1h", "24h", "7d"].includes(range)) ||
    (url.pathname.startsWith("/v1/ups/") &&
      range !== null &&
      !["1h", "24h", "7d", "30d", "365d"].includes(range)) ||
    (url.pathname === "/v1/devices/factory-gpu/history" &&
      range !== null &&
      !["1h", "24h", "7d"].includes(range)) ||
    (url.pathname === "/v1/network/history" &&
      range !== null &&
      !["1h", "24h", "7d", "30d"].includes(range)) ||
    (url.pathname === "/v1/network/speed-tests" &&
      range !== null &&
      !["24h", "7d", "30d"].includes(range))
  ) {
    response.writeHead(400).end();
    return;
  }
  const data = fixtures(outage, (range ?? "24h") as UsageRange, (range ?? "1h") as GpuRange);
  const site = siteFixtures(outage, (range ?? "24h") as UpsRange, (range ?? "1h") as DeviceRange);
  const network = networkFixtures(
    networkMode,
    outage,
    (range ?? "24h") as NetworkRange,
    (range ?? "7d") as Exclude<NetworkRange, "1h">,
  );
  const before = Number(url.searchParams.get("before") ?? Infinity);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const events = network.events.filter((event) => event.id < before);
  const routes: Record<string, unknown> = {
    "/v1/health": data.health,
    "/v1/fleet": data.fleet,
    "/v1/llm/usage": data.usage,
    "/v1/gpu": data.gpu,
    "/v1/pricing": pricingView(data.pricing),
    "/v1/agents": agents(),
    "/v1/ups": site.ups,
    "/v1/ups/history": site.upsHistory,
    "/v1/ups/events": site.upsEvents,
    "/v1/ups/energy": site.upsEnergy,
    "/v1/settings/ups": site.upsSettings,
    "/v1/devices": site.devices,
    "/v1/devices/factory-gpu": site.deviceView,
    "/v1/devices/factory-gpu/history": site.deviceHistory,
    "/v1/network": network.status,
    "/v1/network/history": network.history,
    "/v1/network/speed-tests": network.speedTests,
    "/v1/network/events": {
      events: events.slice(0, limit),
      next_before: events.length > limit ? (events[limit - 1]?.id ?? null) : null,
    },
    "/control/v1/state": site.control,
    "/control/v1/audit": { rows: site.control.audit },
  };
  if (!(url.pathname in routes)) {
    response.writeHead(404).end();
    return;
  }
  response
    .writeHead(200, { "Content-Type": "application/json" })
    .end(JSON.stringify(routes[url.pathname]));
}).listen(port, "127.0.0.1", () =>
  console.log(`Mock API on 127.0.0.1:${port}${outage ? " (outage fixtures)" : ""}`),
);
