import { BatteryWarning, Battery, Plug } from "lucide-react";
import type { UpsCurrent } from "../api/types";
import { number } from "../lib/format";
import { Card, CardContent, CardHeader } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type Props = { current: UpsCurrent | null | undefined; now: number; warnings?: string[] };
function state({ current, now }: Props) {
  if (!current || now - current.ts_ms > 30_000) return "No data";
  if (current.low_battery) return "Low battery";
  if (current.on_battery) return "On battery";
  if (current.replace_battery) return "Replace battery";
  if (current.on_line) return "Online";
  return "No data";
}
function runtime(seconds: number | null | undefined) {
  if (seconds == null) return "—";
  if (seconds >= 3600)
    return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} m`;
  return `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
}

export function UpsBadge(props: Props) {
  const label = state(props);
  const current = label === "No data" ? null : props.current;
  const alarm = label === "On battery" || label === "Low battery";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={`UPS: ${label}`}
            onClick={() => window.location.assign("/ups")}
            className={
              alarm
                ? "status-fail"
                : label === "Replace battery"
                  ? "status-warn"
                  : label === "No data"
                    ? "muted"
                    : "status-ok"
            }
          >
            {label === "No data" ? (
              <span className="ups-unknown-icon" aria-hidden="true">
                <Battery />
                <span>?</span>
              </span>
            ) : alarm ? (
              <BatteryWarning aria-hidden="true" />
            ) : (
              <Plug aria-hidden="true" />
            )}
          </Button>
        }
      />
      <TooltipContent>
        <div>
          UPS: {label} · Charge {number(current?.charge_percent)}% · Runtime{" "}
          {runtime(current?.runtime_s)} · Load {number(current?.load_w)} W · Input{" "}
          {number(current?.input_v)} V · Sample age{" "}
          {props.current
            ? `${Math.max(0, Math.floor((props.now - props.current.ts_ms) / 1000))} s`
            : "—"}
          {label === "No data" && props.warnings?.map((warning) => <p key={warning}>{warning}</p>)}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function UpsSection(props: Props & { warnings: string[] }) {
  const label = state(props);
  const current = label === "No data" ? null : props.current;
  const alarm = label === "On battery" || label === "Low battery";
  return (
    <section className={`ups${alarm ? " ups-warning" : ""}`} aria-label="UPS">
      <a href="/ups" className="ups-card-link" aria-label="UPS history and settings">
        <Card>
          <CardHeader>
            <div className="section-heading">
              <div className="section-title">
                <Plug aria-hidden="true" />
                <h2>UPS</h2>
              </div>
              <Badge
                variant="outline"
                className={
                  alarm || label === "Replace battery"
                    ? "status-warn"
                    : label === "Online"
                      ? "status-ok"
                      : "muted"
                }
              >
                {label}
              </Badge>
            </div>
            <p className="muted">Power · factory-gpu, modem, eero</p>
          </CardHeader>
          <CardContent>
            <div className="ups-readings">
              <div>
                <p className="muted">Charge</p>
                <strong className="ups-charge">{number(current?.charge_percent)}%</strong>
                <div className="ups-charge-track" aria-label="Charge thresholds">
                  <span
                    style={{
                      width: `${Math.min(100, Math.max(0, current?.charge_percent ?? 0))}%`,
                    }}
                  />
                  {current?.charge_warning_percent != null && (
                    <i style={{ left: `${current.charge_warning_percent}%` }} />
                  )}
                  {current?.charge_low_percent != null && (
                    <i style={{ left: `${current.charge_low_percent}%` }} />
                  )}
                </div>
                <p className="muted">
                  Warning {number(current?.charge_warning_percent)}% · Low/shutdown{" "}
                  {number(current?.charge_low_percent)}%
                </p>
              </div>
              <div>
                <p className="muted">Runtime</p>
                <strong className={alarm ? "ups-runtime-alarm status-warn" : "ups-runtime"}>
                  {runtime(current?.runtime_s)}
                </strong>
              </div>
              <div>
                <p className="muted">Load</p>
                <strong>
                  {number(current?.load_w)} W of {number(current?.load_nominal_w)} W
                </strong>
                <p className="muted">{number(current?.load_percent)}%</p>
              </div>
              <div>
                <p className="muted">Input / output</p>
                <strong>
                  {number(current?.input_v)} / {number(current?.output_v)} V
                </strong>
                <p className="muted">Battery {number(current?.battery_v)} V</p>
              </div>
            </div>
            <p className="muted">Last self-test: {current?.test_result ?? "—"}</p>
            {label === "No data" &&
              props.warnings.map((warning) => (
                <p className="status-warn" key={warning}>
                  {warning}
                </p>
              ))}
          </CardContent>
        </Card>
      </a>
    </section>
  );
}
