import type { Gpu } from "../api/types";
import { TrendChart } from "./charts/trend-chart";

export default function GpuChart({ history }: { history: Gpu["history"] }) {
  return (
    <TrendChart
      data={history}
      dataKey="utilization_percent"
      label="Utilization (%)"
      ariaLabel="GPU utilization history"
      caption="Utilization · 0–100%"
    />
  );
}
