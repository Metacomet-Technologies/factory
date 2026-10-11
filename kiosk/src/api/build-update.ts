import { useEffect, useRef } from "react";
import { abortApiRequests } from "./client";

export function useBuildUpdate(reconnectRevision: number, rangeLoading: boolean) {
  const busy = useRef(rangeLoading);
  const changedAt = useRef<number | null>(null);
  useEffect(() => {
    busy.current = rangeLoading;
  }, [rangeLoading]);
  useEffect(() => {
    const build = document.querySelector<HTMLMetaElement>('meta[name="kiosk-build"]')?.content;
    if (!build) return; // Development has no deployed build identity.
    const controller = new AbortController();
    let changed = changedAt.current !== null;
    let reloading = false;
    let lastInteraction = 0;
    const interact = () => {
      lastInteraction = Date.now();
    };
    const reloadIfIdle = () => {
      const expired = changedAt.current !== null && Date.now() - changedAt.current >= 20_000;
      if (
        changed &&
        !reloading &&
        (!busy.current || expired) &&
        Date.now() - lastInteraction >= 1000 &&
        !document.querySelector(
          '[role="tooltip"], [data-slot="tooltip-content"], [data-slot="toggle-group"]:hover, [data-slot="toggle-group"]:focus-within',
        )
      ) {
        reloading = true;
        controller.abort();
        abortApiRequests();
        location.reload();
      }
    };
    const check = async () => {
      try {
        const response = await fetch("/version.json", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const version: unknown = await response.json();
        if (
          !controller.signal.aborted &&
          version &&
          typeof version === "object" &&
          "build" in version &&
          typeof version.build === "string" &&
          /^[a-f0-9]{64}$/.test(version.build)
        ) {
          changed = version.build !== build;
          changedAt.current = changed ? (changedAt.current ?? Date.now()) : null;
          reloadIfIdle();
        }
      } catch {
        // A failed check leaves the working dashboard in place until the next check.
      }
    };
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const scheduleCheck = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void check(), 250);
    };
    const visible = () => {
      if (document.visibilityState === "visible") scheduleCheck();
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) scheduleCheck();
    };
    document.addEventListener("pointerdown", interact);
    document.addEventListener("keydown", interact);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pageshow", restored);
    window.addEventListener("online", scheduleCheck);
    scheduleCheck();
    const poll = setInterval(scheduleCheck, 60_000);
    const idle = setInterval(reloadIfIdle, 1000);
    return () => {
      controller.abort();
      clearInterval(poll);
      clearInterval(idle);
      clearTimeout(debounce);
      document.removeEventListener("pointerdown", interact);
      document.removeEventListener("keydown", interact);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pageshow", restored);
      window.removeEventListener("online", scheduleCheck);
    };
  }, [reconnectRevision]);
}
