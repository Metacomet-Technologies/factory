import { lazy, Suspense, useEffect, useState } from "react";
import { BatteryCharging, History, Plug, Settings2, Zap } from "lucide-react";
import { apiUrl, useApi } from "../api/client";
import type { LiveState } from "../api/stream";
import type { Endpoints, UpsCurrent, UpsEvent, UpsRange, UpsSettings } from "../api/types";
import { ms, number, usd } from "../lib/format";
import { electricityRate, rateInput } from "../lib/ups";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { KeyValue } from "./ui/key-value";
import { MeterBar } from "./ui/meter-bar";
import { PageHeader } from "./ui/page-header";
import { Panel, Tile } from "./ui/panel";
import { RangeToggle } from "./ui/range-toggle";
import { Stat } from "./ui/stat";
import { StatusChip } from "./ui/status-chip";
import { ResourceState } from "./sections";
import { runtime, upsState, upsTone } from "./ups";
import UpsControls from "./ups-controls";

const UpsCharts = lazy(() => import("./ups-charts"));
const ranges: UpsRange[] = ["1h", "24h", "7d", "30d", "365d"];
const date = (value: number | null | undefined) =>
  value == null ? "—" : new Date(value).toLocaleString();

function Settings({
  settings,
  saved,
  now,
}: {
  settings: UpsSettings;
  saved: () => void;
  now: number;
}) {
  const [rate, setRate] = useState(rateInput(settings.electricity_rate_micro_usd_per_kwh));
  const [installed, setInstalled] = useState(
    settings.battery_installed_ms == null
      ? ""
      : new Date(settings.battery_installed_ms).toISOString().slice(0, 10),
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="ups-settings"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setError("");
        let values: UpsSettings;
        try {
          const battery = installed === "" ? null : Date.parse(`${installed}T00:00:00Z`);
          if (
            battery !== null &&
            (!Number.isFinite(battery) || battery < 0 || battery > Date.now())
          )
            throw new Error("Enter a battery installation date between 1970 and today.");
          values = {
            electricity_rate_micro_usd_per_kwh: electricityRate(rate),
            battery_installed_ms: battery,
          };
        } catch (error) {
          setError(error instanceof Error ? error.message : "Invalid settings");
          return;
        }
        setSaving(true);
        void (async () => {
          try {
            const response = await fetch(apiUrl("/v1/settings/ups"), {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(values),
            });
            if (!response.ok) {
              const body = (await response.json()) as { error?: { message?: string } };
              throw new Error(body.error?.message ?? `HTTP ${response.status}`);
            }
            saved();
          } catch (error) {
            setError(error instanceof Error ? error.message : "Save failed");
          } finally {
            setSaving(false);
          }
        })();
      }}
    >
      <label htmlFor="ups-rate">Electricity rate · USD per kWh</label>
      <Input
        id="ups-rate"
        inputMode="decimal"
        value={rate}
        onChange={(event) => setRate(event.target.value)}
        aria-describedby="ups-settings-help ups-settings-error"
        aria-invalid={!!error}
      />
      <label htmlFor="ups-installed">Battery installed date</label>
      <Input
        id="ups-installed"
        type="date"
        value={installed}
        max={new Date(now).toISOString().slice(0, 10)}
        onChange={(event) => setInstalled(event.target.value)}
        aria-describedby="ups-settings-error"
        aria-invalid={!!error}
      />
      <p id="ups-settings-help" className="muted">
        Up to 6 decimals, $0–$10/kWh. Clear a field to unset it. Dates use UTC.
      </p>
      <div id="ups-settings-error">
        <ResourceState
          loading={false}
          error={error}
          title="Settings not saved"
          retry="Settings may not have been saved; select Save settings to try again."
        />
      </div>
      <Button type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save settings"}
      </Button>
    </form>
  );
}

function Energy({ range, revision }: { range: Exclude<UpsRange, "1h">; revision: number }) {
  const energy = useApi("/v1/ups/energy", `?range=${range}`, revision);
  const data = energy.data;
  return (
    <Tile className="ups-energy-period">
      <h3 className="eyebrow">{range}</h3>
      {!data ? (
        <ResourceState resource={energy} />
      ) : (
        <>
          <Stat
            label={null}
            value={data.energy_mwh / 1_000_000}
            format={(n) => (n == null ? "—" : n.toFixed(6))}
            suffix="kWh"
          />
          <p>
            {data.cost_nano_usd == null ? (
              <a href="#ups-settings">Set electricity rate</a>
            ) : (
              usd(data.cost_nano_usd / 1_000_000_000)
            )}
          </p>
          {data.gpu_energy_mwh != null && (
            <p className="muted">
              GPU {(data.gpu_energy_mwh / 1_000_000).toFixed(6)} kWh ·{" "}
              {data.energy_mwh > 0 ? number((data.gpu_energy_mwh / data.energy_mwh) * 100) : "—"}%
              share
            </p>
          )}
          <p className="muted">Coverage {data.coverage_percent.toFixed(4)}%</p>
        </>
      )}
    </Tile>
  );
}

function Timeline({ now, index }: { now: number; index: number }) {
  const [cursor, setCursor] = useState("");
  const events = useApi("/v1/ups/events", `?limit=20${cursor}`);
  return (
    <Panel
      title="Power events"
      subtitle="Outages, low battery and self-tests"
      icon={<History />}
      index={index}
      aria-label="Power events"
    >
      <ResourceState
        resource={events}
        empty={events.data?.events.length === 0 ? "No power events." : undefined}
      />
      <ol className="ups-events">
        {events.data?.events.map((event) => (
          <li key={event.id}>
            <div className="row">
              <StatusChip
                tone={
                  event.kind === "self_test" ? "neutral" : event.ended_ms == null ? "fail" : "warn"
                }
              >
                {event.kind.replaceAll("_", " ")}
              </StatusChip>
              <time className="muted" dateTime={new Date(event.started_ms).toISOString()}>
                {date(event.started_ms)}
              </time>
            </div>
            <p>
              Duration {ms(Math.max(0, (event.ended_ms ?? now) - event.started_ms))}
              {event.ended_ms == null ? " · ongoing" : ""} · Minimum charge{" "}
              {number(event.min_charge_percent)}% · Runtime{" "}
              {ms(event.min_runtime_s == null ? null : event.min_runtime_s * 1000)}
            </p>
            {event.detail && <p className="muted">{event.detail}</p>}
            {event.end_reason === "restart" && (
              <p className="status-warn">factory shut down during outage</p>
            )}
          </li>
        ))}
      </ol>
      <div className="row">
        {cursor && (
          <Button variant="outline" size="sm" onClick={() => setCursor("")}>
            Newest events
          </Button>
        )}
        {events.data?.next_before_ms != null && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setCursor(
                `&before_ms=${events.data!.next_before_ms}&before_id=${events.data!.next_before_id}`,
              )
            }
          >
            Older events
          </Button>
        )}
      </div>
    </Panel>
  );
}

export default function UpsPage({
  current,
  status = { loading: false, error: null },
  now,
  warnings,
  live,
  revision,
}: {
  current: UpsCurrent | null | undefined;
  /** The /v1/ups request: telemetry may also arrive over the stream. */
  status?: { loading: boolean; error: string | null } | undefined;
  now: number;
  warnings: string[];
  live: LiveState;
  revision: number;
}) {
  const [range, setRange] = useState<UpsRange>("24h");
  const [settingsRevision, setSettingsRevision] = useState(0);
  const settings = useApi("/v1/settings/ups", "", settingsRevision);
  const history = useApi("/v1/ups/history", `?range=${range}`, revision);
  const hourly = useApi("/v1/ups/history", "?range=365d", revision);
  const gpu = useApi(
    "/v1/gpu",
    `?range=${range === "1h" || range === "24h" ? range : "7d"}`,
    revision,
  );
  const [eventHistory, setEventHistory] = useState<{
    events: UpsEvent[];
    error: string;
    loading: boolean;
  }>({ events: [], error: "", loading: true });
  useEffect(() => {
    const controller = new AbortController();
    // Charts need outage markers beyond the visible timeline page; battery health
    // needs the latest self-test even when it predates the selected chart range.
    void (async () => {
      const events: UpsEvent[] = [];
      let cursor = "";
      const hours = { "1h": 1, "24h": 24, "7d": 168, "30d": 720, "365d": 8760 }[range];
      const since = Date.now() - hours * 3_600_000;
      try {
        do {
          const response = await fetch(apiUrl(`/v1/ups/events?limit=200${cursor}`), {
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Event history: HTTP ${response.status}`);
          const page = (await response.json()) as Endpoints["/v1/ups/events"];
          events.push(...page.events);
          if (
            page.next_before_ms == null ||
            (page.next_before_ms < since && events.some((event) => event.kind === "self_test"))
          )
            break;
          cursor = `&before_ms=${page.next_before_ms}&before_id=${page.next_before_id}`;
        } while (!controller.signal.aborted);
        if (!controller.signal.aborted) setEventHistory({ events, error: "", loading: false });
      } catch (error) {
        if (!controller.signal.aborted)
          setEventHistory({
            events: [],
            error: error instanceof Error ? error.message : "Event history failed",
            loading: false,
          });
      }
    })();
    return () => controller.abort();
  }, [range, revision]);
  const state = upsState({ current, now });
  const fresh = state === "No data" ? null : current!;
  const alarm = state === "On battery" || state === "Low battery";
  const elapsed = fresh ? Math.max(0, (now - fresh.ts_ms) / 1000) : 0;
  const shutdown = fresh?.runtime_s == null ? null : Math.max(0, fresh.runtime_s - elapsed - 300);
  const samples = live.upsSamples.filter((sample) => sample.ts_ms >= now - 900_000);
  const sparkMax = Math.max(1, ...samples.map((sample) => sample.load_w ?? 0));
  const spark = samples
    .map((sample, index) => {
      if (sample.load_w == null) return "";
      const previous = samples[index - 1];
      const command =
        previous?.load_w != null && sample.ts_ms - previous.ts_ms <= 30_000 ? "L" : "M";
      return `${command}${(100 * (sample.ts_ms - (now - 900_000))) / 900_000},${42 - (40 * sample.load_w) / sparkMax}`;
    })
    .join(" ");
  const selfTest = eventHistory.events.find((event) => event.kind === "self_test");
  const installed = settings.data?.battery_installed_ms;
  const replace = installed == null ? null : new Date(installed);
  replace?.setUTCFullYear(replace.getUTCFullYear() + 3);
  const trend =
    hourly.data?.filter(
      (point) =>
        point.load_w.avg != null &&
        point.load_w.avg >= 70 &&
        point.load_w.avg <= 110 &&
        point.runtime_s != null,
    ) ?? [];
  return (
    <main id="main" className="dashboard ups-page">
      <PageHeader eyebrow="Power" title="UPS · Power & battery" aside="factory-gpu, modem, eero" />
      <Panel
        title="Live"
        subtitle="Streamed every 15 s"
        icon={<Plug />}
        index={0}
        className="ups-live"
        tone={alarm ? "fail" : state === "Replace battery" ? "warn" : undefined}
        action={
          <StatusChip tone={upsTone(state)} dot={state !== "No data"} pulse={alarm}>
            {state}
          </StatusChip>
        }
        aria-label="Live UPS"
      >
        <ResourceState loading={status.loading} error={status.error} />
        <div className="ups-live-grid">
          <div>
            <Stat
              label="Charge"
              value={fresh?.charge_percent ?? null}
              format={(n) => `${number(n)}%`}
              tone={alarm ? "fail" : undefined}
              size="lg"
            />
            <MeterBar
              label="Charge"
              value={fresh?.charge_percent}
              tone={alarm ? "fail" : fresh ? "ok" : "muted"}
              markers={[
                ...(fresh?.charge_warning_percent == null
                  ? []
                  : [{ at: fresh.charge_warning_percent, label: "Warning" }]),
                ...(fresh?.charge_low_percent == null
                  ? []
                  : [{ at: fresh.charge_low_percent, label: "Low / shutdown" }]),
              ]}
            />
          </div>
          <Stat
            label={fresh?.on_battery ? "Until shutdown threshold" : "Runtime"}
            value={
              fresh?.on_battery
                ? fresh.charge_percent != null && fresh.charge_percent <= 30
                  ? "0 s"
                  : shutdown == null
                    ? "—"
                    : `${Math.floor(shutdown)} s`
                : runtime(fresh?.runtime_s)
            }
            tone={alarm ? "fail" : undefined}
            size="lg"
          />
          <Stat
            label="Load"
            value={`${number(fresh?.load_w)} W`}
            note={`${number(fresh?.load_percent)}% of ${number(fresh?.load_nominal_w)} W`}
            size="lg"
          />
          <Stat
            label="Input"
            value={`${number(fresh?.input_v)} V`}
            note={`Output ${number(fresh?.output_v)} V · Battery ${number(fresh?.battery_v)} V`}
            size="lg"
          />
        </div>
        <div className="ups-spark">
          <span className="muted">Load · last 15 min (live) · 0–{number(sparkMax)} W</span>
          <svg
            viewBox="0 0 100 44"
            preserveAspectRatio="none"
            role="img"
            aria-label="15-minute live load sparkline"
          >
            <defs>
              <linearGradient id="ups-spark-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent-text)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--accent-text)" stopOpacity={0} />
              </linearGradient>
            </defs>
            {spark && <path d={`${spark} V44 H0 Z`} fill="url(#ups-spark-fill)" stroke="none" />}
            <path
              d={spark}
              fill="none"
              stroke="var(--accent-text)"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {!samples.length && <span className="muted">Waiting for live samples</span>}
        </div>
        {fresh?.on_battery && (
          <p className="status-warn ups-live-note">
            Shutdown at 30% charge or 300 s runtime, whichever comes first. Charge{" "}
            {number(fresh.charge_percent)}%; time shown subtracts the 300 s reserve.
          </p>
        )}
        {state === "No data" &&
          warnings.map((warning) => (
            <p key={warning} className="status-warn ups-live-note">
              {warning}
            </p>
          ))}
      </Panel>
      <section aria-label="UPS history" className="ups-history">
        <div className="row section-head">
          <h3>History</h3>
          <RangeToggle value={range} options={ranges} onChange={setRange} label="History range" />
        </div>
        <ResourceState resource={history} title="Unable to load history" />
        <ResourceState loading={false} error={gpu.error} title="GPU overlay unavailable" />
        {!history.loading && (
          <Suspense fallback={<ResourceState loading error={null} />}>
            <UpsCharts
              history={history.data ?? []}
              gpu={gpu.data?.history ?? []}
              events={eventHistory.events}
              now={now}
            />
          </Suspense>
        )}
      </section>
      <div className="ups-chart-grid">
        <Timeline key={revision} now={now} index={2} />
        <Panel
          title="Battery health"
          subtitle="Self-test, age and runtime trend"
          icon={<BatteryCharging />}
          index={3}
          aria-label="Battery health"
        >
          <ResourceState
            loading={eventHistory.loading}
            error={eventHistory.error}
            title="Unable to load the self-test history"
          />
          <KeyValue
            rows={[
              [
                "Last self-test",
                `${selfTest?.detail ?? fresh?.test_result ?? "—"} · ${
                  eventHistory.loading || eventHistory.error
                    ? "—"
                    : selfTest
                      ? date(selfTest.started_ms)
                      : "Date not recorded"
                }`,
              ],
              [
                "Battery age",
                installed == null
                  ? "Set installation date below"
                  : `${number(Math.max(0, now - installed) / 86_400_000)} days`,
              ],
              [
                "Replace by",
                `${replace ? replace.toLocaleDateString(undefined, { timeZone: "UTC" }) : "—"} · estimate (installed date + 3 years)`,
              ],
            ]}
          />
          <h4>Minimum runtime trend · hourly, 70–110 W average load</h4>
          {hourly.loading || hourly.error ? (
            <ResourceState resource={hourly} />
          ) : trend.length ? (
            <div className="ups-trend" tabIndex={0} role="region" aria-label="Hourly runtime trend">
              <table>
                <thead>
                  <tr>
                    <th>Hour</th>
                    <th>Load W</th>
                    <th>Minimum runtime</th>
                  </tr>
                </thead>
                <tbody>
                  {trend.map((point) => (
                    <tr key={point.ts_ms}>
                      <td>{date(point.ts_ms)}</td>
                      <td>{number(point.load_w.avg)}</td>
                      <td>{ms(point.runtime_s! * 1000)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty">No hourly samples at the reference load in the last year.</p>
          )}
        </Panel>
        <Panel
          title="Energy & cost"
          subtitle="Measured energy only; gaps are not extrapolated."
          icon={<Zap />}
          index={4}
          aria-label="Energy"
        >
          <div className="ups-energy">
            {(["24h", "7d", "30d", "365d"] as const).map((value) => (
              <Energy key={value} range={value} revision={revision + settingsRevision} />
            ))}
          </div>
        </Panel>
        <Panel
          id="ups-settings"
          title="UPS settings"
          subtitle="Electricity rate and battery date"
          icon={<Settings2 />}
          index={5}
          aria-label="UPS settings"
        >
          {settings.data ? (
            <Settings
              settings={settings.data}
              now={now}
              saved={() => setSettingsRevision((value) => value + 1)}
            />
          ) : (
            <ResourceState resource={settings} />
          )}
          {settingsRevision > 0 && (
            <p role="status" className="status-ok">
              Settings saved.
            </p>
          )}
        </Panel>
        <UpsControls />
      </div>
    </main>
  );
}
