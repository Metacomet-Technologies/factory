import { AlertTriangle, CircleCheck, Info } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "../api/client";
import type {
  AuditRow,
  Confirmation,
  ControlAction,
  ControlResult,
  ControlSetting,
  ControlState,
  PendingPower,
} from "../api/ups-control";
import { ResourceState } from "./sections";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { cn } from "@/lib/utils";

const denied = "Controls available from Devon's or David's devices";

class ControlError extends Error {
  status: number;
  validJson: boolean;

  constructor(message: string, status: number, validJson = true) {
    super(message);
    this.status = status;
    this.validJson = validJson;
  }
}

/** How a result reads: executed, accepted but unverified, refused or not executed, or unknown. */
type Outcome = "ok" | "info" | "refused" | "unknown";
type Message = { text: string; outcome: Outcome } | null;
const trackingOutcome = (status: string): Outcome =>
  status === "SUCCESS"
    ? "ok"
    : status === "FSD_SET"
      ? "info"
      : status === "PENDING"
        ? "unknown"
        : "refused";

function consequence(action: string) {
  if (action === "power.off_stay") return "Recovery needs the physical power button.";
  return "factory-gpu, modem and eero go down; this page will disconnect. Downtime estimate unavailable before confirmation.";
}

function SettingForm({
  action,
  setting,
  busy,
  prepare,
}: {
  action: ControlAction;
  setting: ControlSetting;
  busy: boolean;
  prepare: (action: ControlAction, value: string) => void;
}) {
  const [value, setValue] = useState(setting.value);
  const valid = setting.allowed_values.length
    ? setting.allowed_values.includes(value)
    : /^-?(0|[1-9]\d*)$/.test(value) &&
      Number.isSafeInteger(Number(value)) &&
      setting.ranges.some(([low, high]) => Number(value) >= low && Number(value) <= high);
  const id = `control-${action.action}`;
  return (
    <form
      className="ups-control-setting"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) prepare(action, value);
      }}
    >
      <label htmlFor={id}>{action.label ?? action.action}</label>
      <p id={`${id}-help`} className="muted">
        Current: {setting.value} · Allowed:{" "}
        {setting.allowed_values.length
          ? setting.allowed_values.join(", ")
          : setting.ranges.map(([low, high]) => `${low}–${high}`).join(", ")}{" "}
        · {setting.range_source}
      </p>
      {setting.allowed_values.length ? (
        <Select
          id={id}
          value={value}
          aria-describedby={`${id}-help`}
          options={setting.allowed_values}
          onValueChange={setValue}
        />
      ) : (
        <Input
          id={id}
          type="text"
          inputMode="numeric"
          value={value}
          aria-describedby={`${id}-help`}
          onChange={(event) => setValue(event.target.value)}
        />
      )}
      <Button type="submit" variant="outline" disabled={busy || !action.enabled || !valid}>
        Review {action.label ?? action.action}
      </Button>
      {(action.disabled_reason || action.refusal_reason) && (
        <p className="status-warn">{action.disabled_reason ?? action.refusal_reason}</p>
      )}
    </form>
  );
}

export default function UpsControls() {
  const [state, setState] = useState<ControlState | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<Message>(null);
  const [auditPage, setAuditPage] = useState<{ loading: boolean; error: string | null }>({
    loading: false,
    error: null,
  });
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<{
    action: ControlAction;
    value: string | null;
    confirmation: Confirmation;
  } | null>(null);
  const [typed, setTyped] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const [pending, setPending] = useState<PendingPower | null>(null);
  const [recoveredId, setRecoveredId] = useState<number | null>(null);
  const [stateError, setStateError] = useState(denied);
  const forbidden = useRef(false);
  const stateTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextStateRead = useRef(0);

  const controlRequest = useCallback(
    async <T,>(path: string, body?: object, signal?: AbortSignal): Promise<T> => {
      if (forbidden.current) throw new ControlError(denied, 403);
      const response = await fetch(apiUrl(`/control/v1/${path}`), {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
          : AbortSignal.timeout(20_000),
        ...(body
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
      });
      if (response.status === 403) {
        forbidden.current = true;
        if (stateTimer.current !== null) clearInterval(stateTimer.current);
        setState(null);
        setStateError(denied);
        setMessage(null);
        setLoading(false);
        setDialog(null);
      } else if (forbidden.current) {
        // An earlier in-flight request cannot restore controls after denial.
        throw new ControlError(denied, 403);
      }
      // factory-api answers unknown /control routes with `{ error: { code, message } }`.
      let data: T & { error?: string | { message?: string }; result?: string };
      try {
        data = (await response.json()) as typeof data;
      } catch (error) {
        throw new ControlError(
          `HTTP ${response.status}: ${error instanceof Error ? error.message : "Invalid JSON response"}`,
          response.status,
          false,
        );
      }
      if (forbidden.current && response.status !== 403) throw new ControlError(denied, 403);
      if (!response.ok)
        throw new ControlError(
          (typeof data.error === "string" ? data.error : data.error?.message) ??
            data.result ??
            `HTTP ${response.status}`,
          response.status,
        );
      return data;
    },
    [],
  );

  const refresh = useCallback(
    (signal?: AbortSignal) => {
      if (forbidden.current || Date.now() < nextStateRead.current) return Promise.resolve();
      return controlRequest<ControlState>("state", undefined, signal)
        .then((next) => {
          if (!signal?.aborted && !forbidden.current) {
            setState(next);
            setLoading(false);
            nextStateRead.current = 0;
            if (next.pending_power_action) setPending(next.pending_power_action);
          }
        })
        .catch((error: unknown) => {
          if (!signal?.aborted) {
            setState(null);
            setStateError(
              !forbidden.current && error instanceof ControlError && error.status !== 403
                ? error.message
                : denied,
            );
            setLoading(false);
            nextStateRead.current = Date.now() + 30_000;
          }
        });
    },
    [controlRequest],
  );
  useEffect(() => {
    if (forbidden.current) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void refresh(controller.signal);
    }, 30_000);
    stateTimer.current = timer;
    void refresh(controller.signal);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (!dialog) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [dialog]);

  const banner = pending ?? state?.pending_power_action;
  const bannerId = banner?.audit_id;
  useEffect(() => {
    if (bannerId == null || bannerId === recoveredId) return;
    const controller = new AbortController();
    // A healthy API before shutdown is not recovery. Observe down, then up.
    let sawDown = false;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const response = await fetch(apiUrl("/v1/health"), {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]),
          cache: "no-store",
        });
        if (!response.ok) sawDown = true;
        else if (sawDown && !controller.signal.aborted) {
          setRecoveredId(bannerId);
          setPending(null);
          void refresh();
        }
      } catch {
        if (!controller.signal.aborted) sawDown = true;
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = setInterval(() => {
      void check();
    }, 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [bannerId, recoveredId, refresh]);

  const prepare = useCallback(
    async (action: ControlAction, value: string | null = null) => {
      setBusy(true);
      setMessage(null);
      try {
        const confirmation = await controlRequest<Confirmation>("actions", {
          action: action.action,
          value,
        });
        setTyped("");
        setNow(Date.now());
        setDialog({ action, value, confirmation });
      } catch (error) {
        if (!forbidden.current)
          setMessage({
            text: error instanceof Error ? error.message : "Request failed",
            outcome: "refused",
          });
      } finally {
        setBusy(false);
        void refresh();
      }
    },
    [refresh, controlRequest],
  );
  async function confirm() {
    if (
      busy ||
      !dialog ||
      typed !== dialog.confirmation.confirm_phrase ||
      Date.now() >= dialog.confirmation.expires_ms
    )
      return;
    setBusy(true);
    try {
      const result = await controlRequest<ControlResult>(
        `actions/${dialog.confirmation.id}/confirm`,
        { phrase: typed },
      );
      setMessage({
        text: [result.result, result.expected_downtime].filter(Boolean).join(" · "),
        outcome: trackingOutcome(result.tracking_status),
      });
      if (
        dialog.action.tier === "power" &&
        ["FSD_SET", "SUCCESS", "PENDING"].includes(result.tracking_status)
      ) {
        setPending({
          audit_id: result.audit_id,
          ts_ms: Date.now(),
          action: dialog.action.action,
          result: result.result,
          ...(result.expected_return_ms == null
            ? {}
            : { expected_return_ms: result.expected_return_ms }),
        });
      }
    } catch (error) {
      if (!forbidden.current)
        setMessage(
          error instanceof ControlError && error.validJson
            ? { text: error.message, outcome: "refused" }
            : {
                text: `Confirmation failed; outcome unknown. Check audit before retrying. ${error instanceof Error ? error.message : String(error)}`,
                outcome: "unknown",
              },
        );
    } finally {
      setDialog(null);
      setBusy(false);
      setAudit(null);
      void refresh();
    }
  }
  const remaining = dialog
    ? Math.max(0, Math.ceil((dialog.confirmation.expires_ms - now) / 1000))
    : 0;
  const pendingBanner = banner && banner.audit_id !== recoveredId && (
    <Alert className="ups-pending pending" role="status">
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>
        {banner.expected_return_ms == null
          ? "Factory going down; return time unavailable"
          : `Factory going down; expect it back at about ${new Date(banner.expected_return_ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
      </AlertTitle>
      <AlertDescription>
        <p>{banner.result}</p>
        <p>Watching API health for disconnect and recovery.</p>
      </AlertDescription>
    </Alert>
  );
  // Only an executed action gets the check; refusals are destructive and unknown outcomes warn.
  const result = message && (
    <Alert
      className={cn("ups-control-result", message.outcome === "unknown" && "pending")}
      variant={message.outcome === "refused" ? "destructive" : "default"}
      data-outcome={message.outcome}
      role="status"
    >
      {message.outcome === "ok" ? (
        <CircleCheck aria-hidden="true" className="status-ok" />
      ) : message.outcome === "info" ? (
        <Info aria-hidden="true" />
      ) : (
        <AlertTriangle aria-hidden="true" />
      )}
      <AlertDescription>{message.text}</AlertDescription>
    </Alert>
  );

  if (loading)
    return (
      <section className="ups-panel ups-controls" aria-label="Controls">
        <ResourceState loading error={null} />
      </section>
    );
  const rows = audit ?? state?.audit ?? [];
  return (
    <>
      {!state ? (
        <div className="ups-controls">
          {pendingBanner}
          {result}
          <section className="ups-panel" aria-label="Controls">
            {stateError === denied ? (
              <p className="muted">{denied}</p>
            ) : (
              <ResourceState loading={false} error={stateError} title="Controls unavailable" />
            )}
          </section>
        </div>
      ) : (
        <section className="ups-panel ups-controls" aria-label="Controls">
          <h3>Controls</h3>
          <p className="muted">Signed in as {state.login}</p>
          {pendingBanner}
          {result}
          {(["safe", "settings", "power"] as const).map((tier) => (
            <div className="ups-control-tier" key={tier}>
              <h4>{tier === "safe" ? "Safe" : tier === "settings" ? "Settings" : "Power"}</h4>
              {state.actions
                .filter((action) => action.tier === tier)
                .map((action) => {
                  const setting = state.settings[action.action];
                  return setting ? (
                    <SettingForm
                      key={`${action.action}:${setting.value}`}
                      action={action}
                      setting={setting}
                      busy={busy}
                      prepare={(action, value) => {
                        void prepare(action, value);
                      }}
                    />
                  ) : (
                    <div key={action.action} className="ups-control-action">
                      <Button
                        variant={tier === "power" ? "destructive" : "outline"}
                        disabled={busy || !action.enabled}
                        aria-describedby={
                          action.disabled_reason || action.refusal_reason || tier === "power"
                            ? `hint-${action.action}`
                            : undefined
                        }
                        onClick={() => {
                          void prepare(action);
                        }}
                      >
                        {action.label ?? action.action}
                      </Button>
                      <div id={`hint-${action.action}`}>
                        {tier === "power" && <p>{consequence(action.action)}</p>}
                        {(action.disabled_reason || action.refusal_reason) && (
                          <p className="status-warn">
                            {action.disabled_reason ?? action.refusal_reason}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          ))}
          <div className="ups-control-tier">
            <h4>Audit log</h4>
            <ResourceState
              loading={auditPage.loading}
              error={auditPage.error}
              title="Unable to load older audit rows"
            />
            {!rows.length && <p className="muted">No audit rows.</p>}
            <ol
              className="ups-events ups-control-audit"
              tabIndex={0}
              aria-label="UPS control audit rows"
            >
              {rows.map((row) => (
                <li key={row.id}>
                  <time dateTime={new Date(row.ts_ms).toISOString()}>
                    {new Date(row.ts_ms).toLocaleString()}
                  </time>
                  <p>
                    {row.login ?? "—"} · {row.action ?? "—"} · {row.value ?? "—"}
                  </p>
                  <p>{row.result}</p>
                </li>
              ))}
            </ol>
            <div className="row">
              {audit && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setAudit(null);
                    setAuditPage({ loading: false, error: null });
                    void refresh();
                  }}
                >
                  Newest audit
                </Button>
              )}
              {rows.length === 20 && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setAuditPage({ loading: true, error: null });
                    void controlRequest<{ rows: AuditRow[] }>(
                      `audit?limit=20&before_ms=${rows[rows.length - 1]!.ts_ms}`,
                    )
                      .then((page) => {
                        setAudit(page.rows);
                        setAuditPage({ loading: false, error: null });
                      })
                      .catch((error: unknown) =>
                        setAuditPage({
                          loading: false,
                          error: forbidden.current
                            ? null
                            : error instanceof Error
                              ? error.message
                              : "Audit unavailable",
                        }),
                      )
                      .finally(() => setBusy(false));
                  }}
                >
                  Older audit
                </Button>
              )}
            </div>
          </div>
        </section>
      )}
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null);
        }}
      >
        <DialogContent className="ups-confirm" aria-describedby="ups-confirm-detail">
          <DialogTitle>Confirm {dialog?.action.label ?? dialog?.action.action}</DialogTitle>
          <DialogDescription id="ups-confirm-detail">
            Value: {dialog?.value ?? "—"}.{" "}
            {dialog?.action.tier === "power" && consequence(dialog.action.action)}
          </DialogDescription>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void confirm();
            }}
          >
            <label htmlFor="ups-confirm-typed">
              Type exactly: <strong>{dialog?.confirmation.confirm_phrase}</strong>
            </label>
            <Input
              id="ups-confirm-typed"
              autoComplete="off"
              value={typed}
              disabled={busy}
              onChange={(event) => setTyped(event.target.value)}
              aria-describedby="ups-confirm-expiry"
            />
            <p id="ups-confirm-expiry">
              {remaining > 0
                ? `${remaining} s remaining`
                : "Confirmation expired. Close and request again."}
            </p>
            <div className="row">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant={dialog?.action.tier === "power" ? "destructive" : "default"}
                disabled={busy || remaining === 0 || typed !== dialog?.confirmation.confirm_phrase}
              >
                {busy ? "Confirming…" : "Confirm"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
