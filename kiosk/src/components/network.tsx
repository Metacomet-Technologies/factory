import { Network } from "lucide-react";
import type { Resource } from "../api/client";
import type { Endpoints, NetworkSeries } from "../api/types";
import { number, seen } from "../lib/format";
import { mbps, networkBadge } from "../lib/network";
import { ResourceState } from "./sections";
import { Panel } from "./ui/panel";
import { Stat } from "./ui/stat";
import { StatusChip } from "./ui/status-chip";

/** Inline SVG sparkline of one metric for every target; first target accent, others muted. */
export function Sparkline({
  series,
  value,
  label,
  unit,
  floor,
  from,
  now,
}: {
  series: NetworkSeries[];
  value: (point: NetworkSeries["points"][number]) => number | null | undefined;
  label: string;
  unit: string;
  floor: number;
  from: number;
  now: number;
}) {
  const max = Math.max(
    floor,
    ...series.flatMap((target) => target.points.map((point) => value(point) ?? 0)),
  );
  const paths = series.map((target) =>
    target.points
      .map((point, index) => {
        const y = value(point);
        if (y == null) return "";
        const previous = index > 0 ? value(target.points[index - 1]!) : null;
        const x = (100 * (point.ts_ms - from)) / (now - from);
        return `${previous == null ? "M" : "L"}${x.toFixed(2)},${(42 - (40 * y) / max).toFixed(2)}`;
      })
      .join(" "),
  );
  return (
    <div className="network-spark">
      <span className="muted">
        {label} · 0–{number(max)} {unit}
      </span>
      <svg
        viewBox="0 0 100 44"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label} sparkline, ${series.map((target) => target.target).join(" and ") || "no targets"}`}
      >
        {paths.map((d, index) => (
          <path
            key={series[index]!.target}
            d={d}
            fill="none"
            stroke={index === 0 ? "var(--accent-text)" : "var(--muted-foreground)"}
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    </div>
  );
}

export function NetworkSection({
  status,
  history,
  now,
  index,
}: {
  status: Resource<Endpoints["/v1/network"]>;
  history: Resource<Endpoints["/v1/network/history"]>;
  now: number;
  index?: number;
}) {
  const badge = networkBadge(status.data, now);
  const test = status.data?.latest_speed_test;
  const wan = history.data?.series.filter((target) => target.layer === "wan") ?? [];
  return (
    <a href="/network" className="panel-link network" aria-label="Network quality details">
      <Panel
        title="Network"
        subtitle="Link quality · factory-gpu"
        icon={<Network />}
        index={index}
        tone={badge.tone === "fail" || badge.tone === "warn" ? badge.tone : undefined}
        action={
          <StatusChip
            tone={badge.tone}
            dot={badge.tone !== "neutral"}
            pulse={badge.tone === "fail"}
          >
            {badge.label}
          </StatusChip>
        }
      >
        {status.data ? (
          <div className="network-readings">
            <Stat label="Download" value={mbps(test?.download_bps)} />
            <Stat label="Upload" value={mbps(test?.upload_bps)} />
            <Stat
              label="Speed test"
              value={test ? seen(test.ended_ms, now) : "None yet"}
              note={test && test.outcome !== "ok" ? `Last test ${test.outcome}` : undefined}
              size="sm"
            />
            {history.data ? (
              <>
                <Sparkline
                  series={wan}
                  value={(point) => point.latency_ms.avg}
                  label="WAN latency 24h"
                  unit="ms"
                  floor={1}
                  from={now - 86_400_000}
                  now={now}
                />
                <Sparkline
                  series={wan}
                  value={(point) => point.loss_percent}
                  label="WAN loss 24h"
                  unit="%"
                  floor={5}
                  from={now - 86_400_000}
                  now={now}
                />
              </>
            ) : (
              <p className={history.error ? "status-warn" : "muted"}>
                {history.error ? `History: ${history.error}` : "Loading history…"}
              </p>
            )}
          </div>
        ) : status.error ? (
          // One line instead of the section Alert: the 1728×1117 grid has no room for it.
          <p role="alert" className="status-fail">
            Network status unavailable: {status.error}. Retrying on the next refresh.
          </p>
        ) : (
          <ResourceState resource={status} />
        )}
        {badge.label === "Unknown" &&
          status.data?.warnings.map((warning) => (
            <p className="status-warn" key={warning}>
              {warning}
            </p>
          ))}
      </Panel>
    </a>
  );
}
