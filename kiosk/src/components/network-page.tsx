import { lazy, Suspense, useEffect, useState } from "react";
import { Gauge, History, Network } from "lucide-react";
import { apiUrl, useApi, type Resource } from "../api/client";
import type { Endpoints, NetworkEvent, NetworkRange } from "../api/types";
import { ms, number, seen } from "../lib/format";
import { mbps, NETWORK_RANGE_MS, networkBadge, usMs } from "../lib/network";
import { ResourceState } from "./sections";
import { Button } from "./ui/button";
import { PageHeader } from "./ui/page-header";
import { Panel } from "./ui/panel";
import { RangeToggle } from "./ui/range-toggle";
import { Stat } from "./ui/stat";
import { StatusChip } from "./ui/status-chip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

const NetworkCharts = lazy(() => import("./network-charts"));
const ranges: NetworkRange[] = ["1h", "24h", "7d", "30d"];
const date = (value: number | null | undefined) =>
  value == null ? "—" : new Date(value).toLocaleString();
const eventReason = (event: NetworkEvent) =>
  event.state === "degraded" ? event.reason : event.state === "down" ? "down" : "—";

/** Every event that overlaps the window, paging until one starts before it. */
function useRangeEvents(from: number, revision: number) {
  const [result, setResult] = useState<{ events: NetworkEvent[]; error: string }>({
    events: [],
    error: "",
  });
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const events: NetworkEvent[] = [];
      let cursor = "";
      try {
        do {
          const response = await fetch(apiUrl(`/v1/network/events?limit=200${cursor}`), {
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Event bands: HTTP ${response.status}`);
          const page = (await response.json()) as Endpoints["/v1/network/events"];
          events.push(...page.events);
          // Pages are newest first by start, so an older start means the window is covered.
          if (page.next_before == null || (page.events.at(-1)?.started_ms ?? 0) < from) break;
          cursor = `&before=${page.next_before}`;
        } while (!controller.signal.aborted);
        if (!controller.signal.aborted) setResult({ events, error: "" });
      } catch (error) {
        if (!controller.signal.aborted)
          setResult({
            events: [],
            error: error instanceof Error ? error.message : "Event bands failed",
          });
      }
    })();
    return () => controller.abort();
  }, [from, revision]);
  return result;
}

function Events({ now, revision }: { now: number; revision: number }) {
  const [before, setBefore] = useState<number | null>(null);
  const events = useApi(
    "/v1/network/events",
    `?limit=20${before == null ? "" : `&before=${before}`}`,
    revision,
  );
  return (
    <Panel
      title="Network events"
      subtitle="Degraded and down episodes, newest first"
      icon={<History />}
      index={6}
    >
      <ResourceState
        resource={events}
        empty={events.data?.events.length === 0 ? "No network events." : undefined}
      />
      {!!events.data?.events.length && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Layer</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Start</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Peak loss</TableHead>
              <TableHead>RTT</TableHead>
              <TableHead>Jitter</TableHead>
              <TableHead>End</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.data.events.map((event) => (
              <TableRow key={event.id}>
                <TableCell>{event.state === "healthy" ? "—" : event.layer}</TableCell>
                <TableCell>
                  <StatusChip tone={event.state === "down" ? "fail" : "warn"}>
                    {eventReason(event)}
                  </StatusChip>
                </TableCell>
                <TableCell>{date(event.started_ms)}</TableCell>
                <TableCell>
                  {event.ended_ms == null
                    ? `${ms(Math.max(0, now - event.started_ms))} · ongoing`
                    : ms(event.ended_ms - event.started_ms)}
                </TableCell>
                <TableCell>{number(event.peak_loss_percent, "%")}</TableCell>
                <TableCell>{usMs(event.peak_rtt_us)}</TableCell>
                <TableCell>{usMs(event.peak_mdev_us)}</TableCell>
                <TableCell>{event.end_reason ?? "ongoing"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <div className="row">
        {before != null && (
          <Button variant="outline" size="sm" onClick={() => setBefore(null)}>
            Newest events
          </Button>
        )}
        {events.data?.next_before != null && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setBefore(events.data!.next_before ?? null)}
          >
            Older events
          </Button>
        )}
      </div>
    </Panel>
  );
}

function SpeedTests({ tests }: { tests: Resource<Endpoints["/v1/network/speed-tests"]> }) {
  const recent = [...(tests.data?.tests ?? [])].reverse().slice(0, 20);
  return (
    <Panel title="Recent speed tests" subtitle="Newest first" icon={<Gauge />} index={7}>
      <ResourceState
        resource={tests}
        empty={tests.data && !recent.length ? "No speed tests in this range." : undefined}
      />
      {!!recent.length && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Started</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead>Download</TableHead>
              <TableHead>Upload</TableHead>
              <TableHead>Idle</TableHead>
              <TableHead>Loaded ↓ / ↑</TableHead>
              <TableHead>Colo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recent.map((test) => (
              <TableRow key={test.id}>
                <TableCell>{date(test.started_ms)}</TableCell>
                <TableCell>
                  <StatusChip tone={test.outcome === "ok" ? "ok" : "fail"} title={test.error ?? ""}>
                    {test.outcome}
                  </StatusChip>
                </TableCell>
                <TableCell>{mbps(test.download_bps)}</TableCell>
                <TableCell>{mbps(test.upload_bps)}</TableCell>
                <TableCell>{number(test.idle_latency_ms, "ms")}</TableCell>
                <TableCell>
                  {number(test.download_loaded_latency_ms)} /{" "}
                  {number(test.upload_loaded_latency_ms)} ms
                </TableCell>
                <TableCell>{test.colo ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

export default function NetworkPage({
  status,
  now,
  revision,
  speedRevision,
}: {
  status: Resource<Endpoints["/v1/network"]>;
  now: number;
  revision: number;
  speedRevision: number;
}) {
  const [range, setRange] = useState<NetworkRange>("24h");
  // Window edges move once per minute so the event pager does not refetch every second.
  const minute = Math.floor(now / 60_000) * 60_000;
  const from = minute - NETWORK_RANGE_MS[range];
  const history = useApi("/v1/network/history", `?range=${range}`, revision);
  // The speed-test endpoint has no 1h range; 1h charts clip the 24h list.
  const tests = useApi(
    "/v1/network/speed-tests",
    `?range=${range === "1h" ? "24h" : range}`,
    revision + speedRevision,
  );
  const open = status.data?.open_event;
  // Episodes change only when the open event does, so that drives event refetches.
  const episodes = revision + (open?.id ?? 0);
  const bands = useRangeEvents(from, episodes);
  const badge = networkBadge(status.data, now);
  const test = status.data?.latest_speed_test;
  return (
    <main id="main" className="dashboard network-page">
      <PageHeader
        eyebrow="Network"
        title="Network · Link quality"
        aside="factory-gpu → lan, wan, dns, tailnet"
      />
      <Panel
        title="Now"
        subtitle="Latest probe per target · 30 s ticks"
        icon={<Network />}
        index={0}
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
        aria-label="Network now"
      >
        <ResourceState resource={status} />
        {status.data && (
          <>
            <div className="ups-live-grid">
              <Stat label="Download" value={mbps(test?.download_bps)} size="lg" />
              <Stat label="Upload" value={mbps(test?.upload_bps)} size="lg" />
              <Stat
                label="Last speed test"
                value={test ? seen(test.ended_ms, now) : "None yet"}
                note={test ? `${test.outcome}${test.colo ? ` · ${test.colo}` : ""}` : undefined}
              />
              <Stat
                label="Open episode"
                value={open ? ms(Math.max(0, now - open.started_ms)) : "None"}
                note={
                  open
                    ? `Since ${date(open.started_ms)} · peak loss ${number(open.peak_loss_percent, "%")}`
                    : undefined
                }
              />
            </div>
            <Table aria-label="Latest probe per target">
              <TableHeader>
                <TableRow>
                  <TableHead>Layer</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Probe</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead>RTT</TableHead>
                  <TableHead>Jitter</TableHead>
                  <TableHead>Age</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {status.data.targets.map((target) => {
                  const sample = target.latest;
                  return (
                    <TableRow key={`${target.layer}:${target.target}`}>
                      <TableCell>{target.layer}</TableCell>
                      <TableCell>{target.target}</TableCell>
                      <TableCell>{target.probe}</TableCell>
                      <TableCell>
                        {sample ? `${sample.received} / ${sample.sent} replies` : "—"}
                      </TableCell>
                      <TableCell>{usMs(sample?.rtt?.avg_us)}</TableCell>
                      <TableCell>{usMs(sample?.rtt?.mdev_us)}</TableCell>
                      <TableCell>{sample ? seen(sample.ts_ms, now) : "No sample"}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {status.data.warnings.map((warning) => (
              <p key={warning} className="status-warn">
                {warning}
              </p>
            ))}
          </>
        )}
      </Panel>
      <section aria-label="Network history" className="ups-history">
        <div className="row section-head">
          <h3>History</h3>
          <RangeToggle value={range} options={ranges} onChange={setRange} label="History range" />
        </div>
        {history.error && (
          <p role="alert" className="status-fail">
            History: {history.error}
          </p>
        )}
        {tests.error && (
          <p role="alert" className="status-fail">
            Speed tests: {tests.error}
          </p>
        )}
        {bands.error && (
          <p role="alert" className="status-warn">
            {bands.error}
          </p>
        )}
        {history.loading ? (
          <p className="loading">Loading history…</p>
        ) : (
          <Suspense fallback={<p className="loading">Loading charts…</p>}>
            <NetworkCharts
              series={history.data?.series ?? []}
              events={bands.events}
              tests={tests.data?.tests ?? []}
              from={from}
              now={now}
            />
          </Suspense>
        )}
      </section>
      <div className="network-tables">
        <Events now={now} revision={episodes} />
        <SpeedTests tests={tests} />
      </div>
    </main>
  );
}
