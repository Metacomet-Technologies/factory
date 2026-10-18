import { lazy, Suspense, useState } from "react";
import {
  Activity,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
  RadioTower,
  Thermometer,
  Wrench,
} from "lucide-react";
import type { DeviceHistory, DeviceRange, DeviceView, Metric } from "../api/types";
import type { components } from "../api/generated";
import { freshenRemote, linkState, metricText, type LinkState } from "../lib/devices";
import { ms, number, seen } from "../lib/format";
import { KeyValue } from "./ui/key-value";
import { MeterBar } from "./ui/meter-bar";
import { PageHeader } from "./ui/page-header";
import { Panel } from "./ui/panel";
import { RangeToggle } from "./ui/range-toggle";
import { Stat, StatGrid } from "./ui/stat";
import { StatusChip, type Tone } from "./ui/status-chip";

type HealthStatus = components["schemas"]["HealthStatus"];
type Availability = components["schemas"]["Availability"];

const DevicesChart = lazy(() => import("./devices-chart"));
const ranges: DeviceRange[] = ["1h", "24h", "7d"];

export function healthTone(status: HealthStatus): Tone {
  switch (status) {
    case "critical":
      return "fail";
    case "warning":
    case "stale":
      return "warn";
    case "healthy":
      return "ok";
    default:
      return "neutral";
  }
}

const percentTone = (value: number | null | undefined, warn = 80, fail = 95) =>
  value == null ? "muted" : value >= fail ? "fail" : value >= warn ? "warn" : "ok";

const availabilityText = (value: Availability) => value.replaceAll("_", " ");

/** Numeric stat that tweens on live updates while keeping the metric's unit formatting. */
function MetricStat({
  label,
  metric,
  tone,
  size,
}: {
  label: string;
  metric: Metric;
  tone?: "ok" | "warn" | "fail" | undefined;
  size?: "sm" | "md" | "lg" | undefined;
}) {
  return (
    <Stat
      label={label}
      value={metric.value ?? null}
      format={(n) => (n == null ? "—" : metricText({ ...metric, value: n }))}
      tone={tone}
      size={size}
      note={
        metric.value == null && metric.availability !== "available"
          ? availabilityText(metric.availability)
          : undefined
      }
    />
  );
}

const linkText: Record<LinkState, string> = {
  waiting: "Waiting for first sample",
  live: "Live",
  stale: "Stale",
  offline: "Offline",
};
const linkTone: Record<LinkState, Tone> = {
  waiting: "neutral",
  live: "ok",
  stale: "warn",
  offline: "fail",
};

/** Transport and collection freshness for a remote device's agent, plus its capability limits. */
function AgentLink({ view, now }: { view: DeviceView; now: number }) {
  const ingest = view.ingest!;
  const host = view.device;
  const state = linkState(view, now);
  // Remember the last time the link came back, so recovery is visible, not silent.
  const [previous, setPrevious] = useState(state);
  const [recoveredAt, setRecoveredAt] = useState<number | null>(null);
  if (previous !== state) {
    setPrevious(state);
    setRecoveredAt(
      state === "live" && (previous === "stale" || previous === "offline") ? now : null,
    );
  }
  const waiting = state === "waiting";
  const skew = ingest.clock_skew_ms;
  return (
    <Panel
      title="Agent link"
      subtitle={`Remote push · ${ingest.agent_version ? `agent ${ingest.agent_version}` : "no agent yet"}`}
      icon={<RadioTower />}
      index={1}
      className="max-sm:col-span-full"
      tone={state === "offline" ? "fail" : state === "stale" ? "warn" : undefined}
      action={
        <StatusChip tone={linkTone[state]} dot>
          {linkText[state]}
        </StatusChip>
      }
    >
      <KeyValue
        rows={[
          [
            "Transport",
            ingest.last_received_at_ms == null
              ? "No sample since factory-api started"
              : `Received ${seen(ingest.last_received_at_ms, now)}`,
          ],
          ["Collection", waiting ? "—" : `Observed ${seen(host.observed_at_ms, now)}`],
          [
            "Session",
            ingest.session_id ? `${ingest.session_id.slice(0, 8)} · seq ${ingest.seq ?? "—"}` : "—",
          ],
          [
            "Clock skew",
            skew == null ? "—" : `${skew > 0 ? "+" : skew < 0 ? "−" : ""}${ms(Math.abs(skew))}`,
          ],
          ["Dropped samples", number(ingest.dropped_samples)],
          [
            "Capabilities",
            waiting
              ? "—"
              : `filesystems ${availabilityText(host.collector.filesystems)} · drives ${availabilityText(host.collector.drives)} · SMART ${availabilityText(host.collector.smart)} · fans ${availabilityText(host.cooling.fans_availability)}`,
          ],
        ]}
      />
      {recoveredAt != null && state === "live" && (
        <p className="status-ok">Recovered {seen(recoveredAt, now)}.</p>
      )}
      {ingest.identity_conflict && (
        <p role="alert" className="status-fail">
          Identity conflict: two agents are using this credential.
        </p>
      )}
      {view.warnings.map((warning) => (
        <p key={warning} className="status-warn">
          {warning}
        </p>
      ))}
      <p className="muted">
        Stale after 45 s without a received or observed sample. A live link does not prove every
        metric is healthy; unsupported and permission-denied readings are shown as such.
      </p>
    </Panel>
  );
}

export default function DevicesPage({
  deviceId,
  view: received,
  history,
  range,
  setRange,
  error,
  loading,
  connected,
  live,
  now,
}: {
  deviceId: string;
  view: DeviceView | null;
  history: DeviceHistory | null;
  range: DeviceRange;
  setRange: (range: DeviceRange) => void;
  error: string | null;
  loading: boolean;
  connected: boolean;
  live: boolean;
  now: number;
}) {
  // factory-gpu views come freshened by the server; a remote frame is freshened here
  // every second, because it may be a cached push while refetches fail.
  const view = received?.ingest != null ? freshenRemote(received, now) : received;
  const host = view?.device;
  const temperature = host?.cpu.temperature.value;
  const maintenance = host?.maintenance;
  const posture = view?.maintenance;
  const node =
    posture?.availability === "available" || posture?.availability === "stale" ? posture : null;
  const remote = view?.ingest != null;
  const link = view && remote ? linkState(view, now) : null;
  const status = host?.health.status;
  // A remote frame is labeled Live only while its agent link is live.
  const current = live && (link == null || link === "live");
  return (
    <main id="main" className="dashboard devices-page">
      <PageHeader
        eyebrow={deviceId}
        title="Host health"
        aside={
          <>
            {host ? `Updated ${seen(host.observed_at_ms, now)}` : "Waiting for host"}
            {connected ? "" : " · reconnecting"}
          </>
        }
      />
      {error && (
        <p role="alert" className="status-fail">
          {error}
        </p>
      )}
      {loading && !host && <p className="muted">Loading devices…</p>}
      {!loading && !error && !host && <p className="muted">No device sample yet.</p>}
      {host && (
        <div className="device-grid">
          <Panel
            title={host.identity.hostname ?? host.device_id}
            subtitle={`Host summary · ${current ? "Live" : "Stored"} · up ${metricText(host.identity.uptime)}`}
            icon={<HardDrive />}
            index={0}
            className="device-summary"
            tone={status === "critical" ? "fail" : status === "warning" ? "warn" : undefined}
            action={
              <StatusChip
                tone={healthTone(status ?? host.health.status)}
                dot
                pulse={current && status === "critical"}
              >
                {status}
              </StatusChip>
            }
            aria-label="Host summary"
          >
            <StatGrid columns={4}>
              <MetricStat label="CPU" metric={host.cpu.utilization} size="lg" />
              <MetricStat label="Memory used" metric={host.memory.used} size="lg" />
              <MetricStat
                label="Temperature"
                metric={host.cpu.temperature}
                size="lg"
                tone={
                  temperature == null
                    ? undefined
                    : temperature >= 95
                      ? "fail"
                      : temperature >= 85
                        ? "warn"
                        : undefined
                }
              />
              <MetricStat label="Load" metric={host.cpu.load1} size="lg" />
            </StatGrid>
            <MeterBar
              label="CPU utilization"
              value={host.cpu.utilization.value}
              tone={percentTone(host.cpu.utilization.value)}
            />
            {host.health.reasons.length > 0 && (
              <ul className="device-reasons">
                {host.health.reasons.map((reason) => (
                  <li
                    key={`${reason.metric}-${reason.threshold}-${reason.detail}`}
                    className={reason.status === "critical" ? "status-fail" : "status-warn"}
                  >
                    {reason.metric} {reason.threshold}{" "}
                    {reason.value == null ? "—" : number(reason.value)} {reason.detail}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {remote && view && <AgentLink view={view} now={now} />}

          <Panel
            title="CPU history"
            subtitle="Average utilization per bucket"
            icon={<Activity />}
            index={1}
            className="device-history"
            action={
              <RangeToggle
                value={range}
                options={ranges}
                onChange={setRange}
                label="History range"
              />
            }
          >
            {!history || history.points.length === 0 ? (
              <p className="empty">No samples in this range.</p>
            ) : (
              <Suspense fallback={<p className="loading">Loading chart…</p>}>
                <DevicesChart history={history.points} />
              </Suspense>
            )}
          </Panel>

          <Panel title="Memory" subtitle="RAM and swap" icon={<MemoryStick />} index={2}>
            <StatGrid columns={2}>
              <MetricStat label="Total" metric={host.memory.total} size="sm" />
              <MetricStat label="Available" metric={host.memory.available} size="sm" />
              <MetricStat label="Swap total" metric={host.memory.swap_total} size="sm" />
              <MetricStat label="Swap free" metric={host.memory.swap_free} size="sm" />
            </StatGrid>
            <MeterBar
              label="Memory used"
              value={
                host.memory.used.value != null && host.memory.total.value
                  ? (100 * host.memory.used.value) / host.memory.total.value
                  : null
              }
              tone={percentTone(
                host.memory.used.value != null && host.memory.total.value
                  ? (100 * host.memory.used.value) / host.memory.total.value
                  : null,
                85,
                95,
              )}
            />
          </Panel>

          <Panel title="Network & disk I/O" subtitle="Current rates" icon={<Network />} index={3}>
            <StatGrid columns={2}>
              <MetricStat label="Net rx" metric={host.network.rx} size="sm" />
              <MetricStat label="Net tx" metric={host.network.tx} size="sm" />
              <MetricStat label="Disk read" metric={host.disk_io.read} size="sm" />
              <MetricStat label="Disk write" metric={host.disk_io.write} size="sm" />
            </StatGrid>
            <KeyValue
              rows={[
                ["I/O wait", metricText(host.cpu.iowait)],
                ["Load 5 / 15", `${metricText(host.cpu.load5)} / ${metricText(host.cpu.load15)}`],
              ]}
            />
          </Panel>

          <Panel title="Filesystems" subtitle="Space and inodes" icon={<HardDrive />} index={4}>
            {host.filesystems.length === 0 ? (
              <p className="empty">No filesystems reported.</p>
            ) : (
              <ul className="device-list">
                {host.filesystems.map((fs) => (
                  <li key={fs.id}>
                    <div className="row">
                      <strong>{fs.mountpoint}</strong>
                      <span className="muted">
                        {metricText(fs.used)} of {metricText(fs.size)} · inodes{" "}
                        {metricText(fs.inodes_used_percent)}
                      </span>
                    </div>
                    <MeterBar
                      label={`${fs.mountpoint} used`}
                      value={fs.used_percent.value}
                      tone={percentTone(fs.used_percent.value, 80, 90)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Drives" subtitle="SMART and wear" icon={<Cpu />} index={5}>
            {host.drives.length === 0 ? (
              <p className="empty">No physical drives reported.</p>
            ) : (
              <ul className="device-list">
                {host.drives.map((drive) => (
                  <li key={drive.id}>
                    <div className="row">
                      <strong>{drive.model ?? drive.kernel}</strong>
                      <StatusChip
                        tone={
                          drive.media_critical || drive.smart.passed === false
                            ? "fail"
                            : drive.smart.passed
                              ? "ok"
                              : "neutral"
                        }
                      >
                        SMART {availabilityText(drive.smart.availability)}
                        {drive.smart.passed == null
                          ? ""
                          : drive.smart.passed
                            ? " · passed"
                            : " · failed"}
                      </StatusChip>
                    </div>
                    <p className="muted">
                      {drive.id} · {metricText(drive.size)} · spare{" "}
                      {metricText(drive.available_spare)} · media errors{" "}
                      {metricText(drive.media_errors)} · {metricText(drive.temperature)}
                      {drive.smart.availability === "unsupported"
                        ? ". Unsupported SMART is not evidence this drive is healthy."
                        : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Cooling" subtitle="Sensors and fans" icon={<Thermometer />} index={6}>
            {host.cooling.temperatures.length === 0 && host.cooling.fans.length === 0 ? (
              <p className="empty">
                Sensors {availabilityText(host.cooling.temperatures_availability)} · fans{" "}
                {availabilityText(host.cooling.fans_availability)}
              </p>
            ) : (
              <KeyValue
                rows={[...host.cooling.temperatures, ...host.cooling.fans].map(
                  (item) => [item.name, metricText(item.metric)] as const,
                )}
              />
            )}
            {host.gpus.length > 0 && (
              <KeyValue
                rows={host.gpus.map(
                  (gpu) =>
                    [
                      `GPU ${gpu.index}`,
                      `${metricText(gpu.utilization)} · ${metricText(gpu.memory_used)} of ${metricText(gpu.memory_total)} · ${metricText(gpu.temperature)} · ${metricText(gpu.power)}`,
                    ] as const,
                )}
              />
            )}
          </Panel>

          {maintenance && (
            <Panel
              title="Maintenance"
              subtitle={
                remote ? "Backup, reboot, clock" : "Node posture · backup, reboot, clock, power"
              }
              icon={<Wrench />}
              index={7}
              className="max-sm:col-span-full"
            >
              {!remote && (
                <>
                  <p className="muted">
                    Maintenance snapshot:{" "}
                    {posture?.availability === "not_published"
                      ? "not yet published"
                      : `${availabilityText(posture?.availability ?? "unsupported")}${
                          node
                            ? ` · observed ${seen(node.observed_at_ms, now)}`
                            : " · no readable snapshot"
                        }`}
                    {posture && "error" in posture ? ` · ${posture.error}` : ""}
                  </p>
                  <KeyValue
                    className={node?.availability === "stale" ? "muted" : undefined}
                    rows={[
                      [
                        "Pending updates",
                        node?.updates.availability === "available"
                          ? `${node.updates.security} security · ${node.updates.other} other`
                          : (node?.updates.availability ?? "unavailable"),
                      ],
                      [
                        "Held packages",
                        node?.held.availability === "available"
                          ? node.held.packages.join(", ") || "None"
                          : (node?.held.availability ?? "unavailable"),
                      ],
                      ...(
                        [
                          ["unattended_upgrades", "unattended-upgrades"],
                          ["fstrim_timer", "fstrim.timer"],
                          ["smartd", "smartd"],
                        ] as const
                      ).map(([key, label]) => {
                        const state = node?.services[key] ?? "unknown";
                        return [
                          label,
                          <StatusChip
                            key={key}
                            tone={state === "enabled" ? "ok" : "warn"}
                            aria-label={
                              state === "enabled" ? undefined : `Warning: ${label} ${state}`
                            }
                          >
                            {state}
                          </StatusChip>,
                        ] as const;
                      }),
                      [
                        "Unattended auto-reboot",
                        node?.unattended_auto_reboot.availability === "available" ? (
                          <StatusChip
                            key="unattended-auto-reboot"
                            tone={node.unattended_auto_reboot.value ? "warn" : "neutral"}
                            aria-label={
                              node.unattended_auto_reboot.value
                                ? "Warning: unattended auto-reboot enabled"
                                : undefined
                            }
                          >
                            {node.unattended_auto_reboot.value ? "On" : "Off"}
                          </StatusChip>
                        ) : (
                          (node?.unattended_auto_reboot.availability ?? "unavailable")
                        ),
                      ],
                      [
                        "Tailscale auto-update",
                        node?.tailscale_auto_update.availability === "available"
                          ? `Check ${node.tailscale_auto_update.check ? "on" : "off"} · apply ${node.tailscale_auto_update.apply ? "on" : "off"}`
                          : (node?.tailscale_auto_update.availability ?? "unavailable"),
                      ],
                      [
                        "Journal size",
                        node?.journal_bytes.availability === "available"
                          ? number(node.journal_bytes.value / 1024 ** 2, "MiB")
                          : (node?.journal_bytes.availability ?? "unavailable"),
                      ],
                      ...host.drives.map(
                        (drive) =>
                          [
                            `${drive.kernel} unsafe shutdowns`,
                            drive.unsafe_shutdowns == null ? "—" : number(drive.unsafe_shutdowns),
                          ] as const,
                      ),
                    ]}
                  />
                </>
              )}
              <p>
                Backup {seen(maintenance.backup.last_success_ms, now)}. Reboot{" "}
                {maintenance.reboot.availability === "available"
                  ? maintenance.reboot.reboot_required
                    ? "required"
                    : "not required"
                  : availabilityText(maintenance.reboot.availability)}
                . Clock{" "}
                {maintenance.clock.synchronized == null
                  ? "—"
                  : maintenance.clock.synchronized
                    ? "synchronized"
                    : "not synchronized"}
                .{" "}
                {remote ? (
                  "UPS is reported only for factory-gpu."
                ) : (
                  <>
                    <a href={maintenance.ups.href}>UPS</a>
                    {maintenance.ups.status ? ` ${maintenance.ups.status}` : ""}
                    {maintenance.ups.charge_percent == null
                      ? ""
                      : ` · ${number(maintenance.ups.charge_percent)}%`}
                  </>
                )}
              </p>
              {maintenance.backup.error && (
                <p className="status-warn">{maintenance.backup.error}</p>
              )}
              {maintenance.reboot.detail && <p className="muted">{maintenance.reboot.detail}</p>}
              {maintenance.services.length > 0 && (
                <KeyValue
                  rows={maintenance.services.map(
                    (service) =>
                      [
                        service.name,
                        <StatusChip key={service.name} tone={service.ok ? "ok" : "fail"} dot>
                          {service.ok ? "ok" : "failing"}
                        </StatusChip>,
                      ] as const,
                  )}
                />
              )}
            </Panel>
          )}
        </div>
      )}
    </main>
  );
}
