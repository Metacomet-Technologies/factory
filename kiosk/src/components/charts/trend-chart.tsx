import { useId } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  XAxis,
  YAxis,
} from "recharts";
import { useReducedMotion } from "@/lib/motion";
import { time } from "@/lib/format";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../ui/chart";

/**
 * TrendChart: one accent series over time with an animated first draw and a hover tooltip.
 * The `comet` variant (default) fades the stroke in from the left and ends in a lit "now"
 * head with a halo and a steady ring; `area` keeps the soft gradient fill for multi-hour
 * views. Import it only from lazily loaded chart modules so Recharts stays out of the main
 * bundle.
 */
export function TrendChart<T extends { ts_ms: number }>({
  data,
  dataKey,
  label,
  ariaLabel,
  domain = [0, 100],
  className = "trend-chart",
  caption,
  variant = "comet",
}: {
  data: T[];
  dataKey: Extract<keyof T, string>;
  label: string;
  ariaLabel: string;
  domain?: [number | "auto", number | "auto"] | undefined;
  className?: string | undefined;
  caption?: string | undefined;
  variant?: "comet" | "area" | undefined;
}) {
  const reduced = useReducedMotion();
  const gradient = `trend-${useId().replace(/:/g, "")}`;
  const last = data.findLast((point) => typeof point[dataKey] === "number");
  const margin = { left: 0, right: 8, top: 8, bottom: 0 };
  const grid = <CartesianGrid vertical={false} strokeDasharray="3 5" />;
  const axes = (
    <>
      <XAxis dataKey="ts_ms" hide />
      <YAxis domain={domain} hide />
    </>
  );
  const tooltip = (
    <ChartTooltip
      content={<ChartTooltipContent />}
      labelFormatter={(_, items) => time(Number(items[0]?.payload?.ts_ms))}
    />
  );
  return (
    <>
      <div className="chart-wrap">
        <ChartContainer
          config={{ [dataKey]: { label, color: "var(--accent-text)" } }}
          className={className}
          aria-label={ariaLabel}
        >
          {variant === "area" ? (
            <AreaChart data={data} accessibilityLayer margin={margin}>
              <defs>
                <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent-text)" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="var(--accent-text)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              {grid}
              {axes}
              {tooltip}
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
          ) : (
            <LineChart data={data} accessibilityLayer margin={margin}>
              <defs>
                {/* userSpaceOnUse: a flat series has a zero-height bounding box, which would
                    otherwise drop an objectBoundingBox gradient and the stroke with it. */}
                <linearGradient
                  id={gradient}
                  gradientUnits="userSpaceOnUse"
                  x1="0"
                  y1="0"
                  x2="100%"
                  y2="0"
                >
                  <stop offset="0%" className="stop-c0" />
                  <stop offset="55%" className="stop-c1" />
                  <stop offset="100%" className="stop-c2" />
                </linearGradient>
              </defs>
              {grid}
              {axes}
              {tooltip}
              <Line
                type="monotone"
                dataKey={dataKey}
                className="comet"
                stroke={`url(#${gradient})`}
                strokeWidth={2.5}
                dot={false}
                connectNulls={false}
                isAnimationActive={!reduced}
                animationDuration={900}
                animationEasing="ease-out"
                activeDot={{ r: 4, strokeWidth: 0, fill: "var(--accent-text)" }}
              />
              {last && (
                <ReferenceDot
                  x={last.ts_ms}
                  y={last[dataKey] as number}
                  ifOverflow="visible"
                  shape={({ cx, cy }) => (
                    <g className="comet-now" aria-hidden="true">
                      <circle className="comet-ring" cx={cx} cy={cy} r={5} />
                      <circle className="comet-head" cx={cx} cy={cy} r={5} />
                    </g>
                  )}
                />
              )}
            </LineChart>
          )}
        </ChartContainer>
      </div>
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
