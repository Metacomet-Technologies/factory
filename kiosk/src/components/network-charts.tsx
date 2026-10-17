import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import type { NetworkLayer, NetworkRange, NetworkSeries, NetworkSpeedTest } from "../api/types";
import { count } from "../lib/format";
import { useReducedMotion } from "../lib/motion";
import {
  LAYERS,
  chartStart,
  layerLabel,
  layerRows,
  speedRows,
  type EventBand,
} from "../lib/network";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "./ui/chart";
import { Panel } from "./ui/panel";

const date = (value: number) => new Date(value).toLocaleString();
const seconds = (value: number) => new Date(value).toLocaleTimeString();
const clock = (value: number) =>
  new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const day = (value: number) =>
  new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
/** Tick labels sized to the span shown, so ticks within one minute never share a label. */
const ticks = ({ since, now }: Window) =>
  now - since <= 3_600_000 ? seconds : now - since <= 2 * 86_400_000 ? clock : day;
const accent = "var(--accent-text)";
const muted = "var(--muted-foreground)";
const dashed = "5 3";
/** First target solid accent, second dashed muted, as on the UPS charts. */
const strokes = [{ stroke: accent }, { stroke: muted, strokeDasharray: dashed }] as const;
const metrics = {
  latency: { unit: " ms", domain: [0, "auto"] },
  loss: { unit: "%", domain: [0, 100] },
} as const;
const speedConfig: ChartConfig = {
  download: { label: "Download (Mb/s)", color: accent },
  upload: { label: "Upload (Mb/s)", color: accent },
  downloadLoaded: { label: "Loaded latency, download (ms)", color: muted },
  uploadLoaded: { label: "Loaded latency, upload (ms)", color: muted },
};

type Window = { since: number; now: number; range: NetworkRange };
const tooltip = (
  <ChartTooltip
    content={<ChartTooltipContent />}
    labelFormatter={(_, items) => date(Number(items[0]?.payload?.ts_ms))}
  />
);

function LayerPanel({
  layer,
  series,
  bands,
  window,
  index,
}: {
  layer: NetworkLayer;
  series: NetworkSeries[];
  bands: EventBand[];
  window: Window;
  index: number;
}) {
  const reduced = useReducedMotion();
  const { targets, rows } = useMemo(() => layerRows(series, layer), [series, layer]);
  const label = layerLabel[layer];
  const config: ChartConfig = Object.fromEntries(
    targets.flatMap((target, at) => [
      [`latency${at}`, { label: `${target} latency (ms)`, color: strokes[at % 2]!.stroke }],
      [`loss${at}`, { label: `${target} loss (%)`, color: strokes[at % 2]!.stroke }],
    ]),
  );
  const subtitle =
    targets.length > 1
      ? targets.map((target, at) => `${target} ${at % 2 ? "dashed" : "solid"}`).join(" · ")
      : (targets[0] ?? "No samples in this range");
  return (
    <Panel title={label} subtitle={subtitle} index={index} aria-label={`${label} latency and loss`}>
      {(["latency", "loss"] as const).map((metric) => (
        <ChartContainer
          key={metric}
          config={config}
          className="network-chart"
          aria-label={`${label} ${metric} history`}
        >
          <LineChart
            data={rows}
            accessibilityLayer
            margin={{ left: 0, right: 12, top: 8, bottom: 0 }}
          >
            <CartesianGrid vertical={false} strokeDasharray="3 4" />
            <XAxis
              dataKey="ts_ms"
              type="number"
              domain={[window.since, window.now]}
              allowDataOverflow
              tickFormatter={ticks(window)}
              minTickGap={60}
            />
            <YAxis width={52} unit={metrics[metric].unit} domain={[...metrics[metric].domain]} />
            {tooltip}
            {bands
              .filter((band) => band.layer === layer)
              .map((band) => (
                <ReferenceArea
                  key={band.id}
                  x1={band.x1}
                  x2={band.x2}
                  fill={`var(--${band.tone})`}
                  fillOpacity={0.18}
                  stroke={`var(--${band.tone})`}
                  strokeOpacity={0.6}
                  ifOverflow="hidden"
                />
              ))}
            {/* Each point is a bucket that starts at ts_ms, so its value holds until the next. */}
            {targets.map((target, at) => (
              <Line
                key={target}
                dataKey={`${metric}${at}`}
                type="stepAfter"
                {...strokes[at % 2]}
                strokeWidth={2}
                dot={rows.length === 1}
                connectNulls={false}
                isAnimationActive={!reduced}
                animationDuration={900}
              />
            ))}
          </LineChart>
        </ChartContainer>
      ))}
      {!rows.length && <p className="empty">No samples in this range.</p>}
    </Panel>
  );
}

function Throughput({
  tests,
  window,
  index,
}: {
  tests: NetworkSpeedTest[] | null;
  window: Window;
  index: number;
}) {
  const reduced = useReducedMotion();
  const rows = useMemo(() => speedRows(tests ?? []), [tests]);
  const animation = { isAnimationActive: !reduced, animationDuration: 900 } as const;
  return (
    <Panel
      title="Throughput"
      subtitle={`Mb/s, download solid and upload dashed · loaded latency in ms on the right · failed tests in red${window.range === "1h" ? " · last 24 h" : ""}`}
      index={index}
      className="network-throughput"
      aria-label="Throughput"
    >
      <ChartContainer
        config={speedConfig}
        className="network-chart network-chart-tall"
        aria-label="Throughput history"
      >
        <LineChart
          data={rows}
          accessibilityLayer
          margin={{ left: 0, right: 12, top: 8, bottom: 0 }}
        >
          <CartesianGrid vertical={false} strokeDasharray="3 4" />
          <XAxis
            dataKey="ts_ms"
            type="number"
            domain={[window.since, window.now]}
            allowDataOverflow
            tickFormatter={ticks(window)}
            minTickGap={60}
          />
          <YAxis width={44} tickFormatter={count} domain={[0, "auto"]} />
          <YAxis yAxisId="latency" orientation="right" width={52} unit=" ms" domain={[0, "auto"]} />
          {tooltip}
          {rows
            .filter((row) => row.failed)
            .map((row) => (
              <ReferenceLine
                key={row.ts_ms}
                x={row.ts_ms}
                stroke="var(--fail)"
                strokeDasharray="3 3"
                ifOverflow="hidden"
              />
            ))}
          <Line dataKey="download" stroke={accent} strokeWidth={2} dot={{ r: 2 }} {...animation} />
          <Line
            dataKey="upload"
            stroke={accent}
            strokeDasharray={dashed}
            strokeWidth={2}
            dot={{ r: 2 }}
            {...animation}
          />
          <Line
            dataKey="downloadLoaded"
            yAxisId="latency"
            stroke={muted}
            dot={false}
            {...animation}
          />
          <Line
            dataKey="uploadLoaded"
            yAxisId="latency"
            stroke={muted}
            strokeDasharray={dashed}
            dot={false}
            {...animation}
          />
        </LineChart>
      </ChartContainer>
      {tests === null ? (
        <p className="loading">Loading speed tests…</p>
      ) : (
        !rows.length && <p className="empty">No speed tests in this range.</p>
      )}
    </Panel>
  );
}

/** Per-layer latency and loss with shaded event bands, then throughput. Lazily loaded. */
export default function NetworkCharts({
  series,
  tests,
  bands,
  since,
  speedSince,
  now,
  range,
}: {
  series: NetworkSeries[];
  tests: NetworkSpeedTest[] | null;
  bands: EventBand[];
  since: number;
  speedSince: number;
  now: number;
  range: NetworkRange;
}) {
  const start = chartStart(
    since,
    series.flatMap((line) => line.points.map((point) => point.ts_ms)),
  );
  const speedStart = chartStart(
    speedSince,
    (tests ?? []).map((test) => test.started_ms),
  );
  return (
    <div className="network-chart-grid">
      {LAYERS.map((layer, index) => (
        <LayerPanel
          key={layer}
          layer={layer}
          series={series}
          bands={bands}
          window={{ since: start, now, range }}
          index={index}
        />
      ))}
      <Throughput tests={tests} window={{ since: speedStart, now, range }} index={LAYERS.length} />
    </div>
  );
}
