import { BatteryWarning, Battery, Plug } from "lucide-react";
import type { UpsCurrent } from "../api/types";
import { number } from "../lib/format";
import { Panel } from "./ui/panel";
import { Stat } from "./ui/stat";
import { StatusChip } from "./ui/status-chip";
import { MeterBar } from "./ui/meter-bar";
import { buttonVariants } from "./ui/button";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type Props = { current: UpsCurrent | null | undefined; now: number; warnings?: string[] };
export type UpsLabel = "No data" | "Low battery" | "On battery" | "Replace battery" | "Online";
export function upsState({ current, now }: Props): UpsLabel {
  if (!current || now - current.ts_ms > 30_000) return "No data";
  if (current.low_battery) return "Low battery";
  if (current.on_battery) return "On battery";
  if (current.replace_battery) return "Replace battery";
  if (current.on_line) return "Online";
  return "No data";
}
export function upsTone(label: UpsLabel) {
  return label === "On battery" || label === "Low battery"
    ? "fail"
    : label === "Replace battery"
      ? "warn"
      : label === "Online"
        ? "ok"
        : "neutral";
}
export function runtime(seconds: number | null | undefined) {
  if (seconds == null) return "—";
  if (seconds >= 3600)
    return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} m`;
  return `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
}

export function UpsBadge(props: Props) {
  const label = upsState(props);
  const current = label === "No data" ? null : props.current;
  const alarm = label === "On battery" || label === "Low battery";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href="/ups"
            data-slot="button"
            aria-label={`UPS: ${label}`}
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon" }),
              alarm
                ? "status-fail"
                : label === "Replace battery"
                  ? "status-warn"
                  : label === "No data"
                    ? "muted"
                    : "status-ok",
            )}
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
          </a>
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

export function UpsSection(props: Props & { warnings: string[]; index?: number }) {
  const label = upsState(props);
  const current = label === "No data" ? null : props.current;
  const alarm = label === "On battery" || label === "Low battery";
  const tone = upsTone(label);
  const markers = [
    current?.charge_warning_percent == null
      ? []
      : [{ at: current.charge_warning_percent, label: "Warning" }],
    current?.charge_low_percent == null
      ? []
      : [{ at: current.charge_low_percent, label: "Low / shutdown" }],
  ].flat();
  return (
    <a href="/ups" className="panel-link ups" aria-label="UPS history and settings">
      <Panel
        title="UPS"
        subtitle="Power · factory-gpu, modem, eero"
        icon={<Plug />}
        index={props.index}
        tone={alarm ? "fail" : label === "Replace battery" ? "warn" : undefined}
        action={
          <StatusChip tone={tone} dot={label !== "No data"} pulse={alarm}>
            {label}
          </StatusChip>
        }
      >
        <div className="ups-readings">
          <div>
            <Stat
              label="Charge"
              value={current?.charge_percent ?? null}
              format={(n) => `${number(n)}%`}
              tone={alarm ? "fail" : undefined}
            />
            <MeterBar
              label="Charge thresholds"
              value={current?.charge_percent}
              tone={alarm ? "fail" : current ? "ok" : "muted"}
              markers={markers}
            />
            <p className="muted ups-threshold-note">
              Warning {number(current?.charge_warning_percent)}% · Low/shutdown{" "}
              {number(current?.charge_low_percent)}%
            </p>
          </div>
          <Stat
            label="Runtime"
            value={runtime(current?.runtime_s)}
            tone={alarm ? "fail" : undefined}
            size={alarm ? "lg" : "md"}
          />
          <Stat
            label="Load"
            value={`${number(current?.load_w)} W of ${number(current?.load_nominal_w)} W`}
            note={`${number(current?.load_percent)}%`}
            size="sm"
          />
          <Stat
            label="Input / output"
            value={`${number(current?.input_v)} / ${number(current?.output_v)} V`}
            note={`Battery ${number(current?.battery_v)} V`}
            size="sm"
          />
        </div>
        <p className="muted">Last self-test: {current?.test_result ?? "—"}</p>
        {label === "No data" &&
          props.warnings.map((warning) => (
            <p className="status-warn" key={warning}>
              {warning}
            </p>
          ))}
      </Panel>
    </a>
  );
}
