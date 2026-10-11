import { createServer } from "node:http";
import { fixtures } from "./fixtures.ts";
import type { GpuRange, UsageRange, StreamEvent } from "../src/api/types.ts";

const port = Number(process.env.MOCK_PORT ?? 4179);
const outage = process.env.MOCK_OUTAGE === "1";
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
    const send = (event: StreamEvent) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    let index = 0;
    const gpu = setInterval(() => {
      const data = fixtures(outage).gpu.current;
      if (data) {
        data.utilization_percent = 50 + (index++ % 27);
        data.power_w = 230 + (index % 35);
      }
      send({ type: "gpu.sample", ts_ms: Date.now(), data });
    }, 3000);
    const llm = setInterval(() => {
      if (!outage)
        send({
          type: "llm.request",
          ts_ms: Date.now(),
          data: {
            model: index % 2 ? "factory-assist:latest" : "factory-code:latest",
            prompt_tokens: 1840 + index * 3,
            output_tokens: 328 + index,
            latency_ms: 812 + index * 8,
            client_hostname: "factory-console",
          },
        });
    }, 5000);
    const keepalive = setInterval(() => response.write(": keepalive\n\n"), 15000);
    response.on("close", () => {
      clearInterval(gpu);
      clearInterval(llm);
      clearInterval(keepalive);
    });
    return;
  }
  const range = url.searchParams.get("range");
  if (
    (url.pathname === "/v1/llm/usage" && range !== null && !["24h", "7d", "30d"].includes(range)) ||
    (url.pathname === "/v1/gpu" && range !== null && !["1h", "24h", "7d"].includes(range))
  ) {
    response.writeHead(400).end();
    return;
  }
  const data = fixtures(outage, (range ?? "24h") as UsageRange, (range ?? "1h") as GpuRange);
  const routes: Record<string, unknown> = {
    "/v1/health": data.health,
    "/v1/fleet": data.fleet,
    "/v1/llm/usage": data.usage,
    "/v1/gpu": data.gpu,
    "/v1/pricing": data.pricing,
    "/v1/agents": data.agents,
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
