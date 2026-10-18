import type { DeviceHistory } from "../api/types";
import { chartPoints } from "../lib/devices";
import { TrendChart } from "./charts/trend-chart";

export default function DevicesChart({ history }: { history: DeviceHistory["points"] }) {
  return (
    <TrendChart
      data={chartPoints(history)}
      dataKey="cpu"
      label="CPU %"
      ariaLabel="CPU utilization history"
      className="trend-chart trend-chart-tall"
      caption="CPU · 0–100%"
      variant="area"
    />
  );
}
