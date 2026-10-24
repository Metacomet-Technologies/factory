import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const query = "(prefers-reduced-motion: reduce)";
const subscribe = (callback: () => void) => {
  const media = matchMedia(query);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
};
const snapshot = () => matchMedia(query).matches;

/**
 * Infinite scene motion (sweep, aurora, stars) pauses while the page is hidden and
 * while a visible page has had no pointer, key or focus activity for this long.
 * A live pulse is a steady glow, not another infinite animation: one running
 * animation is enough to keep Chrome's GPU process compositing the frosted panels.
 */
export const IDLE_HOLD_MS = 2_000;

/** True while the page is hidden, or visible and quiet past `IDLE_HOLD_MS`. */
export function useSceneHeld(enabled: boolean) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hold = () => {
      clearTimeout(timer);
      setHeld(document.hidden || document.visibilityState === "hidden");
      if (!document.hidden) timer = setTimeout(() => setHeld(true), IDLE_HOLD_MS);
    };
    hold();
    document.addEventListener("visibilitychange", hold);
    window.addEventListener("pointerdown", hold);
    window.addEventListener("keydown", hold);
    window.addEventListener("focusin", hold);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", hold);
      window.removeEventListener("pointerdown", hold);
      window.removeEventListener("keydown", hold);
      window.removeEventListener("focusin", hold);
    };
  }, [enabled]);
  return enabled && held;
}

/** True when the user asked for reduced motion; charts and tweens must then render final state. */
export function useReducedMotion() {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

/**
 * Event pulse: fresh data landed. The Live chip throws one ripple and every `.fk-hero`
 * number flashes once over `--dur-event`. Pure CSS; under reduced motion the keyframes are
 * disabled, so the ripple is removed at once and the flash class is a no-op.
 */
export function pulse(root: ParentNode = document) {
  if (snapshot()) return;
  for (const live of root.querySelectorAll(".live-indicator")) {
    const ripple = document.createElement("span");
    ripple.className = "fk-ripple";
    ripple.setAttribute("aria-hidden", "true");
    ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
    live.append(ripple);
  }
  for (const hero of root.querySelectorAll<HTMLElement>(".fk-hero .stat-value")) {
    hero.classList.remove("fk-flash");
    void hero.offsetWidth; // restart the keyframes when a pulse lands mid-flash
    hero.classList.add("fk-flash");
    hero.addEventListener("animationend", () => hero.classList.remove("fk-flash"), { once: true });
  }
}

/**
 * Tweens a numeric value toward `target` over `duration` ms with ease-out.
 * Null targets, the first value and reduced motion render immediately (no tween from a stale number).
 */
export function useAnimatedNumber(target: number | null | undefined, duration = 600) {
  const reduced = useReducedMotion();
  const [value, setValue] = useState<number | null>(target ?? null);
  const current = useRef(value);
  useEffect(() => {
    current.current = value;
  }, [value]);
  useEffect(() => {
    const from = current.current;
    if (target == null || from == null || reduced || typeof requestAnimationFrame !== "function") {
      setValue(target ?? null);
      return;
    }
    const delta = target - from;
    if (delta === 0) return;
    const start = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min(1, (now - start) / duration);
      setValue(from + delta * (1 - (1 - t) ** 3));
      if (t < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, duration, reduced]);
  return target == null ? null : value;
}
