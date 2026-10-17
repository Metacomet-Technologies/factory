import { useId } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { useReducedMotion } from "@/lib/motion";
import { time } from "@/lib/format";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../ui/chart";

/**
 * TrendChart: one accent area over time with a soft gradient fill, an animated first draw
 * and a hover tooltip. Import it only from lazily loaded chart modules so Recharts stays
 * out of the main bundle.
 */
export function TrendChart<T extends { ts_ms: number }>({
  data,
  dataKey,
  label,
  ariaLabel,
  domain = [0, 100],
  className = "trend-chart",
  caption,
}: {
  data: T[];
  dataKey: Extract<keyof T, string>;
  label: string;
  ariaLabel: string;
  domain?: [number | "auto", number | "auto"] | undefined;
  className?: string | undefined;
  caption?: string | undefined;
}) {
  const reduced = useReducedMotion();
  const gradient = `trend-${useId().replace(/:/g, "")}`;
  return (
    <>
      <ChartContainer
        config={{ [dataKey]: { label, color: "var(--accent-text)" } }}
        className={className}
        aria-label={ariaLabel}
      >
        <AreaChart data={data} accessibilityLayer margin={{ left: 0, right: 4, top: 8, bottom: 0 }}>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent-text)" stopOpacity={0.45} />
              <stop offset="100%" stopColor="var(--accent-text)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="3 4" />
          <XAxis dataKey="ts_ms" hide />
          <YAxis domain={domain} hide />
          <ChartTooltip
            content={<ChartTooltipContent />}
            labelFormatter={(_, items) => time(Number(items[0]?.payload?.ts_ms))}
          />
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke="var(--accent-text)"
            fill={`url(#${gradient})`}
            strokeWidth={2}
            connectNulls={false}
            isAnimationActive={!reduced}
            animationDuration={900}
            animationEasing="ease-out"
            activeDot={{ r: 4, strokeWidth: 0 }}
          />
        </AreaChart>
      </ChartContainer>
      {caption && (
        <div className="row muted chart-caption">
          <span>{time(data[0]?.ts_ms ?? 0)}</span>
          <span>{caption}</span>
          <span>Now</span>
        </div>
      )}
    </>
  );
}
