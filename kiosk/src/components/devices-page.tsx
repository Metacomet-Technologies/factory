import { lazy, Suspense } from "react";
import type { DeviceHistory, DeviceRange, DeviceView } from "../api/types";
import { metricText } from "../lib/devices";
import { number, seen } from "../lib/format";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

const DevicesChart = lazy(() => import("./devices-chart"));
const ranges: DeviceRange[] = ["1h", "24h", "7d"];

export default function DevicesPage({
  view,
  history,
  range,
  setRange,
  error,
  loading,
  connected,
  live,
  now,
}: {
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
  const host = view?.device;
  return (
    <main id="main" className="dashboard devices-page">
      <div className="intro">
        <div>
          <p className="eyebrow">FACTORY GPU</p>
          <h2>Host health</h2>
        </div>
        <p className="muted">
          <a href="/">Dashboard</a>
          {" · "}
          <a href="/devices">Devices</a>
          {host ? ` · updated ${seen(host.observed_at_ms, now)}` : ""}
          {connected ? "" : " · reconnecting"}
        </p>
      </div>
      {error && (
        <p role="alert" className="status-fail">
          {error}
        </p>
      )}
      {loading && !host && <p className="muted">Loading devices…</p>}
      {!loading && !error && !host && <p className="muted">No device sample yet.</p>}
      {host && (
        <>
          <section className="ups-panel" aria-label="Host summary">
            <h3>
              {host.identity.hostname ?? host.device_id} <Badge>{host.health.status}</Badge>
              {live ? <span className="muted"> Live</span> : <span className="muted"> Stored</span>}
            </h3>
            <div className="ups-readings">
              <div>
                <p>CPU</p>
                <p>{metricText(host.cpu.utilization)}</p>
              </div>
              <div>
                <p>Memory used</p>
                <p>{metricText(host.memory.used)}</p>
              </div>
              <div>
                <p>Temperature</p>
                <p>{metricText(host.cpu.temperature)}</p>
              </div>
              <div>
                <p>Load</p>
                <p>{metricText(host.cpu.load1)}</p>
              </div>
            </div>
            {host.health.reasons.length > 0 && (
              <ul>
                {host.health.reasons.map((reason) => (
                  <li key={`${reason.metric}-${reason.threshold}-${reason.detail}`}>
                    {reason.metric} {reason.threshold}{" "}
                    {reason.value == null ? "—" : number(reason.value)} {reason.detail}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="ups-panel" aria-label="CPU history">
            <h3>CPU history</h3>
            <div className="row">
              {ranges.map((item) => (
                <Button
                  key={item}
                  variant={item === range ? "default" : "ghost"}
                  aria-pressed={item === range}
                  onClick={() => setRange(item)}
                >
                  {item}
                </Button>
              ))}
            </div>
            {!history || history.points.length === 0 ? (
              <p className="muted">No samples in this range.</p>
            ) : (
              <Suspense fallback={<p className="muted">Loading chart…</p>}>
                <DevicesChart history={history.points} />
              </Suspense>
            )}
          </section>
          <section className="ups-panel" aria-label="Filesystems">
            <h3>Filesystems</h3>
            {host.filesystems.length === 0 ? (
              <p className="muted">No filesystems reported.</p>
            ) : (
              <ul>
                {host.filesystems.map((fs) => (
                  <li key={fs.id}>
                    {fs.mountpoint} {metricText(fs.used_percent)} used, inodes{" "}
                    {metricText(fs.inodes_used_percent)}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="ups-panel" aria-label="Physical drives">
            <h3>Drives</h3>
            {host.drives.length === 0 ? (
              <p className="muted">No physical drives reported.</p>
            ) : (
              <ul>
                {host.drives.map((drive) => (
                  <li key={drive.id}>
                    {drive.id} SMART {drive.smart.availability}
                    {drive.smart.passed == null ? "" : drive.smart.passed ? " passed" : " failed"}
                    {drive.smart.availability === "unsupported"
                      ? ". Unsupported SMART is not evidence this drive is healthy."
                      : ""}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="ups-panel" aria-label="Maintenance">
            <h3>Maintenance</h3>
            <p>
              Backup {seen(host.maintenance.backup.last_success_ms, now)}. Reboot{" "}
              {host.maintenance.reboot.availability === "available"
                ? host.maintenance.reboot.reboot_required
                  ? "required"
                  : "not required"
                : host.maintenance.reboot.availability.replaceAll("_", " ")}
              . Clock{" "}
              {host.maintenance.clock.synchronized == null
                ? "—"
                : host.maintenance.clock.synchronized
                  ? "synchronized"
                  : "not synchronized"}
              . <a href={host.maintenance.ups.href}>UPS</a>
            </p>
          </section>
        </>
      )}
    </main>
  );
}
