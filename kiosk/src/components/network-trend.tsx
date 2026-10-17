import type { LayerTrendPoint } from "../lib/network";
import { TrendChart } from "./charts/trend-chart";

const charts: Record<
  "latency" | "loss",
  { label: string; ariaLabel: string; caption: string; domain: [number, number | "auto"] }
> = {
  latency: {
    label: "WAN latency (ms)",
    ariaLabel: "WAN latency, last 24 hours",
    caption: "WAN latency · 24 h",
    domain: [0, "auto"],
  },
  loss: {
    label: "WAN loss (%)",
    ariaLabel: "WAN loss, last 24 hours",
    caption: "WAN loss · 0–100%",
    domain: [0, 100],
  },
};

export default function NetworkTrend({
  points,
  metric,
}: {
  points: LayerTrendPoint[];
  metric: "latency" | "loss";
}) {
  return <TrendChart data={points} dataKey={metric} {...charts[metric]} />;
}
