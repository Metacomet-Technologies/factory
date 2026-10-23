import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ControlState } from "../api/ups-control";
import UpsControls from "./ups-controls";

// Separate from ups-controls.test.tsx, which stays as MET-168 wrote it.
const phrase = "CONFIRM synthetic UPS";
let state: ControlState;
let respond: Partial<Record<"state" | "prepare" | "confirm" | "audit", () => Promise<Response>>>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  respond = {};
  state = {
    login: "synthetic@github",
    actions: [
      {
        action: "test.quick",
        tier: "safe",
        confirm_phrase: "x",
        enabled: true,
        disabled_reason: null,
      },
    ],
    settings: {},
    pending_power_action: null,
    audit: Array.from({ length: 20 }, (_, index) => ({
      id: 40 - index,
      ts_ms: 300 - index,
      login: "audit@github",
      action: "test.quick",
      value: null,
      result: `row ${index}`,
    })),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string) => {
      if (path === "/control/v1/state") return respond.state?.() ?? json(state);
      if (path === "/control/v1/actions")
        return (
          respond.prepare?.() ??
          json({ id: 9, confirm_phrase: phrase, expires_ms: Date.now() + 60_000 })
        );
      if (path.endsWith("/confirm")) return respond.confirm!();
      if (path.startsWith("/control/v1/audit")) return respond.audit!();
      if (path === "/v1/health") return json({});
      throw new Error(`Unexpected path ${path}`);
    }),
  );
});

async function confirmQuickTest() {
  render(<UpsControls />);
  fireEvent.click(await screen.findByRole("button", { name: "test.quick" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: phrase } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  return screen.findByRole("status");
}
const icon = (element: HTMLElement) => element.querySelector("svg")?.getAttribute("class") ?? "";

describe("UPS Controls result presentation", () => {
  it("marks only an executed action with the success check", async () => {
    respond.confirm = () =>
      json({
        audit_id: 1,
        tracking_status: "SUCCESS",
        result: "executed: driver tracking SUCCESS",
        expected_downtime: null,
      });
    const result = await confirmQuickTest();
    expect(result).toHaveTextContent("executed: driver tracking SUCCESS");
    expect(icon(result)).toContain("lucide-circle-check");
    expect(result).toHaveAttribute("data-variant", "default");
  });

  it.each([
    [
      "FAILURE",
      "not executed: tracking FAILURE or unconfirmed submission; do not automatically retry",
      "destructive",
      "lucide-triangle-alert",
    ],
    [
      "PENDING",
      "not executed (unconfirmed): tracking PENDING after 10 s; may execute later; do not retry",
      "default",
      "lucide-triangle-alert",
    ],
    [
      "FSD_SET",
      "FSD latch set; clean shutdown requested, physical completion unverified",
      "default",
      "lucide-info",
    ],
  ])(
    "shows a %s result verbatim without the success check",
    async (status, text, variant, expected) => {
      respond.confirm = () =>
        json({ audit_id: 1, tracking_status: status, result: text, expected_downtime: null });
      const result = await confirmQuickTest();
      expect(result).toHaveTextContent(text);
      expect(result).toHaveAttribute("data-variant", variant);
      expect(icon(result)).toContain(expected);
      expect(icon(result)).not.toContain("lucide-circle-check");
    },
  );

  it("shows a confirm refusal as destructive without the check", async () => {
    respond.confirm = () => json({ error: "confirmation expired" }, 409);
    const refused = await confirmQuickTest();
    expect(refused).toHaveTextContent("confirmation expired");
    expect(refused).toHaveAttribute("data-variant", "destructive");
    expect(icon(refused)).not.toContain("lucide-circle-check");
  });

  it("warns, without the check, when the confirmation outcome is unknown", async () => {
    respond.confirm = () => Promise.reject(new TypeError("Failed to fetch"));
    const unknown = await confirmQuickTest();
    expect(unknown).toHaveTextContent("outcome unknown");
    expect(unknown).toHaveClass("pending");
    expect(icon(unknown)).toContain("lucide-triangle-alert");
  });

  it("shows a prepare refusal as destructive without opening the dialog", async () => {
    respond.prepare = () => json({ error: "quick test requires 100% charge" }, 409);
    render(<UpsControls />);
    fireEvent.click(await screen.findByRole("button", { name: "test.quick" }));
    const result = await screen.findByRole("status");
    expect(result).toHaveTextContent("quick test requires 100% charge");
    expect(result).toHaveAttribute("data-variant", "destructive");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("UPS Controls loading and error states", () => {
  it("shows skeletons while the first state read is pending", () => {
    respond.state = () => new Promise(() => {});
    render(<UpsControls />);
    const region = screen.getByRole("region", { name: "Controls" });
    expect(within(region).getByLabelText("Loading section")).toBeInTheDocument();
  });

  it("shows a state failure in the destructive Alert with the server's exact message", async () => {
    respond.state = () => json({ error: "ups snapshot unavailable" }, 503);
    render(<UpsControls />);
    await screen.findByText("ups snapshot unavailable");
    const alert = within(screen.getByRole("region", { name: "Controls" })).getByRole("alert");
    expect(alert).toHaveAttribute("data-variant", "destructive");
    expect(alert).toHaveTextContent("Controls unavailable");
    expect(within(alert).getByText("ups snapshot unavailable")).toBeInTheDocument();
  });

  it("keeps the 403 view as plain denied text, not an alert", async () => {
    respond.state = () => json({ error: "forbidden" }, 403);
    render(<UpsControls />);
    await screen.findByText("Controls available from Devon's or David's devices");
    const region = screen.getByRole("region", { name: "Controls" });
    expect(within(region).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(region).queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows a skeleton while an older audit page loads and the Alert when it fails", async () => {
    let fail: (response: Response) => void = () => {};
    respond.audit = () => new Promise((resolve) => (fail = resolve));
    render(<UpsControls />);
    fireEvent.click(await screen.findByRole("button", { name: "Older audit" }));
    const region = screen.getByRole("region", { name: "Controls" });
    expect(within(region).getByLabelText("Loading section")).toBeInTheDocument();
    await act(async () =>
      fail(new Response(JSON.stringify({ error: "audit store busy" }), { status: 503 })),
    );
    const alert = within(region).getByRole("alert");
    expect(alert).toHaveTextContent("Unable to load older audit rows");
    expect(within(alert).getByText("audit store busy")).toBeInTheDocument();
    expect(within(region).queryByLabelText("Loading section")).not.toBeInTheDocument();
    // The newest rows stay readable.
    expect(within(region).getByText("row 0")).toBeInTheDocument();
  });
});
