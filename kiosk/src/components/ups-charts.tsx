import { useMemo } from "react";
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
import { useChartMotion } from "../lib/motion";
import { upsChartData } from "../lib/ups";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "./ui/chart";
import { Panel } from "./ui/panel";

const config = {
  load: { label: "Load (W)", color: "var(--accent-text)" },
  gpu: { label: "GPU (W)", color: "var(--muted-foreground)" },
  input: { label: "Input (V)", color: "var(--accent-text)" },
  charge: { label: "Charge (%)", color: "var(--accent-text)" },
  runtime: { label: "Runtime (min)", color: "var(--muted-foreground)" },
};
const titles = {
  load: ["Load", "Watts · GPU dashed"],
  input: ["Input voltage", "100–139 V transfer band"],
  charge: ["Charge", "Percent · runtime (min) on the right axis"],
} as const;
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
  const { data, scatter } = useMemo(() => {
    const data = upsChartData(history, gpu);
    return {
      data,
      scatter: data.filter((point) => point.load != null && point.runtime != null),
    };
  }, [history, gpu]);
  const markers = events.filter(
    (event) =>
      event.kind === "on_battery" &&
      event.started_ms >= (history[0]?.ts_ms ?? Infinity) &&
      event.started_ms <= now,
  );
  const animation = useChartMotion();
  return (
    <div className="ups-chart-grid">
      {(["load", "input", "charge"] as const).map((metric, index) => (
        <Panel key={metric} title={titles[metric][0]} subtitle={titles[metric][1]} index={index}>
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
              <CartesianGrid vertical={false} strokeDasharray="3 4" />
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
                labelFormatter={(_, items) => date(Number(items[0]?.payload?.ts_ms))}
              />
              {metric === "input" && (
                <ReferenceArea
                  y1={100}
                  y2={139}
                  fill="var(--accent-text)"
                  fillOpacity={0.1}
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
                type="monotone"
                stroke="var(--accent-text)"
                strokeWidth={2}
                dot={data.length === 1}
                activeDot={{ r: 4, strokeWidth: 0 }}
                {...animation}
              />
              {metric === "load" && (
                <Line
                  dataKey="gpu"
                  type="monotone"
                  stroke="var(--muted-foreground)"
                  strokeDasharray="5 3"
                  dot={false}
                  {...animation}
                />
              )}
              {metric === "charge" && (
                <Line
                  dataKey="runtime"
                  type="monotone"
                  yAxisId="runtime"
                  stroke="var(--muted-foreground)"
                  strokeDasharray="5 3"
                  dot={data.length === 1}
                  {...animation}
                />
              )}
            </LineChart>
          </ChartContainer>
          {!history.length && <p className="empty">No history in this range.</p>}
        </Panel>
      ))}
      <Panel title="Runtime vs load" subtitle="One point per history bucket" index={3}>
        <ChartContainer
          config={config}
          className="ups-history-chart"
          aria-label="Runtime versus load"
        >
          <ScatterChart accessibilityLayer margin={{ left: 0, right: 12, top: 14, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 4" />
            <XAxis type="number" dataKey="load" name="Load" unit=" W" />
            <YAxis type="number" dataKey="runtime" name="Runtime" unit=" min" width={50} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Scatter data={scatter} fill="var(--accent-text)" fillOpacity={0.8} {...animation} />
          </ScatterChart>
        </ChartContainer>
        {!history.length && <p className="empty">No history in this range.</p>}
      </Panel>
    </div>
  );
}
