import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ControlAction, ControlState } from "../api/ups-control";
import UpsControls from "./ups-controls";

const action = (name: string, tier: ControlAction["tier"]): ControlAction => ({
  action: name,
  tier,
  confirm_phrase: `confirm ${name}`,
  enabled: true,
  disabled_reason: null,
});
let state: ControlState;
let refusal: string;
let health: number;
let stateStatus: number;
beforeEach(() => {
  refusal = "";
  health = 200;
  stateStatus = 200;
  state = {
    login: "synthetic@github",
    actions: [
      action("test.quick", "safe"),
      action("input.sensitivity", "settings"),
      action("ups.delay.start", "settings"),
      action("power.cycle", "power"),
      {
        ...action("power.off_stay", "power"),
        enabled: false,
        disabled_reason: "Final shutdown hook overrides stay-off",
      },
    ],
    settings: {
      "input.sensitivity": {
        value: "normal",
        allowed_values: ["low", "normal", "high"],
        ranges: [],
        range_source: "upsd",
      },
      "ups.delay.start": {
        value: "35",
        allowed_values: [],
        ranges: [
          [30, 40],
          [60, 90],
        ],
        range_source: "upsd",
      },
    },
    pending_power_action: null,
    audit: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string, options?: RequestInit) => {
      if (path === "/control/v1/state")
        return Promise.resolve(new Response(JSON.stringify(state), { status: stateStatus }));
      if (path === "/v1/health") return Promise.resolve(new Response("{}", { status: health }));
      if (path === "/control/v1/actions") {
        if (refusal)
          return Promise.resolve(new Response(JSON.stringify({ error: refusal }), { status: 409 }));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 42,
              confirm_phrase: "CONFIRM synthetic UPS",
              expires_ms: Date.now() + 60_000,
            }),
          ),
        );
      }
      if (path.endsWith("/confirm")) {
        const phrase = JSON.parse(options?.body as string) as { phrase: string };
        if (phrase.phrase !== "CONFIRM synthetic UPS") throw new Error("wrong phrase");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              audit_id: 7,
              tracking_status: "FSD_SET",
              result: "FSD latch set",
              expected_downtime: "budget 5–15 minutes, not a measured guarantee",
            }),
          ),
        );
      }
      if (path.startsWith("/control/v1/audit"))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              rows: [
                {
                  id: 1,
                  ts_ms: 50,
                  login: "older@github",
                  action: "beeper.mute",
                  value: null,
                  result: "older result",
                },
              ],
            }),
          ),
        );
      throw new Error(`Unexpected path ${path}`);
    }),
  );
});

describe("UPS controls", () => {
  it.each(["403", "network"])("renders only denied text and no buttons on %s", async (failure) => {
    if (failure === "403") stateStatus = 403;
    else vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    render(<UpsControls />);
    await screen.findByText("Controls available from Devon's or David's devices");
    const region = screen.getByRole("region", { name: "Controls" });
    expect(within(region).queryByRole("button")).not.toBeInTheDocument();
  });

  it("requires an exact phrase and disables confirmation at its server deadline", async () => {
    vi.useFakeTimers();
    await act(async () => {
      render(<UpsControls />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "test.quick" }));
    });
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByRole("textbox");
    const confirm = within(dialog).getByRole("button", { name: "Confirm" });
    expect(confirm).toBeDisabled();
    for (const phrase of [
      "confirm synthetic UPS",
      "CONFIRM synthetic UPS ",
      " CONFIRM synthetic UPS",
    ]) {
      fireEvent.change(input, { target: { value: phrase } });
      expect(confirm).toBeDisabled();
    }
    fireEvent.change(input, { target: { value: "CONFIRM synthetic UPS" } });
    expect(confirm).toBeEnabled();
    await act(() => vi.advanceTimersByTimeAsync(59_750));
    expect(confirm).toBeEnabled();
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(confirm).toBeDisabled();
    expect(dialog).toHaveTextContent("Confirmation expired");
  });

  it("shows a refusal verbatim without offering confirmation", async () => {
    refusal = "quick test requires 100% charge";
    render(<UpsControls />);
    fireEvent.click(await screen.findByRole("button", { name: "test.quick" }));
    expect(await screen.findByRole("status")).toHaveTextContent(refusal);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows power consequences and preserves the banner until API disconnect then recovery", async () => {
    vi.useFakeTimers();
    await act(async () => {
      render(<UpsControls />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "power.cycle" }));
    });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("factory-gpu, modem and eero go down");
    expect(dialog).toHaveTextContent("this page will disconnect");
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "CONFIRM synthetic UPS" },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Factory going down; return time unavailable")).toBeInTheDocument();
    expect(screen.getByText(/budget 5–15 minutes/)).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByText("Factory going down; return time unavailable")).toBeInTheDocument();
    health = 503;
    stateStatus = 503;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(screen.getByText("Factory going down; return time unavailable")).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Controls" })).queryByRole("button"),
    ).not.toBeInTheDocument();
    health = 200;
    stateStatus = 200;
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(
      screen.queryByText("Factory going down; return time unavailable"),
    ).not.toBeInTheDocument();
  });

  it("shows disabled stay-off and its server reason", async () => {
    render(<UpsControls />);
    expect(await screen.findByRole("button", { name: "power.off_stay" })).toBeDisabled();
    expect(screen.getByText("Final shutdown hook overrides stay-off")).toBeInTheDocument();
    expect(screen.getByText("Recovery needs the physical power button.")).toBeInTheDocument();
  });

  it("uses the server's enums and disjoint ranges and reviews the entered value", async () => {
    render(<UpsControls />);
    const select = await screen.findByRole("combobox", { name: "input.sensitivity" });
    expect(select).toHaveValue("normal");
    fireEvent.change(select, { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "Review input.sensitivity" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Value: high");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    const input = screen.getByRole("textbox", { name: "ups.delay.start" });
    const review = screen.getByRole("button", { name: "Review ups.delay.start" });
    for (const value of ["29", "45", "91", "60.5", "060"]) {
      fireEvent.change(input, { target: { value } });
      expect(review).toBeDisabled();
    }
    for (const value of ["30", "40", "60", "90"]) {
      fireEvent.change(input, { target: { value } });
      expect(review).toBeEnabled();
    }
  });

  it("renders pending state and pages audit rows through the supplied timestamp cursor", async () => {
    state.pending_power_action = {
      audit_id: 10,
      ts_ms: 123,
      action: "power.cycle",
      result: "shutdown requested",
    };
    state.audit = Array.from({ length: 20 }, (_, index) => ({
      id: 30 - index,
      ts_ms: 200 - index,
      login: "audit@github",
      action: "input.sensitivity",
      value: "high",
      result: `row ${index}`,
    }));
    render(<UpsControls />);
    expect(await screen.findByText("shutdown requested")).toBeInTheDocument();
    expect(screen.getAllByText("audit@github · input.sensitivity · high")).toHaveLength(20);
    fireEvent.click(screen.getByRole("button", { name: "Older audit" }));
    expect(await screen.findByText("older result")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/control/v1/audit?limit=20&before_ms=181",
      expect.anything(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Newest audit" }));
    expect(screen.getByText("row 0")).toBeInTheDocument();
  });
});
