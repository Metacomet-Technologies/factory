import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const query = "(prefers-reduced-motion: reduce)";
const subscribe = (callback: () => void) => {
  const media = matchMedia(query);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
};
const snapshot = () => matchMedia(query).matches;

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
