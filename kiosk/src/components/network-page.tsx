import { lazy, Suspense, useEffect, useState } from "react";
import { Gauge, Globe, History } from "lucide-react";
import { apiUrl, useApi, type Resource } from "../api/client";
import type { Endpoints, NetworkEvent, NetworkRange } from "../api/types";
import { mbps, ms, number, seen } from "../lib/format";
import {
  NETWORK_RANGES,
  endLabel,
  episodeLabel,
  eventBands,
  freshStatus,
  layerLabel,
  linkLabel,
  linkTone,
  lossPercent,
  networkBadge,
  outcomeTone,
  rangeMs,
  speedRange,
} from "../lib/network";
import { ResourceState, Warnings } from "./sections";
import { Button } from "./ui/button";
import { PageHeader } from "./ui/page-header";
import { Panel } from "./ui/panel";
import { RangeToggle } from "./ui/range-toggle";
import { StatusChip } from "./ui/status-chip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

const NetworkCharts = lazy(() => import("./network-charts"));
const date = (value: number) => new Date(value).toLocaleString();
const percent = (value: number | null | undefined) => (value == null ? "—" : `${number(value)}%`);
const latency = (us: number | null | undefined) => number(us == null ? null : us / 1000, "ms");

function Head({ labels }: { labels: string[] }) {
  return (
    <TableHeader>
      <TableRow>
        {labels.map((label) => (
          <TableHead key={label}>{label}</TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );
}

function Live({ status, now }: { status: Resource<Endpoints["/v1/network"]>; now: number }) {
  const badge = networkBadge(freshStatus(status.data, now));
  const open = status.data?.open_event;
  const test = status.data?.latest_speed_test;
  return (
    <Panel
      title="Live"
      subtitle="Probed every 30 s from factory-gpu"
      icon={<Globe />}
      index={0}
      aria-label="Live network"
      tone={badge.tone === "fail" || badge.tone === "warn" ? badge.tone : undefined}
      action={
        <StatusChip tone={badge.tone} dot={badge.tone !== "neutral"} pulse={badge.tone === "fail"}>
          {badge.label}
        </StatusChip>
      }
    >
      <ResourceState resource={status} />
      {open && (
        <p className={linkTone(open) === "fail" ? "status-fail" : "status-warn"}>
          {linkLabel(open)} since {date(open.started_ms)} · {ms(Math.max(0, now - open.started_ms))}{" "}
          · peak loss {percent(open.peak_loss_percent)}
        </p>
      )}
      {status.data && (
        <Table>
          <Head labels={["Layer", "Target", "Address", "Latency", "Loss", "Jitter", "Sampled"]} />
          <TableBody>
            {status.data.targets.map(({ layer, target, latest }) => (
              <TableRow key={target}>
                <TableCell>{layerLabel[layer]}</TableCell>
                <TableCell className="font-medium">{target}</TableCell>
                <TableCell>{latest?.address ?? "—"}</TableCell>
                <TableCell>{latency(latest?.rtt?.avg_us)}</TableCell>
                <TableCell>{percent(latest ? lossPercent(latest) : null)}</TableCell>
                <TableCell>{latency(latest?.rtt?.mdev_us)}</TableCell>
                <TableCell>{latest ? seen(latest.ts_ms, now) : "No sample yet"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {test && (
        <p className="muted">
          Last speed test {date(test.started_ms)} · {test.outcome} · {mbps(test.download_bps)} down
          · {mbps(test.upload_bps)} up · idle {number(test.idle_latency_ms, "ms")}
          {test.colo ? ` · ${test.colo}` : ""}
          {test.error ? ` · ${test.error}` : ""}
        </p>
      )}
      <Warnings warnings={status.data?.warnings ?? []} />
    </Panel>
  );
}

function Events({ now, index }: { now: number; index: number }) {
  const [cursor, setCursor] = useState("");
  const events = useApi("/v1/network/events", `?limit=20${cursor}`);
  const page = events.data;
  return (
    <Panel
      title="Network events"
      subtitle="Degraded and down episodes, newest first"
      icon={<History />}
      index={index}
      aria-label="Network events"
    >
      {events.error && (
        <p role="alert" className="status-fail">
          {events.error}
        </p>
      )}
      {events.loading && <p className="loading">Loading events…</p>}
      {page?.events.length === 0 && <p className="empty">No network events.</p>}
      {!!page?.events.length && (
        <Table>
          <Head
            labels={[
              "Started",
              "State",
              "Layer",
              "Duration",
              "Peak loss",
              "Peak latency",
              "Peak jitter",
              "Ended",
            ]}
          />
          <TableBody>
            {page.events.map((event) => (
              <TableRow key={event.id}>
                <TableCell>{date(event.started_ms)}</TableCell>
                <TableCell>
                  <StatusChip tone={linkTone(event)}>{episodeLabel(event)}</StatusChip>
                </TableCell>
                <TableCell>{event.state === "healthy" ? "—" : layerLabel[event.layer]}</TableCell>
                <TableCell>
                  {ms(Math.max(0, (event.ended_ms ?? now) - event.started_ms))}
                  {event.ended_ms == null ? " · ongoing" : ""}
                </TableCell>
                <TableCell>{percent(event.peak_loss_percent)}</TableCell>
                <TableCell>{latency(event.peak_rtt_us)}</TableCell>
                <TableCell>{latency(event.peak_mdev_us)}</TableCell>
                <TableCell>{event.end_reason ? endLabel[event.end_reason] : "Ongoing"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <div className="row">
        {cursor && (
          <Button variant="outline" size="sm" onClick={() => setCursor("")}>
            Newest events
          </Button>
        )}
        {page?.next_before != null && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCursor(`&before=${page.next_before}`)}
          >
            Older events
          </Button>
        )}
      </div>
    </Panel>
  );
}

function SpeedTests({
  resource,
  range,
  now,
  index,
}: {
  resource: Resource<Endpoints["/v1/network/speed-tests"]>;
  range: NetworkRange;
  now: number;
  index: number;
}) {
  const tests = resource.data?.tests ?? [];
  const recent = tests.slice(-10).reverse();
  return (
    <Panel
      title="Speed tests"
      subtitle={
        tests.length
          ? `Newest ${recent.length} of ${tests.length} in the last ${speedRange[range]}`
          : `Last ${speedRange[range]}`
      }
      icon={<Gauge />}
      index={index}
      aria-label="Speed tests"
    >
      <ResourceState
        resource={resource}
        empty={resource.data && !tests.length ? "No speed tests in this range." : undefined}
      />
      {!!recent.length && (
        <Table>
          <Head labels={["Started", "Outcome", "Download", "Upload", "Idle", "Loaded", "Detail"]} />
          <TableBody>
            {recent.map((test) => (
              <TableRow key={test.id}>
                <TableCell title={date(test.started_ms)}>{seen(test.started_ms, now)}</TableCell>
                <TableCell>
                  <StatusChip tone={outcomeTone[test.outcome]}>{test.outcome}</StatusChip>
                </TableCell>
                <TableCell>{mbps(test.download_bps)}</TableCell>
                <TableCell>{mbps(test.upload_bps)}</TableCell>
                <TableCell>{number(test.idle_latency_ms, "ms")}</TableCell>
                <TableCell>
                  {number(test.download_loaded_latency_ms, "ms")} /{" "}
                  {number(test.upload_loaded_latency_ms, "ms")}
                </TableCell>
                <TableCell>{test.error ?? test.colo ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

/** Network drill-down: live state, per-layer history with event bands, events and speed tests. */
export default function NetworkPage({
  status,
  now,
  revision,
}: {
  status: Resource<Endpoints["/v1/network"]>;
  now: number;
  revision: number;
}) {
  const [range, setRange] = useState<NetworkRange>("24h");
  const episode = status.data?.open_event?.id ?? 0;
  const testId = status.data?.latest_speed_test?.id ?? 0;
  const history = useApi("/v1/network/history", `?range=${range}`, revision);
  const speed = useApi("/v1/network/speed-tests", `?range=${speedRange[range]}`, revision + testId);
  const [episodes, setEpisodes] = useState<{ events: NetworkEvent[]; error: string }>({
    events: [],
    error: "",
  });
  useEffect(() => {
    const controller = new AbortController();
    // Bands need every episode that overlaps the window, beyond the table's page.
    void (async () => {
      const events: NetworkEvent[] = [];
      const since = Date.now() - rangeMs[range];
      let cursor = "";
      try {
        do {
          const response = await fetch(apiUrl(`/v1/network/events?limit=200${cursor}`), {
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const page = (await response.json()) as Endpoints["/v1/network/events"];
          events.push(...page.events);
          if (page.next_before == null || page.events.some((event) => event.started_ms < since))
            break;
          cursor = `&before=${page.next_before}`;
        } while (!controller.signal.aborted);
        if (!controller.signal.aborted) setEpisodes({ events, error: "" });
      } catch (error) {
        if (!controller.signal.aborted)
          setEpisodes({
            events: [],
            error: error instanceof Error ? error.message : "Request failed",
          });
      }
    })();
    return () => controller.abort();
  }, [range, revision, episode]);
  const since = now - rangeMs[range];
  return (
    <main id="main" className="dashboard network-page">
      <PageHeader
        eyebrow="Network"
        title="Network · Latency, loss & throughput"
        aside="factory-gpu · LAN, WAN, DNS and Tailnet"
      />
      <Live status={status} now={now} />
      <section aria-label="Network history" className="network-history">
        <div className="row section-head">
          <h3>History</h3>
          <RangeToggle
            value={range}
            options={NETWORK_RANGES}
            onChange={setRange}
            label="History range"
          />
        </div>
        {history.error && (
          <p role="alert" className="status-fail">
            History: {history.error}
          </p>
        )}
        {speed.error && (
          <p role="alert" className="status-fail">
            Speed tests: {speed.error}
          </p>
        )}
        {episodes.error && (
          <p role="alert" className="status-warn">
            Event bands unavailable: {episodes.error}
          </p>
        )}
        {history.loading ? (
          <p className="loading">Loading history…</p>
        ) : (
          <Suspense fallback={<p className="loading">Loading charts…</p>}>
            <NetworkCharts
              series={history.data?.series ?? []}
              tests={speed.data?.tests ?? (speed.loading ? null : [])}
              bands={eventBands(episodes.events, since, now)}
              since={since}
              speedSince={now - rangeMs[speedRange[range]]}
              now={now}
              range={range}
            />
          </Suspense>
        )}
      </section>
      <Events key={episode} now={now} index={6} />
      <SpeedTests resource={speed} range={range} now={now} index={7} />
    </main>
  );
}
