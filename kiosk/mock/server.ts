import { createServer } from "node:http";
import { agentFixtures, fixtures } from "./fixtures.ts";
import { siteFixtures } from "./site-fixtures.ts";
import { networkFixtures, networkScenarios, type NetworkScenario } from "./network-fixtures.ts";
import type { DeviceRange, GpuRange, UsageRange, UpsRange, StreamEvent } from "../src/api/types.ts";

const port = Number(process.env.MOCK_PORT ?? 4179);
const outage = process.env.MOCK_OUTAGE === "1";
const agentStatus = process.env.MOCK_AGENTS_STATUS ?? (outage ? "unknown" : "ok");
if (!["ok", "stale", "unknown", "not_tracked"].includes(agentStatus))
  throw new Error("Invalid MOCK_AGENTS_STATUS");
const networkScenario = (process.env.MOCK_NETWORK ?? "healthy") as NetworkScenario;
if (!networkScenarios.includes(networkScenario)) throw new Error("Invalid MOCK_NETWORK");
const agents = () => agentFixtures(agentStatus as Parameters<typeof agentFixtures>[0]);
createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  response.setHeader("Access-Control-Allow-Origin", "*");
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
      send({ type: "network.sample", ts_ms: Date.now(), data: [] });
    }, 15000);
    const keepalive = setInterval(() => response.write(": keepalive\n\n"), 15000);
    response.on("close", () => {
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
    (url.pathname === "/v1/network/history" &&
      range !== null &&
      !["1h", "24h", "7d", "30d"].includes(range)) ||
    (url.pathname === "/v1/network/speed-tests" &&
      range !== null &&
      !["24h", "7d", "30d", "365d"].includes(range)) ||
    (url.pathname === "/v1/devices/factory-gpu/history" &&
      range !== null &&
      !["1h", "24h", "7d"].includes(range))
  ) {
    response.writeHead(400).end();
    return;
  }
  const data = fixtures(outage, (range ?? "24h") as UsageRange, (range ?? "1h") as GpuRange);
  const site = siteFixtures(outage, (range ?? "24h") as UpsRange, (range ?? "1h") as DeviceRange);
  const network = networkFixtures(networkScenario);
  const before = url.searchParams.get("before");
  const routes: Record<string, unknown> = {
    "/v1/network": network.status,
    "/v1/network/history": network.history((range ?? "24h") as "24h"),
    "/v1/network/speed-tests": network.speed(range ?? "7d"),
    "/v1/network/events": network.eventPage(
      before == null ? null : Number(before),
      Number(url.searchParams.get("limit") ?? 50),
    ),
    "/v1/health": data.health,
    "/v1/fleet": data.fleet,
    "/v1/llm/usage": data.usage,
    "/v1/gpu": data.gpu,
    "/v1/pricing": data.pricing,
    "/v1/agents": agents(),
    "/v1/ups": site.ups,
    "/v1/ups/history": site.upsHistory,
    "/v1/ups/events": site.upsEvents,
    "/v1/ups/energy": site.upsEnergy,
    "/v1/settings/ups": site.upsSettings,
    "/v1/devices": site.devices,
    "/v1/devices/factory-gpu": site.deviceView,
    "/v1/devices/factory-gpu/history": site.deviceHistory,
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
  console.log(
    `Mock API on 127.0.0.1:${port}${outage ? " (outage fixtures)" : ""} · network ${networkScenario}`,
  ),
);
