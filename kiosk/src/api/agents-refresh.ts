import { useEffect, useRef, useState } from "react";
import { apiUrl } from "./client";
import type { components } from "./generated";

const cooldownKey = "factory-agents-next-allowed-at-ms";

export function useAgentsRefresh(revision: number, now: number, observedAt: number | null) {
  const [attempt, setAttempt] = useState<{
    revision: number;
    startedAt: number;
    deadline: number;
  } | null>(null);
  const [cooldown, setCooldown] = useState<number | null>(() => {
    try {
      const stored = Number(sessionStorage.getItem(cooldownKey));
      return Number.isSafeInteger(stored) && stored > 0 ? stored : null;
    } catch {
      return null;
    }
  });
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!attempt) return;
    const expire = () => {
      if (Date.now() < attempt.deadline) return;
      request.current?.abort();
      setAttempt(null);
      setError("Refresh didn't complete");
    };
    const timeout = setTimeout(expire, Math.max(0, attempt.deadline - Date.now()));
    document.addEventListener("visibilitychange", expire);
    window.addEventListener("pageshow", expire);
    return () => {
      clearTimeout(timeout);
      document.removeEventListener("visibilitychange", expire);
      window.removeEventListener("pageshow", expire);
    };
  }, [attempt]);
  if (cooldown === null && observedAt !== null) setCooldown(observedAt + 180_000);
  if (
    attempt &&
    (revision !== attempt.revision || (observedAt !== null && observedAt > attempt.startedAt))
  ) {
    if (now < attempt.deadline) setUpdatedAt(now);
    else setError("Refresh didn't complete");
    setAttempt(null);
  }
  const waiting = attempt !== null && revision === attempt.revision;
  const refreshing = waiting && now < attempt.deadline;
  const seconds = Math.max(
    0,
    Math.ceil(((cooldown ?? (observedAt === null ? 0 : observedAt + 180_000)) - now) / 1000),
  );
  const minutes = updatedAt === null ? 0 : Math.max(0, Math.floor((now - updatedAt) / 60_000));
  const message =
    error ??
    (waiting
      ? refreshing
        ? "Refreshing…"
        : "Refresh didn't complete"
      : updatedAt !== null
        ? minutes === 0
          ? "Updated just now"
          : `Updated ${minutes} min ago`
        : null);
  const countdown =
    !refreshing && seconds > 0
      ? `Next refresh in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
      : null;

  async function refresh() {
    if (request.current || refreshing || seconds > 0) return;
    const controller = new AbortController();
    request.current = controller;
    setError(null);
    setUpdatedAt(null);
    const startedAt = Date.now();
    setAttempt({ revision, startedAt, deadline: startedAt + 90_000 });
    try {
      const response = await fetch(apiUrl("/v1/agents/refresh"), {
        method: "POST",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (response.status !== 202 && response.status !== 429) throw new Error("Refresh failed");
      const data = (await response.json()) as
        | components["schemas"]["AgentsRefresh"]
        | components["schemas"]["AgentsRefreshCooldown"];
      if (!Number.isSafeInteger(data.next_allowed_at_ms) || data.next_allowed_at_ms <= 0)
        throw new Error("Invalid refresh response");
      setCooldown(data.next_allowed_at_ms);
      try {
        sessionStorage.setItem(cooldownKey, String(data.next_allowed_at_ms));
      } catch {
        // Storage may be unavailable; the current page still honors the deadline.
      }
      if (response.status === 429) setAttempt(null);
    } catch {
      if (!controller.signal.aborted) {
        setAttempt(null);
        setError("Refresh didn't complete");
      }
    } finally {
      request.current = null;
    }
  }
  return { refresh, refreshing, seconds, message, countdown };
}
