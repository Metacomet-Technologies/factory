import { lazy, Suspense, type ReactNode } from "react";
import { Globe } from "lucide-react";
import type { Resource } from "../api/client";
import type { Endpoints, NetworkSpeedTest } from "../api/types";
import { mbps, number, seen } from "../lib/format";
import { freshStatus, layerNow, layerTrend, networkBadge } from "../lib/network";
import { ResourceState, Warnings } from "./sections";
import { Panel } from "./ui/panel";
import { Skeleton } from "./ui/skeleton";
import { Stat } from "./ui/stat";
import { StatusChip, StatusText } from "./ui/status-chip";

const NetworkTrend = lazy(() => import("./network-trend"));

function testNote(test: NetworkSpeedTest | null | undefined, now: number): ReactNode {
  if (!test) return "No speed test yet";
  if (test.outcome === "ok") return `Tested ${seen(test.started_ms, now)}`;
  return (
    <StatusText tone={test.outcome === "failed" ? "fail" : "warn"}>
      Last test {test.outcome === "failed" ? "failed" : "timed out"} {seen(test.started_ms, now)}
    </StatusText>
  );
}

/** Dashboard card: link state, the latest speed test and 24 h WAN sparklines. Links to /network. */
export function NetworkSection({
  status,
  trend,
  now,
  index,
}: {
  status: Resource<Endpoints["/v1/network"]>;
  trend: Resource<Endpoints["/v1/network/history"]>;
  now: number;
  index?: number;
}) {
  const fresh = freshStatus(status.data, now);
  const badge = networkBadge(fresh);
  const wan = layerNow(fresh?.targets ?? [], "wan");
  const points = trend.data ? layerTrend(trend.data.series, "wan") : [];
  const test = status.data?.latest_speed_test;
  const sparkline = (metric: "latency" | "loss") =>
    trend.loading ? (
      <Skeleton className="trend-chart" aria-label="Loading WAN history" />
    ) : trend.error ? (
      <p className="muted">WAN history unavailable: {trend.error}</p>
    ) : points.length === 0 ? (
      <p className="muted">No WAN samples in 24 h.</p>
    ) : (
      <Suspense fallback={<Skeleton className="trend-chart" aria-label="Loading WAN chart" />}>
        <NetworkTrend points={points} metric={metric} />
      </Suspense>
    );
  return (
    <a
      href="/network"
      className="panel-link network"
      aria-label="Network latency, loss and throughput"
    >
      <Panel
        title="Network"
        subtitle="factory-gpu · LAN, WAN, DNS and Tailnet probes"
        icon={<Globe />}
        index={index}
        tone={badge.tone === "fail" || badge.tone === "warn" ? badge.tone : undefined}
        action={
          <StatusChip tone={badge.tone} dot={fresh !== null} pulse={badge.tone === "fail"}>
            {badge.label}
          </StatusChip>
        }
      >
        <ResourceState resource={status} />
        {status.data && (
          <div className="network-readings">
            <Stat
              label="Download"
              value={test?.download_bps ?? null}
              format={mbps}
              note={testNote(test, now)}
            />
            <Stat
              label="Upload"
              value={test?.upload_bps ?? null}
              format={mbps}
              note={`Loaded latency ${number(test?.download_loaded_latency_ms, "ms")} / ${number(test?.upload_loaded_latency_ms, "ms")}`}
            />
            <div className="network-trend">
              <Stat
                label="WAN latency"
                value={wan.latency}
                format={(n) => number(n, "ms")}
                size="sm"
              />
              {sparkline("latency")}
            </div>
            <div className="network-trend">
              <Stat
                label="WAN loss"
                value={wan.loss}
                format={(n) => (n == null ? "—" : `${number(n)}%`)}
                size="sm"
              />
              {sparkline("loss")}
            </div>
          </div>
        )}
        <Warnings warnings={status.data?.warnings ?? []} />
      </Panel>
    </a>
  );
}
