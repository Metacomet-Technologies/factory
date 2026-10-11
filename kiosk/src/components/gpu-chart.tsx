import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { Gpu } from "../api/types";
import { time } from "../lib/format";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "./ui/chart";

export default function GpuChart({ history }: { history: Gpu["history"] }) {
  return (
    <>
      <ChartContainer
        config={{ utilization_percent: { label: "Utilization (%)", color: "var(--primary)" } }}
        className="gpu-chart"
        aria-label="GPU utilization history"
      >
        <AreaChart
          data={history}
          accessibilityLayer
          margin={{ left: 0, right: 4, top: 10, bottom: 0 }}
        >
          <CartesianGrid vertical={false} />
          <XAxis dataKey="ts_ms" hide />
          <YAxis domain={[0, 100]} hide />
          <ChartTooltip
            content={<ChartTooltipContent />}
            labelFormatter={(value) => time(Number(value))}
          />
          <Area
            type="monotone"
            dataKey="utilization_percent"
            stroke="var(--accent-text)"
            fill="var(--primary)"
            fillOpacity={1}
            strokeWidth={2}
            isAnimationActive={false}
          />
        </AreaChart>
      </ChartContainer>
      <div className="row muted chart-caption">
        <span>{time(history[0]?.ts_ms ?? 0)}</span>
        <span>Utilization · 0–100%</span>
        <span>Now</span>
      </div>
    </>
  );
}
