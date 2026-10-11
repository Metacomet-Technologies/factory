import { act, renderHook, fireEvent } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { useBuildUpdate } from "./build-update";

it("checks every 60s and on reconnect, deferring changed builds until interactions are idle", async () => {
  vi.useFakeTimers();
  const original = "a".repeat(64);
  const meta = document.createElement("meta");
  meta.name = "kiosk-build";
  meta.content = original;
  document.head.append(meta);
  const reload = vi.fn();
  vi.stubGlobal("location", { reload });
  let deployed = original;
  let failed = false;
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(failed ? "not JSON" : JSON.stringify({ build: deployed }), {
        status: failed ? 503 : 200,
      }),
    ),
  );
  const hook = renderHook(({ revision, busy }) => useBuildUpdate(revision, busy), {
    initialProps: { revision: 0, busy: false },
  });
  const tick = async (duration: number) => {
    await act(() => vi.advanceTimersByTimeAsync(duration));
  };
  try {
    await tick(250);
    expect(reload).not.toHaveBeenCalled();
    deployed = "b".repeat(64);
    await tick(59_999);
    expect(reload).not.toHaveBeenCalled();
    failed = true;
    await tick(1);
    expect(reload).not.toHaveBeenCalled();
    failed = false;
    hook.rerender({ revision: 1, busy: true });
    await tick(0);
    await tick(1000);
    expect(reload).not.toHaveBeenCalled();
    const tooltip = document.createElement("div");
    tooltip.dataset.slot = "tooltip-content";
    document.body.append(tooltip);
    hook.rerender({ revision: 1, busy: false });
    await tick(1000);
    expect(reload).not.toHaveBeenCalled();
    delete tooltip.dataset.slot;
    tooltip.setAttribute("role", "tooltip");
    await tick(1000);
    expect(reload).not.toHaveBeenCalled();
    tooltip.remove();
    const group = document.createElement("div");
    group.dataset.slot = "toggle-group";
    const toggle = document.createElement("button");
    group.append(toggle);
    document.body.append(group);
    toggle.focus();
    await tick(1000);
    expect(reload).not.toHaveBeenCalled();
    toggle.blur();
    group.remove();
    fireEvent.keyDown(document, { key: "Tab" });
    await tick(999);
    expect(reload).not.toHaveBeenCalled();
    await tick(1001);
    expect(reload).toHaveBeenCalledTimes(1);
    await tick(60_000);
    expect(reload).toHaveBeenCalledTimes(1);
    hook.unmount();
    deployed = original;
    const periodic = renderHook(() => useBuildUpdate(0, false));
    await tick(250);
    deployed = "c".repeat(64);
    await tick(59_999);
    expect(reload).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(reload).toHaveBeenCalledTimes(2);
    periodic.unmount();
  } finally {
    hook.unmount();
    meta.remove();
  }
});

it.each(["visibilitychange", "pageshow", "online"])(
  "checks on %s and preserves the interaction guard",
  async (trigger) => {
    vi.useFakeTimers();
    const meta = document.createElement("meta");
    meta.name = "kiosk-build";
    meta.content = "a".repeat(64);
    document.head.append(meta);
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    let deployed = meta.content;
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ build: deployed }))));
    vi.stubGlobal("fetch", fetch);
    const visibility = vi.spyOn(document, "visibilityState", "get");
    const hook = renderHook(() => useBuildUpdate(0, false));
    try {
      await act(() => vi.advanceTimersByTimeAsync(250));
      expect(fetch).toHaveBeenCalledTimes(1);
      deployed = "b".repeat(64);
      visibility.mockReturnValue("hidden");
      fireEvent(document, new Event("visibilitychange"));
      fireEvent(window, new PageTransitionEvent("pageshow", { persisted: false }));
      await act(() => vi.advanceTimersByTimeAsync(300));
      expect(fetch).toHaveBeenCalledTimes(1);
      fireEvent.pointerDown(document);
      visibility.mockReturnValue("visible");
      if (trigger === "visibilitychange") fireEvent(document, new Event(trigger));
      else if (trigger === "pageshow")
        fireEvent(window, new PageTransitionEvent(trigger, { persisted: true }));
      else fireEvent(window, new Event(trigger));
      await act(() => vi.advanceTimersByTimeAsync(250));
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenLastCalledWith("/version.json", {
        cache: "no-store",
        signal: expect.any(AbortSignal),
      });
      expect(reload).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(1750));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      hook.unmount();
      visibility.mockRestore();
      meta.remove();
    }
  },
);

it("debounces lifecycle event bursts and removes pending checks on unmount", async () => {
  vi.useFakeTimers();
  const meta = document.createElement("meta");
  meta.name = "kiosk-build";
  meta.content = "a".repeat(64);
  document.head.append(meta);
  const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ build: meta.content }))));
  vi.stubGlobal("fetch", fetch);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const hook = renderHook(({ revision }) => useBuildUpdate(revision, false), {
    initialProps: { revision: 0 },
  });
  try {
    await act(() => vi.advanceTimersByTimeAsync(250));
    fireEvent(document, new Event("visibilitychange"));
    await act(() => vi.advanceTimersByTimeAsync(100));
    fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true }));
    await act(() => vi.advanceTimersByTimeAsync(100));
    hook.rerender({ revision: 1 });
    fireEvent(window, new Event("online"));
    await act(() => vi.advanceTimersByTimeAsync(249));
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(fetch).toHaveBeenCalledTimes(2);
    fireEvent(window, new Event("online"));
    hook.unmount();
    fireEvent(document, new Event("visibilitychange"));
    fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true }));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    hook.unmount();
    visibility.mockRestore();
    meta.remove();
  }
});
