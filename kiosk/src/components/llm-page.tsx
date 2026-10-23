import { Activity, AlertTriangle, Gauge, Receipt } from "lucide-react";
import type { Resource } from "../api/client";
import type { ModelUsage, Pricing, Usage, UsageRange } from "../api/types";
import { count, ms, number, usd } from "../lib/format";
import { ResourceState, Warnings } from "./sections";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { KeyValue } from "./ui/key-value";
import { PageHeader } from "./ui/page-header";
import { Panel, Tile } from "./ui/panel";
import { RangeToggle } from "./ui/range-toggle";
import { Stat, StatGrid } from "./ui/stat";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

const ranges = ["24h", "7d", "30d"] as const;

function ModelCards({ models }: { models: ModelUsage[] }) {
  return (
    <div className="model-cards">
      {models.map((model) => (
        <Tile className="model-card" key={model.model ?? "non-model"}>
          <h3>{model.model ?? "Non-model requests"}</h3>
          <KeyValue
            rows={[
              ["Requests", count(model.requests)],
              ["Tokens in / out", `${count(model.prompt_tokens)} / ${count(model.output_tokens)}`],
              [
                "Prompt / generation tps",
                `${number(model.avg_prompt_tps)} / ${number(model.avg_gen_tps)}`,
              ],
              ["Latency p50 / p95", `${ms(model.p50_latency_ms)} / ${ms(model.p95_latency_ms)}`],
              ["Total load time", ms(model.total_load_ms)],
            ]}
          />
        </Tile>
      ))}
    </div>
  );
}

/**
 * Full Local LLM details: totals, spend avoided per family, reference pricing state and the
 * per-model performance table. The dashboard only shows the KPI card that links here.
 */
export default function LlmPage({
  usage,
  pricing,
  range,
  setRange,
}: {
  usage: Resource<Usage>;
  pricing: Resource<Pricing>;
  range: UsageRange;
  setRange: (range: UsageRange) => void;
}) {
  const data = usage.data;
  return (
    <main id="main" className="dashboard llm-page">
      <PageHeader
        eyebrow="Local LLM"
        title="Local LLM · Usage & spend"
        aside={
          <>
            <RangeToggle value={range} options={ranges} onChange={setRange} label="Usage range" />
          </>
        }
      />
      <Panel
        title="Totals"
        subtitle={`Requests served in the last ${range}`}
        icon={<Activity />}
        index={0}
      >
        <ResourceState resource={usage} />
        {data && (
          <>
            <StatGrid columns={3}>
              <Stat label="Requests" value={data.totals.requests} format={count} size="lg" />
              <Stat label="Tokens in" value={data.totals.prompt_tokens} format={count} size="lg" />
              <Stat label="Tokens out" value={data.totals.output_tokens} format={count} size="lg" />
            </StatGrid>
            <Warnings warnings={data.warnings} />
          </>
        )}
      </Panel>
      <Panel
        title="Spend avoided"
        subtitle="Reference pricing · USD"
        icon={<Receipt />}
        index={1}
        className="llm-spend"
      >
        {data && (
          <div className="spend-grid">
            {data.spend_avoided.map((family) => (
              <Tile key={family.family} className="spend-card">
                <h4>{family.family}</h4>
                <Stat
                  label={null}
                  value={family.usd}
                  format={usd}
                  size="lg"
                  suffix="priced"
                  className="spend-stat"
                />
                {family.estimated_usd > 0 && (
                  <p className="spend-estimate">
                    + {usd(family.estimated_usd)} estimated (pre-history)
                  </p>
                )}
                <p className="muted">
                  {family.unpriced_requests} unpriced · {family.model_id ?? "—"}
                </p>
              </Tile>
            ))}
          </div>
        )}
        {data && data.spend_avoided.length === 0 && (
          <p className="empty">No spend-avoided estimates available.</p>
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
                  <AlertTriangle aria-hidden="true" />
                  <AlertTitle>
                    New reference model available: {family.pending.model_id}. Confirm via CLI
                  </AlertTitle>
                  <AlertDescription>
                    {family.family} · This dashboard is read-only.
                  </AlertDescription>
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
      </Panel>
      <Panel
        title="Model performance"
        subtitle="Latency includes load; total load is also reported separately."
        icon={<Gauge />}
        index={2}
        className="llm-models"
      >
        {data &&
          (data.models.length === 0 ? (
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
          ))}
      </Panel>
    </main>
  );
}
