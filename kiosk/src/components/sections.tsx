import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowUpRight, Radio, RefreshCw } from "lucide-react";
import type { Resource } from "../api/client";
import { useAgentsRefresh } from "../api/agents-refresh";
import type { LiveState } from "../api/stream";
import type {
  Agents,
  DeviceList,
  Fleet,
  Gpu,
  GpuSample,
  Usage,
  Pricing,
  UsageRange,
  GpuRange,
} from "../api/types";
import { count, ms, number, seen, time, usd } from "../lib/format";
import { Panel, Tile } from "./ui/panel";
import { Stat, StatGrid } from "./ui/stat";
import { StatusChip, StatusText } from "./ui/status-chip";
import { MeterBar } from "./ui/meter-bar";
import { RangeToggle } from "./ui/range-toggle";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Skeleton } from "./ui/skeleton";
import { Button } from "./ui/button";

const GpuChart = lazy(() => import("./gpu-chart"));

export function ResourceState({
  resource,
  empty,
}: {
  resource: Resource<unknown>;
  empty?: string | undefined;
}) {
  if (resource.loading)
    return (
      <div aria-label="Loading section" className="loading">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  if (resource.error)
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>Unable to load this section</AlertTitle>
        <AlertDescription>{resource.error}. Retrying on the next refresh.</AlertDescription>
      </Alert>
    );
  return empty ? <p className="empty">{empty}</p> : null;
}
export function Warnings({ warnings }: { warnings: string[] }) {
  return warnings.length ? (
    <ul className="warnings">
      {warnings.map((warning) => (
        <li key={warning}>
          <AlertTriangle aria-hidden="true" size={14} />
          <span>{warning}</span>
        </li>
      ))}
    </ul>
  ) : null;
}
const healthTone = (health: DeviceList["devices"][number]["health"]) =>
  health === "critical"
    ? "fail"
    : health === "warning" || health === "stale"
      ? "warn"
      : health === "healthy"
        ? "ok"
        : "neutral";

/** Nodes with a device page (matched by name) render as links to their host health page. */
export function FleetSection({
  resource,
  devices = [],
  icon,
  index,
}: {
  resource: Resource<Fleet>;
  devices?: DeviceList["devices"] | undefined;
  icon: ReactNode;
  index?: number;
}) {
  const data = resource.data;
  const online = data?.nodes.filter((node) => node.online).length ?? 0;
  return (
    <Panel
      title="Fleet"
      subtitle="Nodes & service health"
      icon={icon}
      className="fleet"
      index={index}
      action={
        data ? (
          <StatusChip tone={online === data.nodes.length ? "ok" : "warn"}>
            {online} / {data.nodes.length} online
          </StatusChip>
        ) : null
      }
    >
      <ResourceState
        resource={resource}
        empty={data?.nodes.length === 0 ? "No fleet nodes configured." : undefined}
      />
      <div className="node-grid">
        {data?.nodes.map((node) => {
          const device = devices.find((item) => item.device_id === node.name);
          const tone = node.online ? undefined : "fail";
          const body = (
            <>
              <div className="row">
                <h3>
                  {node.name}
                  {device && (
                    <ArrowUpRight aria-hidden="true" size={14} className="tile-link-hint" />
                  )}
                </h3>
                <span className="row chips">
                  {device && (
                    <StatusChip tone={healthTone(device.health)}>
                      Host health{device.health === "unknown" ? "" : ` · ${device.health}`}
                    </StatusChip>
                  )}
                  <StatusChip tone={node.online ? "ok" : "fail"} dot>
                    {node.online ? "Online" : "Offline"}
                  </StatusChip>
                </span>
              </div>
              <p className="muted node-meta">
                {node.tailscale_ip ?? "—"} · {node.os ?? "—"} · seen{" "}
                {node.online && node.last_seen_ms == null ? "now" : seen(node.last_seen_ms)}
              </p>
              <div className="divider" />
              {node.services.length === 0 ? (
                <p className="muted">No services reported.</p>
              ) : (
                <ul className="services">
                  {node.services.map((service) => (
                    <li key={service.name}>
                      <div className="row">
                        <span title={service.git_sha ?? undefined}>
                          {service.name}
                          {service.version ? ` v${service.version}` : ""}
                        </span>
                        <StatusText tone={service.ok ? "ok" : "fail"} className="service-state">
                          {service.ok ? "OK" : "Failing"} · {ms(service.latency_ms)}
                        </StatusText>
                      </div>
                      {!service.ok && <p className="muted">{service.detail ?? "—"}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          );
          return device ? (
            <a key={node.name} href={device.href} className="tile-link">
              <Tile tone={tone}>{body}</Tile>
            </a>
          ) : (
            <Tile key={node.name} tone={tone}>
              {body}
            </Tile>
          );
        })}
        {/* Devices without a matching fleet node still need a way into their host page. */}
        {data &&
          devices
            .filter((device) => !data.nodes.some((node) => node.name === device.device_id))
            .map((device) => (
              <a key={device.device_id} href={device.href} className="tile-link">
                <Tile>
                  <div className="row">
                    <h3>
                      {device.device_id}
                      <ArrowUpRight aria-hidden="true" size={14} className="tile-link-hint" />
                    </h3>
                    <StatusChip tone={healthTone(device.health)}>
                      Host health{device.health === "unknown" ? "" : ` · ${device.health}`}
                    </StatusChip>
                  </div>
                  <p className="muted node-meta">Device collector only · not a fleet node</p>
                </Tile>
              </a>
            ))}
      </div>
    </Panel>
  );
}
export function GpuSection({
  resource,
  live,
  range,
  setRange,
  icon,
  index,
}: {
  resource: Resource<Gpu>;
  live: GpuSample | null | undefined;
  range: GpuRange;
  setRange: (range: GpuRange) => void;
  icon: ReactNode;
  index?: number;
}) {
  const data = resource.data;
  const current = live === undefined ? data?.current : live;
  return (
    <Panel
      title="GPU"
      subtitle="Live telemetry · utilization history"
      icon={icon}
      className="gpu"
      index={index}
      action={
        <RangeToggle
          value={range}
          options={["1h", "24h", "7d"] as const}
          onChange={setRange}
          label="GPU history range"
        />
      }
    >
      <ResourceState resource={resource} />
      {!resource.loading && (
        <>
          <StatGrid columns={2}>
            <Stat
              label="Memory"
              value={current ? current.memory_used_mib / 1024 : null}
              format={(n) => number(n, "GiB")}
              note={
                current
                  ? `of ${number(current.memory_total_mib / 1024, "GiB")}`
                  : "Telemetry unavailable"
              }
            />
            <Stat
              label="Utilization"
              value={current?.utilization_percent ?? null}
              format={(n) => number(n, "%")}
              tone="accent"
              className="fk-hero"
            />
            <Stat
              label="Temperature"
              value={current?.temperature_c ?? null}
              format={(n) => number(n, "°C")}
            />
            <Stat label="Power" value={current?.power_w ?? null} format={(n) => number(n, "W")} />
          </StatGrid>
          {data && data.history.length > 0 ? (
            <Suspense
              fallback={<Skeleton className="trend-chart" aria-label="Loading GPU chart" />}
            >
              <GpuChart history={data.history} />
            </Suspense>
          ) : (
            <p className="empty">No GPU history available.</p>
          )}
          <p className="muted loaded-models">
            Loaded: {data?.loaded_models.length ? data.loaded_models.join(" · ") : "—"}
          </p>
        </>
      )}
    </Panel>
  );
}
export function UsageSection({
  resource,
  pricing,
  range,
  icon,
  index,
}: {
  resource: Resource<Usage>;
  pricing: Resource<Pricing>;
  range: UsageRange;
  icon: ReactNode;
  index?: number;
}) {
  const data = resource.data;
  // Pending pricing is a pricing state; while this section itself errors, the alert speaks alone.
  const pending = resource.error
    ? []
    : (pricing.data?.families.filter((family) => family.pending) ?? []);
  const warnings = [...(data?.warnings ?? []), ...(pricing.data?.warnings ?? [])];
  return (
    <a
      href="/llm"
      className="panel-link usage"
      aria-label="Local LLM usage, pricing and model details"
    >
      <Panel
        title="Local LLM"
        subtitle={`Usage & spend avoided · ${range}`}
        icon={icon}
        index={index}
        tone={pending.length ? "warn" : undefined}
        action={
          <StatusChip tone={pending.length ? "warn" : "neutral"} dot={pending.length > 0}>
            {pending.length ? "Pricing update pending" : "Details"}
            <ArrowUpRight aria-hidden="true" size={14} />
          </StatusChip>
        }
      >
        <ResourceState resource={resource} />
        {data && (
          <StatGrid columns={3}>
            <Stat label="Requests" value={data.totals.requests} format={count} size="lg" />
            <Stat label="Tokens in" value={data.totals.prompt_tokens} format={count} size="lg" />
            <Stat label="Tokens out" value={data.totals.output_tokens} format={count} size="lg" />
            {data.spend_avoided.map((family) => (
              <Stat
                key={family.family}
                label={`${family.family} avoided`}
                value={family.usd}
                format={usd}
                suffix={
                  family.estimated_usd > 0 ? `+ ${usd(family.estimated_usd)} est.` : undefined
                }
              />
            ))}
          </StatGrid>
        )}
        <Warnings warnings={warnings} />
      </Panel>
    </a>
  );
}
function balanceText(balance: Agents["tools"][number]["balances"][number]) {
  const format = (value: string | null | undefined) => {
    if (value == null) return "—";
    const amount = Number(value);
    if (!Number.isFinite(amount)) return "—";
    return `${balance.unit === "usd" ? "$" : ""}${new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 2,
    }).format(amount)}`;
  };
  const unit =
    balance.unit === "usd"
      ? ""
      : balance.unit === "orb_hours"
        ? " orb hours"
        : balance.unit === "codex_credits"
          ? " Codex credits"
          : ` ${balance.unit}`;
  return `${balance.label ? `${balance.label}: ` : ""}${format(balance.remaining)}${balance.total == null ? "" : ` of ${format(balance.total)}`}${unit}`;
}
export function AgentsSection({
  resource,
  icon,
  revision = 0,
  index,
}: {
  resource: Resource<Agents>;
  icon: ReactNode;
  revision?: number;
  index?: number;
}) {
  const [now, setNow] = useState(Date.now);
  const observations = resource.data?.tools.flatMap((tool) =>
    tool.observed_at_ms == null ? [] : [tool.observed_at_ms],
  );
  const refresh = useAgentsRefresh(
    revision,
    now,
    observations?.length ? Math.max(...observations) : null,
  );
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("pageshow", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("pageshow", tick);
    };
  }, []);
  return (
    <Panel
      title="Frontier CLIs"
      subtitle="Account capacity, not local usage"
      icon={icon}
      index={index}
      action={
        <div className="agent-refresh">
          <span
            role="status"
            aria-live="polite"
            className={
              refresh.message?.includes("fail") || refresh.message?.includes("didn't")
                ? "status-warn"
                : "muted"
            }
          >
            {refresh.message}
            {refresh.countdown && <span className="muted block">{refresh.countdown}</span>}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="accent-text disabled:bg-transparent disabled:text-muted-foreground disabled:pointer-events-auto"
            aria-label="Refresh usage"
            title={refresh.seconds > 0 ? `Next refresh in ${refresh.seconds} s` : "Refresh usage"}
            disabled={refresh.refreshing || refresh.seconds > 0}
            onClick={() => void refresh.refresh()}
          >
            <RefreshCw aria-hidden="true" className={refresh.refreshing ? "animate-spin" : ""} />
          </Button>
        </div>
      }
    >
      <ResourceState
        resource={resource}
        empty={resource.data?.tools.length === 0 ? "No frontier tools configured." : undefined}
      />
      <ul className="agent-list">
        {resource.data?.tools.length
          ? [
              ["amp", "Amp"],
              ["cursor", "Cursor"],
              ["claude-code", "Claude Code"],
              ["codex", "ChatGPT"],
              ["kimi", "Kimi"],
              ["opencode", "OpenCode"],
            ].map(([id, label]) => {
              const tool = resource.data?.tools.find((tool) => tool.tool === id);
              const status = tool?.status ?? "unknown";
              const known = status === "ok" || status === "stale";
              const observed =
                tool?.observed_at_ms == null
                  ? "observed —"
                  : `observed ${Math.max(0, Math.floor((now - tool.observed_at_ms) / 60_000))} min ago`;
              return (
                <li key={id} tabIndex={0} aria-label={label}>
                  <div className="row agent-heading">
                    <h3
                      title={
                        [tool?.source, tool?.cli_version].filter(Boolean).join(" · ") || undefined
                      }
                    >
                      {label}
                    </h3>
                    <span className="muted">Plan: {known ? (tool?.plan ?? "—") : "—"}</span>
                    <p className={status === "ok" ? "muted" : "status-warn agent-status"}>
                      {known
                        ? `${status === "stale" ? "stale · " : ""}${observed}`
                        : status === "not_tracked"
                          ? "not tracked"
                          : "unknown"}
                    </p>
                  </div>
                  {status !== "ok" && (
                    <p className="status-warn agent-status">
                      {tool?.reason ?? "—"}
                      {tool?.cli_version ? ` (${id} ${tool.cli_version})` : ""}
                    </p>
                  )}
                  {known ? (
                    <div
                      className={status === "stale" ? "agent-values agent-stale" : "agent-values"}
                    >
                      {tool?.windows.length ? (
                        tool.windows.map((window) => (
                          <div className="agent-window" key={window.name}>
                            <span>{window.name.replaceAll("_", " ")}</span>
                            <MeterBar
                              label={`${label} ${window.name} used`}
                              value={window.used_percent}
                              tone={
                                status === "stale"
                                  ? "muted"
                                  : window.used_percent >= 90
                                    ? "fail"
                                    : window.used_percent >= 75
                                      ? "warn"
                                      : "accent"
                              }
                            />
                            <span>{number(window.used_percent)}% used</span>
                            <span
                              className="muted"
                              title={
                                window.resets_at_ms == null
                                  ? undefined
                                  : new Date(window.resets_at_ms).toISOString()
                              }
                            >
                              resets in{" "}
                              {window.resets_at_ms == null
                                ? "—"
                                : ms(Math.max(0, window.resets_at_ms - now))}
                            </span>
                          </div>
                        ))
                      ) : (
                        <p className="muted">Windows: —</p>
                      )}
                      <p className="agent-balances">
                        {tool?.balances.length
                          ? tool.balances.map(balanceText).join(" · ")
                          : tool?.balance
                            ? balanceText(tool.balance)
                            : "Balance: —"}
                      </p>
                    </div>
                  ) : null}
                </li>
              );
            })
          : null}
      </ul>
    </Panel>
  );
}
export function TickerSection({
  requests,
  connected,
  index,
}: {
  requests: LiveState["requests"];
  connected: boolean;
  index?: number;
}) {
  // Rows that arrive after mount slide in once; the keys stay stable across arrivals so the
  // existing rows keep still instead of remounting. The list is newest first, and it is empty
  // on a normal load, so an empty mount means every later row is new.
  const [since] = useState(() => requests[0]?.ts_ms ?? -Infinity);
  const keys = requests.map(
    (event, index) =>
      `${event.ts_ms}-${requests.slice(0, index).filter((prior) => prior.ts_ms === event.ts_ms).length}`,
  );
  return (
    <Panel
      title="Live requests"
      subtitle="Most recent completions"
      icon={<Radio />}
      index={index}
      action={<span className="muted">{requests.length} recent</span>}
    >
      <div
        aria-live="polite"
        aria-relevant="additions"
        role="log"
        aria-label="Recent LLM requests"
        tabIndex={0}
      >
        {requests.length === 0 ? (
          <p className="empty">
            {connected
              ? "Waiting for the first request."
              : "Stream reconnecting. Requests will appear here."}
          </p>
        ) : (
          <ul className="ticker">
            {requests.map((event, index) => (
              <li key={keys[index]} className={event.ts_ms > since ? "fk-new" : undefined}>
                <div className="row">
                  <h3>{event.data.model ?? "Non-model request"}</h3>
                  <span className="muted">{time(event.ts_ms)}</span>
                </div>
                <p>
                  {count(event.data.prompt_tokens)} in · {count(event.data.output_tokens)} out
                  <span className="muted"> · {ms(event.data.latency_ms)}</span>
                </p>
                <p className="muted">{event.data.client_hostname}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
