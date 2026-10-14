import { lazy, Suspense, useEffect, useState } from "react";
import { apiUrl, useApi } from "../api/client";
import type { LiveState } from "../api/stream";
import type { Endpoints, UpsCurrent, UpsEvent, UpsRange, UpsSettings } from "../api/types";
import { ms, number, usd } from "../lib/format";
import { electricityRate, rateInput } from "../lib/ups";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
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
      <input
        id="ups-rate"
        inputMode="decimal"
        value={rate}
        onChange={(event) => setRate(event.target.value)}
        aria-describedby="ups-settings-help ups-settings-error"
        aria-invalid={!!error}
      />
      <label htmlFor="ups-installed">Battery installed date</label>
      <input
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
      <p id="ups-settings-error" role={error ? "alert" : undefined} className="status-fail">
        {error}
      </p>
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
    <article className="ups-energy-period">
      <h3>{range}</h3>
      {energy.error ? (
        <p role="alert">{energy.error}</p>
      ) : !data ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <strong>{(data.energy_mwh / 1_000_000).toFixed(6)} kWh</strong>
          <p>
            {data.cost_nano_usd == null ? (
              <a href="#ups-settings">Set electricity rate</a>
            ) : (
              usd(data.cost_nano_usd / 1_000_000_000)
            )}
          </p>
          {data.gpu_energy_mwh != null && (
            <p>
              GPU {(data.gpu_energy_mwh / 1_000_000).toFixed(6)} kWh ·{" "}
              {data.energy_mwh > 0 ? number((data.gpu_energy_mwh / data.energy_mwh) * 100) : "—"}%
              share
            </p>
          )}
          <p className="muted">Coverage {data.coverage_percent.toFixed(4)}%</p>
        </>
      )}
    </article>
  );
}

function Timeline({ now }: { now: number }) {
  const [cursor, setCursor] = useState("");
  const events = useApi("/v1/ups/events", `?limit=20${cursor}`);
  return (
    <section className="ups-panel" aria-label="Power events">
      <h3>Power events</h3>
      {events.error && <p role="alert">{events.error}</p>}
      {events.loading && <p className="muted">Loading events…</p>}
      {events.data?.events.length === 0 && <p className="muted">No power events.</p>}
      <ol className="ups-events">
        {events.data?.events.map((event) => (
          <li key={event.id}>
            <div className="row">
              <strong>{event.kind.replaceAll("_", " ")}</strong>
              <time dateTime={new Date(event.started_ms).toISOString()}>
                {date(event.started_ms)}
              </time>
            </div>
            <p>
              Duration {ms(Math.max(0, (event.ended_ms ?? now) - event.started_ms))}
              {event.ended_ms == null ? " · ongoing" : ""} · Minimum charge{" "}
              {number(event.min_charge_percent)}% · Runtime{" "}
              {ms(event.min_runtime_s == null ? null : event.min_runtime_s * 1000)}
            </p>
            {event.detail && <p>{event.detail}</p>}
            {event.end_reason === "restart" && (
              <p className="status-warn">factory shut down during outage</p>
            )}
          </li>
        ))}
      </ol>
      <div className="row">
        {cursor && <Button onClick={() => setCursor("")}>Newest events</Button>}
        {events.data?.next_before_ms != null && (
          <Button
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
    </section>
  );
}

export default function UpsPage({
  current,
  now,
  warnings,
  live,
  revision,
}: {
  current: UpsCurrent | null | undefined;
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
  const fresh = current && now - current.ts_ms <= 30_000 ? current : null;
  const state = !fresh
    ? "No data"
    : fresh.low_battery
      ? "Low battery"
      : fresh.on_battery
        ? "On battery"
        : fresh.replace_battery
          ? "Replace battery"
          : fresh.on_line
            ? "Online"
            : "No data";
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
      <div className="intro">
        <div>
          <a href="/">Back to dashboard</a>
          <h2>UPS · Power & battery</h2>
        </div>
        <p className="muted">factory-gpu, modem, eero</p>
      </div>
      <section className="ups-panel ups-live" aria-label="Live UPS">
        <Badge
          variant="outline"
          className={fresh?.on_battery ? "status-warn" : fresh ? "status-ok" : "muted"}
        >
          {state}
        </Badge>
        <div>
          <span className="muted">Charge</span>
          <strong>{number(fresh?.charge_percent)}%</strong>
        </div>
        <div>
          <span className="muted">
            {fresh?.on_battery ? "Until shutdown threshold" : "Runtime"}
          </span>
          <strong className={fresh?.on_battery ? "status-warn" : ""}>
            {fresh?.on_battery
              ? fresh.charge_percent != null && fresh.charge_percent <= 30
                ? "0 s"
                : shutdown == null
                  ? "—"
                  : `${Math.floor(shutdown)} s`
              : ms(fresh?.runtime_s == null ? null : fresh.runtime_s * 1000)}
          </strong>
        </div>
        <div>
          <span className="muted">Load</span>
          <strong>{number(fresh?.load_w)} W</strong>
        </div>
        <div>
          <span className="muted">Input</span>
          <strong>{number(fresh?.input_v)} V</strong>
        </div>
        <div className="ups-spark">
          <span className="muted">Load · last 15 min (SSE) · 0–{number(sparkMax)} W</span>
          <svg
            viewBox="0 0 100 44"
            preserveAspectRatio="none"
            role="img"
            aria-label="15-minute live load sparkline"
          >
            <path d={spark} fill="none" stroke="var(--accent-text)" strokeWidth="1" />
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
      </section>
      <section aria-label="UPS history">
        <div className="row ups-range">
          <h3>History</h3>
          <div role="group" aria-label="History range">
            {ranges.map((value) => (
              <Button
                key={value}
                variant={range === value ? "default" : "outline"}
                aria-pressed={range === value}
                onClick={() => setRange(value)}
              >
                {value}
              </Button>
            ))}
          </div>
        </div>
        {history.error && <p role="alert">History: {history.error}</p>}
        {gpu.error && <p role="alert">GPU overlay unavailable: {gpu.error}</p>}
        {history.loading ? (
          <p className="muted">Loading history…</p>
        ) : (
          <Suspense fallback={<p className="muted">Loading charts…</p>}>
            <UpsCharts
              history={history.data ?? []}
              gpu={gpu.data?.history ?? []}
              events={eventHistory.events}
              now={now}
            />
          </Suspense>
        )}
      </section>
      <section className="ups-panel" aria-label="Energy">
        <h3>Energy & cost</h3>
        <p className="muted">Measured energy only; gaps are not extrapolated.</p>
        <div className="ups-energy">
          {(["24h", "7d", "30d", "365d"] as const).map((value) => (
            <Energy key={value} range={value} revision={revision + settingsRevision} />
          ))}
        </div>
      </section>
      <div className="ups-chart-grid">
        <Timeline key={revision} now={now} />
        <section className="ups-panel" aria-label="Battery health">
          <h3>Battery health</h3>
          <p>
            Last self-test: {selfTest?.detail ?? fresh?.test_result ?? "—"} ·{" "}
            {eventHistory.loading
              ? "Loading test date…"
              : selfTest
                ? date(selfTest.started_ms)
                : "Date not recorded"}
          </p>
          {eventHistory.error && <p role="alert">{eventHistory.error}</p>}
          <p>
            Battery age:{" "}
            {installed == null
              ? "Set installation date below"
              : `${number(Math.max(0, now - installed) / 86_400_000)} days`}
          </p>
          <p>
            Replace by: {replace ? replace.toLocaleDateString(undefined, { timeZone: "UTC" }) : "—"}{" "}
            · estimate (installed date + 3 years)
          </p>
          <h4>Minimum runtime trend · hourly, 70–110 W average load</h4>
          {hourly.error && <p role="alert">{hourly.error}</p>}
          {hourly.loading ? (
            <p className="muted">Loading hourly history…</p>
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
            <p className="muted">No hourly samples at the reference load in the last year.</p>
          )}
        </section>
        <section id="ups-settings" className="ups-panel" aria-label="UPS settings">
          <h3>UPS settings</h3>
          {settings.error && <p role="alert">{settings.error}</p>}
          {settings.data ? (
            <Settings
              settings={settings.data}
              now={now}
              saved={() => setSettingsRevision((value) => value + 1)}
            />
          ) : (
            <p className="muted">Loading settings…</p>
          )}
          {settingsRevision > 0 && <p role="status">Settings saved.</p>}
        </section>
        <UpsControls />
      </div>
    </main>
  );
}
