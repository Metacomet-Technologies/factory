import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { DeviceHistory } from "../api/types";
import { chartPoints } from "../lib/devices";
import { time } from "../lib/format";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "./ui/chart";

export default function DevicesChart({ history }: { history: DeviceHistory["points"] }) {
  const data = chartPoints(history);
  return (
    <ChartContainer
      config={{ cpu: { label: "CPU %", color: "var(--primary)" } }}
      className="gpu-chart"
      aria-label="CPU utilization history"
    >
      <AreaChart data={data} accessibilityLayer margin={{ left: 0, right: 4, top: 10, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="ts_ms" hide />
        <YAxis domain={[0, 100]} hide />
        <ChartTooltip
          content={<ChartTooltipContent />}
          labelFormatter={(value) => time(Number(value))}
        />
        <Area
          type="monotone"
          dataKey="cpu"
          stroke="var(--accent-text)"
          fill="var(--primary)"
          fillOpacity={1}
          strokeWidth={2}
          connectNulls={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}
