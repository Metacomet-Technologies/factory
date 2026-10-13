import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowUpRight, Radio, RefreshCw } from "lucide-react";
import type { Resource } from "../api/client";
import { useAgentsRefresh } from "../api/agents-refresh";
import type { LiveState } from "../api/stream";
import type {
  Agents,
  Fleet,
  Gpu,
  GpuSample,
  Usage,
  Pricing,
  UsageRange,
  GpuRange,
  ModelUsage,
} from "../api/types";
import { count, ms, number, seen, time, usd } from "../lib/format";
import { Card, CardContent, CardHeader } from "./ui/card";
import { Badge } from "./ui/badge";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Skeleton } from "./ui/skeleton";
import { Separator } from "./ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { Button } from "./ui/button";

const GpuChart = lazy(() => import("./gpu-chart"));

function Section({
  title,
  subtitle,
  icon,
  action,
  className = "",
  children,
}: {
  title: string;
  subtitle: string;
  icon: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={className} aria-label={title}>
      <Card>
        <CardHeader>
          <div className="section-heading">
            <div className="section-title">
              {icon}
              <h2>{title}</h2>
            </div>
            {action}
          </div>
          <p className="muted">{subtitle}</p>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </section>
  );
}
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
function Warnings({ warnings }: { warnings: string[] }) {
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
export function FleetSection({ resource, icon }: { resource: Resource<Fleet>; icon: ReactNode }) {
  const data = resource.data;
  return (
    <Section
      title="Fleet"
      subtitle="Nodes & service health"
      icon={icon}
      className="fleet"
      action={
        data ? (
          <Badge variant="outline">
            {data.nodes.filter((node) => node.online).length} / {data.nodes.length} online
          </Badge>
        ) : null
      }
    >
      <ResourceState
        resource={resource}
        empty={data?.nodes.length === 0 ? "No fleet nodes configured." : undefined}
      />
      <div className="node-grid">
        {data?.nodes.map((node) => (
          <article className="node" key={node.name}>
            <div className="row">
              <h3>{node.name}</h3>
              <Badge variant="outline" className={node.online ? "status-ok" : "status-fail"}>
                {node.online ? "Online" : "Offline"}
              </Badge>
            </div>
            <p className="muted node-meta">
              {node.tailscale_ip ?? "—"} · {node.os ?? "—"}
            </p>
            <p className="muted">
              Last seen {node.online && node.last_seen_ms == null ? "now" : seen(node.last_seen_ms)}
            </p>
            <Separator className="my-3" />
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
                      <span className={service.ok ? "status-ok" : "status-fail"}>
                        {service.ok ? "OK" : "Failing"} · {ms(service.latency_ms)}
                      </span>
                    </div>
                    {!service.ok && <p className="muted">{service.detail ?? "—"}</p>}
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </div>
    </Section>
  );
}
function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="metric">
      <p className="muted">{label}</p>
      <p className="metric-value">{value}</p>
      {note && <p className="muted">{note}</p>}
    </div>
  );
}
export function GpuSection({
  resource,
  live,
  range,
  setRange,
  icon,
}: {
  resource: Resource<Gpu>;
  live: GpuSample | null | undefined;
  range: GpuRange;
  setRange: (range: GpuRange) => void;
  icon: ReactNode;
}) {
  const data = resource.data;
  const current = live === undefined ? data?.current : live;
  return (
    <Section
      title="GPU"
      subtitle="Live telemetry · utilization history"
      icon={icon}
      className="gpu"
      action={
        <ToggleGroup
          value={[range]}
          onValueChange={(values) => {
            const value = values[0];
            if (value === "1h" || value === "24h" || value === "7d") setRange(value);
          }}
          aria-label="GPU history range"
          size="sm"
        >
          {["1h", "24h", "7d"].map((value) => (
            <ToggleGroupItem key={value} value={value}>
              {value}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      }
    >
      <ResourceState resource={resource} />
      {!resource.loading && (
        <>
          <div className="gpu-metrics">
            <Metric
              label="Memory"
              value={number(current ? current.memory_used_mib / 1024 : null, "GiB")}
              note={
                current
                  ? `of ${number(current.memory_total_mib / 1024, "GiB")}`
                  : "Telemetry unavailable"
              }
            />
            <Metric label="Utilization" value={number(current?.utilization_percent ?? null, "%")} />
            <Metric label="Temperature" value={number(current?.temperature_c ?? null, "°C")} />
            <Metric label="Power" value={number(current?.power_w ?? null, "W")} />
          </div>
          {data && data.history.length > 0 ? (
            <Suspense fallback={<Skeleton className="gpu-chart" aria-label="Loading GPU chart" />}>
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
    </Section>
  );
}
function ModelCards({ models }: { models: ModelUsage[] }) {
  return (
    <div className="model-cards">
      {models.map((model) => (
        <article className="model-card" key={model.model ?? "non-model"}>
          <h3>{model.model ?? "Non-model requests"}</h3>
          <dl>
            {[
              ["Requests", count(model.requests)],
              ["Tokens in / out", `${count(model.prompt_tokens)} / ${count(model.output_tokens)}`],
              [
                "Prompt / generation tps",
                `${number(model.avg_prompt_tps)} / ${number(model.avg_gen_tps)}`,
              ],
              ["Latency p50 / p95", `${ms(model.p50_latency_ms)} / ${ms(model.p95_latency_ms)}`],
              ["Total load time", ms(model.total_load_ms)],
            ].map(([label, value]) => (
              <div className="row" key={label}>
                <dt className="muted">{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </article>
      ))}
    </div>
  );
}
export function UsageSection({
  resource,
  pricing,
  range,
  setRange,
  icon,
}: {
  resource: Resource<Usage>;
  pricing: Resource<Pricing>;
  range: UsageRange;
  setRange: (range: UsageRange) => void;
  icon: ReactNode;
}) {
  const data = resource.data;
  return (
    <Section
      title="Local LLM"
      subtitle="Usage, performance & spend avoided"
      icon={icon}
      className="usage"
      action={
        <ToggleGroup
          value={[range]}
          onValueChange={(values) => {
            const value = values[0];
            if (value === "24h" || value === "7d" || value === "30d") setRange(value);
          }}
          aria-label="Usage range"
          size="sm"
        >
          {["24h", "7d", "30d"].map((value) => (
            <ToggleGroupItem key={value} value={value}>
              {value}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      }
    >
      <ResourceState resource={resource} />
      {data && (
        <>
          <div className="usage-metrics">
            <Metric label="Requests" value={count(data.totals.requests)} />
            <Metric label="Tokens in" value={count(data.totals.prompt_tokens)} />
            <Metric label="Tokens out" value={count(data.totals.output_tokens)} />
          </div>
          <Separator className="my-6" />
          <div className="row">
            <h3>Spend avoided</h3>
            <span className="muted">Reference pricing · USD</span>
          </div>
          <div className="spend-grid">
            {data.spend_avoided.map((family) => (
              <article key={family.family} className="spend-card">
                <div className="row">
                  <h4>{family.family}</h4>
                  <ArrowUpRight aria-hidden="true" size={16} className="accent-text" />
                </div>
                <p className="spend-value">
                  {usd(family.usd)} <span className="muted">priced</span>
                </p>
                {family.estimated_usd > 0 && (
                  <p className="accent-text">
                    + {usd(family.estimated_usd)} estimated (pre-history)
                  </p>
                )}
                <p className="muted">
                  {family.unpriced_requests} unpriced · {family.model_id ?? "—"}
                </p>
              </article>
            ))}
          </div>
          {data.spend_avoided.length === 0 && (
            <p className="empty">No spend-avoided estimates available.</p>
          )}
        </>
      )}
      <div className="pricing-state">
        <ResourceState
          resource={pricing}
          empty={
            pricing.data?.families.length === 0 ? "No reference pricing configured." : undefined
          }
        />
        {pricing.data?.families.map((family) => (
          <div key={family.family}>
            {family.pending && (
              <Alert className="pending">
                <InfoIcon />
                <AlertTitle>
                  New reference model available: {family.pending.model_id}. Confirm via CLI
                </AlertTitle>
                <AlertDescription>{family.family} · This dashboard is read-only.</AlertDescription>
              </Alert>
            )}
            {(family.selected == null || family.rates == null) && (
              <p className="muted">
                {family.family} reference: {family.selected?.model_id ?? "—"} · rates:{" "}
                {family.rates
                  ? `${usd(family.rates.input_per_mtok)} / ${usd(family.rates.output_per_mtok)} per Mtok`
                  : "—"}
              </p>
            )}
          </div>
        ))}
        <Warnings warnings={pricing.data?.warnings ?? []} />
      </div>
      {data && (
        <>
          <div className="model-heading">
            <h3>Model performance</h3>
            <p className="muted">Latency includes load; total load is also reported separately.</p>
          </div>
          {data.models.length === 0 ? (
            <p className="empty">No model requests in this range.</p>
          ) : (
            <>
              <div className="model-table">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {[
                        "Model",
                        "Requests",
                        "Tokens in / out",
                        "Prompt / gen tps",
                        "p50 / p95",
                        "Total load",
                      ].map((label) => (
                        <TableHead key={label}>{label}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.models.map((model) => (
                      <TableRow key={model.model ?? "non-model"}>
                        <TableCell className="font-medium">
                          {model.model ?? "Non-model requests"}
                        </TableCell>
                        <TableCell>{count(model.requests)}</TableCell>
                        <TableCell>
                          {count(model.prompt_tokens)} / {count(model.output_tokens)}
                        </TableCell>
                        <TableCell>
                          {number(model.avg_prompt_tps)} / {number(model.avg_gen_tps)}
                        </TableCell>
                        <TableCell>
                          {ms(model.p50_latency_ms)} / {ms(model.p95_latency_ms)}
                        </TableCell>
                        <TableCell>{ms(model.total_load_ms)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <ModelCards models={data.models} />
            </>
          )}
          <Warnings warnings={data.warnings} />
        </>
      )}
    </Section>
  );
}
function InfoIcon() {
  return <AlertTriangle aria-hidden="true" />;
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
}: {
  resource: Resource<Agents>;
  icon: ReactNode;
  revision?: number;
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
    <Section
      title="Frontier CLIs"
      subtitle="Account capacity · separate from local usage"
      icon={icon}
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
            className="accent-text disabled:opacity-100 disabled:pointer-events-auto"
            aria-label="Refresh usage"
            title={refresh.seconds > 0 ? `Next refresh in ${refresh.seconds} s` : "Refresh usage"}
            disabled={refresh.refreshing || refresh.seconds > 0}
            onClick={() => void refresh.refresh()}
          >
            <RefreshCw aria-hidden="true" />
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
              ["claude-code", "Claude Code"],
              ["codex", "ChatGPT"],
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
                            <progress
                              aria-label={`${label} ${window.name} used`}
                              max={100}
                              value={window.used_percent}
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
      {resource.data?.tools.some(
        (tool) => tool.status === "not_tracked" && ["cursor", "kimi"].includes(tool.tool),
      ) && (
        <p className="muted agent-untracked">
          not tracked:{" "}
          {resource.data.tools
            .filter(
              (tool) => tool.status === "not_tracked" && ["cursor", "kimi"].includes(tool.tool),
            )
            .map((tool) => (tool.tool === "cursor" ? "Cursor" : "Kimi"))
            .join(", ")}
        </p>
      )}
    </Section>
  );
}
export function TickerSection({
  requests,
  connected,
}: {
  requests: LiveState["requests"];
  connected: boolean;
}) {
  return (
    <Section
      title="Live requests"
      subtitle="Most recent completions"
      icon={<Radio />}
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
              <li key={`${event.ts_ms}-${index}`}>
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
    </Section>
  );
}
