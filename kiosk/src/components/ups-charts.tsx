import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
} from "recharts";
import type { Gpu, UpsEvent, UpsPoint } from "../api/types";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "./ui/chart";

const config = {
  load: { label: "Load (W)", color: "var(--accent-text)" },
  gpu: { label: "GPU (W)", color: "var(--muted-foreground)" },
  input: { label: "Input (V)", color: "var(--accent-text)" },
  charge: { label: "Charge (%)", color: "var(--accent-text)" },
  runtime: { label: "Runtime (min)", color: "var(--muted-foreground)" },
};
const date = (value: number) => new Date(value).toLocaleString();
const tick = (value: number) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function UpsCharts({
  history,
  gpu,
  events,
  now,
}: {
  history: UpsPoint[];
  gpu: Gpu["history"];
  events: UpsEvent[];
  now: number;
}) {
  const data = history.map((point) => {
    // GPU telemetry has shorter retention. Never extend a sample over a gap.
    const match = gpu.find((sample) => Math.abs(sample.ts_ms - point.ts_ms) <= 30_000);
    return {
      ts_ms: point.ts_ms,
      load: point.load_w.avg,
      input: point.input_v.avg,
      charge: point.charge_percent.avg,
      runtime: point.runtime_s == null ? null : point.runtime_s / 60,
      gpu: match?.power_w,
    };
  });
  const markers = events.filter(
    (event) =>
      event.kind === "on_battery" &&
      event.started_ms >= (history[0]?.ts_ms ?? Infinity) &&
      event.started_ms <= now,
  );
  return (
    <div className="ups-chart-grid">
      {(["load", "input", "charge"] as const).map((metric) => (
        <section key={metric} className="ups-panel">
          <h3>
            {metric === "load"
              ? "Load W · GPU W (dashed)"
              : metric === "input"
                ? "Input voltage · 100–139 V transfer band"
                : "Charge % · Runtime min (right axis)"}
          </h3>
          <ChartContainer
            config={config}
            className="ups-history-chart"
            aria-label={`${metric} history`}
          >
            <LineChart
              data={data}
              accessibilityLayer
              margin={{ left: 0, right: 12, top: 14, bottom: 0 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="ts_ms"
                type="number"
                domain={["dataMin", now]}
                tickFormatter={
                  now - (history[0]?.ts_ms ?? 0) < 3_600_000
                    ? (value: number) => new Date(value).toLocaleTimeString()
                    : tick
                }
                minTickGap={75}
              />
              <YAxis width={42} domain={metric === "charge" ? [0, 100] : ["auto", "auto"]} />
              {metric === "charge" && <YAxis yAxisId="runtime" orientation="right" width={36} />}
              <ChartTooltip
                content={<ChartTooltipContent />}
                labelFormatter={(value) => date(Number(value))}
              />
              {metric === "input" && (
                <ReferenceArea
                  y1={100}
                  y2={139}
                  fill="var(--accent-text)"
                  fillOpacity={0.12}
                  ifOverflow="extendDomain"
                />
              )}
              {metric === "input" &&
                markers.map((event) => (
                  <ReferenceLine
                    key={event.id}
                    x={event.started_ms}
                    stroke="var(--warn)"
                    strokeDasharray="3 3"
                    label={{ value: "OB", position: "top", fill: "var(--warn)", fontSize: 10 }}
                  />
                ))}
              {metric === "charge" &&
                [20, 30].map((value) => (
                  <ReferenceLine
                    key={value}
                    y={value}
                    stroke="var(--warn)"
                    strokeDasharray="3 3"
                    label={{
                      value: `${value}%`,
                      position: "insideTopRight",
                      fill: "var(--warn)",
                      fontSize: 10,
                    }}
                  />
                ))}
              <Line
                dataKey={metric}
                stroke="var(--accent-text)"
                dot={data.length === 1}
                isAnimationActive={false}
              />
              {metric === "load" && (
                <Line
                  dataKey="gpu"
                  stroke="var(--muted-foreground)"
                  strokeDasharray="5 3"
                  dot={false}
                  isAnimationActive={false}
                />
              )}
              {metric === "charge" && (
                <Line
                  dataKey="runtime"
                  yAxisId="runtime"
                  stroke="var(--muted-foreground)"
                  strokeDasharray="5 3"
                  dot={data.length === 1}
                  isAnimationActive={false}
                />
              )}
            </LineChart>
          </ChartContainer>
          {!history.length && <p className="muted">No history in this range.</p>}
        </section>
      ))}
      <section className="ups-panel">
        <h3>Runtime vs load · history points</h3>
        <ChartContainer
          config={config}
          className="ups-history-chart"
          aria-label="Runtime versus load"
        >
          <ScatterChart accessibilityLayer margin={{ left: 0, right: 12, top: 14, bottom: 0 }}>
            <CartesianGrid />
            <XAxis type="number" dataKey="load" name="Load" unit=" W" />
            <YAxis type="number" dataKey="runtime" name="Runtime" unit=" min" width={50} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Scatter
              data={data.filter((point) => point.load != null && point.runtime != null)}
              fill="var(--accent-text)"
              isAnimationActive={false}
            />
          </ScatterChart>
        </ChartContainer>
        {!history.length && <p className="muted">No history in this range.</p>}
      </section>
    </div>
  );
}
