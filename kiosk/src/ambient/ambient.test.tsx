import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { IDLE_HOLD_MS } from "@/lib/motion";
import { parseAmbient } from "./mode";
import { startAmbientPerf } from "./perf";
import { AmbientScene } from "./scene";

describe("parseAmbient", () => {
  it("defaults to both without a known mode", () => {
    expect(parseAmbient("")).toEqual({ mode: "both", perf: false });
    expect(parseAmbient("?ambient=")).toEqual({ mode: "both", perf: false });
    expect(parseAmbient("?ambient=stars")).toEqual({ mode: "both", perf: false });
    expect(parseAmbient("?ambient=BOTH")).toEqual({ mode: "both", perf: false });
  });
  it("accepts each diagnostic mode", () => {
    for (const mode of ["both", "sweep", "none", "static"])
      expect(parseAmbient(`?ambient=${mode}`)).toEqual({ mode, perf: false });
  });
  it("turns perf on only for perf=1", () => {
    expect(parseAmbient("?ambient=both").perf).toBe(false);
    expect(parseAmbient("?perf=true").perf).toBe(false);
    expect(parseAmbient("?perf=1")).toEqual({ mode: "both", perf: true });
    expect(parseAmbient("?perf=1&ambient=static")).toEqual({ mode: "static", perf: true });
  });
});

describe("startAmbientPerf", () => {
  it("publishes frame counts and percentiles from rAF intervals", () => {
    vi.useFakeTimers();
    let callback: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => {
      callback = next;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const stop = startAmbientPerf("sweep", 10_000);
    expect(window.__ambientPerf).toMatchObject({ mode: "sweep", frames: 0, p50_ms: null });
    // 90 smooth frames, 9 janky 60 ms frames and one 120 ms frame.
    const deltas = [...Array<number>(90).fill(16.7), ...Array<number>(9).fill(60), 120];
    let now = 1000;
    callback!(now);
    for (const delta of deltas) callback!((now += delta));
    vi.advanceTimersByTime(10_000);
    expect(window.__ambientPerf).toMatchObject({
      mode: "sweep",
      frames: 100,
      long_frames_50ms: 10,
      long_frames_100ms: 1,
      p50_ms: 16.7,
      p95_ms: 60,
      p99_ms: 60,
    });
    stop();
    delete window.__ambientPerf;
  });
});

describe("AmbientScene", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const motion = (reduce: boolean) =>
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: reduce && query.includes("reduced-motion"),
      addEventListener() {},
      removeEventListener() {},
    }));

  it("animates by default and holds still under reduced motion", () => {
    motion(false);
    const moving = render(<AmbientScene mode="both" dark />);
    expect(moving.container.querySelector(".fk-backdrop")).not.toHaveClass("fk-still");
    expect(moving.container.querySelectorAll(".fk-star")).toHaveLength(50);
    moving.unmount();
    motion(true);
    const still = render(<AmbientScene mode="both" dark />);
    expect(still.container.querySelector(".fk-backdrop")).toHaveClass("fk-still");
  });

  it("pauses the scene when the page is hidden and while it is idle", () => {
    vi.useFakeTimers();
    motion(false);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const scene = render(<AmbientScene mode="both" dark />);
    const backdrop = scene.container.querySelector(".fk-backdrop");
    expect(backdrop).not.toHaveClass("fk-still");

    hidden.mockReturnValue(true);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(backdrop).toHaveClass("fk-still");

    hidden.mockReturnValue(false);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(backdrop).not.toHaveClass("fk-still");

    act(() => {
      vi.advanceTimersByTime(IDLE_HOLD_MS);
    });
    expect(backdrop).toHaveClass("fk-still");

    act(() => {
      window.dispatchEvent(new Event("pointerdown"));
    });
    expect(backdrop).not.toHaveClass("fk-still");
    scene.unmount();
  });

  it("draws no night layer or sweep where the mode omits them", () => {
    motion(false);
    const sweep = render(<AmbientScene mode="sweep" dark />);
    expect(sweep.container.querySelector(".fk-night")).toBeNull();
    expect(sweep.container.querySelector(".fk-sweep")).not.toBeNull();
    sweep.unmount();
    const none = render(<AmbientScene mode="none" dark />);
    expect(none.container.querySelector(".fk-backdrop")).toHaveClass("fk-still");
    expect(none.container.querySelector(".fk-sweep")).toBeNull();
  });

  it("publishes the mounted mode and the static sky image on :root", () => {
    motion(false);
    const root = document.documentElement;
    const scene = render(<AmbientScene mode="static" dark={false} />);
    expect(root.dataset.ambient).toBe("static");
    // The pre-blurred image uses the dawn sky until the theme turns dark.
    expect(decodeURIComponent(root.style.getPropertyValue("--fk-static-sky"))).toContain("#f2cdb5");
    scene.rerender(<AmbientScene mode="static" dark />);
    expect(decodeURIComponent(root.style.getPropertyValue("--fk-static-sky"))).toContain("#6b4c42");
    scene.unmount();
    expect(root.dataset.ambient).toBeUndefined();
    expect(root.getAttribute("style") ?? "").toBe("");
  });
});
