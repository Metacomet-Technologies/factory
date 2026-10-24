import { useMemo } from "react";
import type { DeviceHistory } from "../api/types";
import { chartPoints } from "../lib/devices";
import { TrendChart } from "./charts/trend-chart";

export default function DevicesChart({ history }: { history: DeviceHistory["points"] }) {
  // Same history, same array: the page's per-second clock must not restart the tween.
  const data = useMemo(() => chartPoints(history), [history]);
  return (
    <TrendChart
      data={data}
      dataKey="cpu"
      label="CPU %"
      ariaLabel="CPU utilization history"
      className="trend-chart trend-chart-tall"
      caption="CPU · 0–100%"
      variant="area"
    />
  );
}
