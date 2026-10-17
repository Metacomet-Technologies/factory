import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ReferenceArea, XAxis, YAxis } from "recharts";
import type { NetworkEvent, NetworkSeries, NetworkSpeedTest } from "../api/types";
import { useReducedMotion } from "../lib/motion";
import { eventBands, targetPoints } from "../lib/network";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "./ui/chart";
import { Panel } from "./ui/panel";

const LAYERS = ["lan", "wan", "dns", "tailnet"] as const;
const color = (i: number) => (i === 0 ? "var(--accent-text)" : "var(--muted-foreground)");
const date = (value: number) => new Date(value).toLocaleString();
const tick = (span: number) => (value: number) =>
  span < 172_800_000
    ? new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export default function NetworkCharts({
  series,
  events,
  tests,
  from,
  now,
}: {
  series: NetworkSeries[];
  events: NetworkEvent[];
  tests: NetworkSpeedTest[];
  from: number;
  now: number;
}) {
  const reduced = useReducedMotion();
  const animation = { isAnimationActive: !reduced, animationDuration: 900 } as const;
  const layers = useMemo(
    () =>
      LAYERS.map((layer) => {
        const targets = series.filter((target) => target.layer === layer);
        return {
          layer,
          targets: targets.map((target) => ({ ...target, data: targetPoints(target) })),
        };
      }),
    [series],
  );
  const throughput = tests
    .filter((test) => test.started_ms >= from && test.started_ms <= now)
    .map((test) => ({
      ts_ms: test.started_ms,
      download: test.download_bps == null ? null : test.download_bps / 1_000_000,
      upload: test.upload_bps == null ? null : test.upload_bps / 1_000_000,
      downLatency: test.download_loaded_latency_ms ?? null,
      upLatency: test.upload_loaded_latency_ms ?? null,
    }));
  const xAxis = (
    <XAxis
      dataKey="ts_ms"
      type="number"
      domain={[from, now]}
      allowDataOverflow
      tickFormatter={tick(now - from)}
      minTickGap={60}
    />
  );
  return (
    <div className="ups-chart-grid network-charts">
      {layers.map(({ layer, targets }, index) => {
        const config = Object.fromEntries(
          targets.flatMap((target, i) => [
            [`latency${i}`, { label: `${target.target} RTT (ms)`, color: color(i) }],
            [`loss${i}`, { label: `${target.target} loss (%)`, color: color(i) }],
          ]),
        );
        return (
          <Panel
            key={layer}
            title={`${layer} latency & loss`}
            subtitle="Average RTT (ms) · loss (%) dashed on the right · shaded episodes"
            index={index}
          >
            <ChartContainer
              config={config}
              className="ups-history-chart"
              aria-label={`${layer} latency and loss history`}
            >
              <LineChart accessibilityLayer margin={{ left: 0, right: 0, top: 14, bottom: 0 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 4" />
                {xAxis}
                <YAxis width={36} />
                <YAxis yAxisId="loss" orientation="right" width={40} domain={[0, 100]} unit="%" />
                <ChartTooltip
                  content={<ChartTooltipContent />}
                  labelFormatter={(_, items) => date(Number(items[0]?.payload?.ts_ms))}
                />
                {eventBands(events, layer, from, now).map((band) => (
                  <ReferenceArea
                    key={band.id}
                    x1={band.x1}
                    // A 2-minute episode is under 2 px at 24h; keep every band visible.
                    x2={Math.max(band.x2, band.x1 + (now - from) / 150)}
                    fill={`var(--${band.tone})`}
                    fillOpacity={0.22}
                    ifOverflow="hidden"
                  />
                ))}
                {targets.map((target, i) => (
                  <Line
                    key={`latency-${target.target}`}
                    data={target.data}
                    dataKey="latency"
                    name={`latency${i}`}
                    type="monotone"
                    stroke={color(i)}
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                    {...animation}
                  />
                ))}
                {targets.map((target, i) => (
                  <Line
                    key={`loss-${target.target}`}
                    data={target.data}
                    dataKey="loss"
                    name={`loss${i}`}
                    yAxisId="loss"
                    type="stepAfter"
                    stroke={color(i)}
                    strokeDasharray="4 3"
                    strokeWidth={1.5}
                    dot={false}
                    {...animation}
                  />
                ))}
              </LineChart>
            </ChartContainer>
            {!targets.some((target) => target.data.length) && (
              <p className="empty">No {layer} samples in this range.</p>
            )}
          </Panel>
        );
      })}
      <Panel
        title="Throughput"
        subtitle="Mb/s, upload dashed · loaded latency (ms) on the right axis"
        index={4}
        className="network-throughput"
      >
        <ChartContainer
          config={{
            download: { label: "Download (Mb/s)", color: "var(--accent-text)" },
            upload: { label: "Upload (Mb/s)", color: "var(--accent-text)" },
            downLatency: {
              label: "Download loaded latency (ms)",
              color: "var(--muted-foreground)",
            },
            upLatency: { label: "Upload loaded latency (ms)", color: "var(--muted-foreground)" },
          }}
          className="ups-history-chart"
          aria-label="Throughput history"
        >
          <LineChart
            data={throughput}
            accessibilityLayer
            margin={{ left: 0, right: 0, top: 14, bottom: 0 }}
          >
            <CartesianGrid vertical={false} strokeDasharray="3 4" />
            {xAxis}
            <YAxis width={48} />
            <YAxis yAxisId="latency" orientation="right" width={40} unit=" ms" />
            <ChartTooltip
              content={<ChartTooltipContent />}
              labelFormatter={(_, items) => date(Number(items[0]?.payload?.ts_ms))}
            />
            <Line dataKey="download" stroke="var(--accent-text)" strokeWidth={2} {...animation} />
            <Line
              dataKey="upload"
              stroke="var(--accent-text)"
              strokeWidth={2}
              strokeDasharray="5 3"
              {...animation}
            />
            <Line
              dataKey="downLatency"
              yAxisId="latency"
              stroke="var(--muted-foreground)"
              strokeWidth={1.5}
              {...animation}
            />
            <Line
              dataKey="upLatency"
              yAxisId="latency"
              stroke="var(--muted-foreground)"
              strokeWidth={1.5}
              strokeDasharray="5 3"
              {...animation}
            />
          </LineChart>
        </ChartContainer>
        {!throughput.length && <p className="empty">No speed tests in this range.</p>}
      </Panel>
    </div>
  );
}
