import { useEffect, useRef, useState } from "react";
import { apiUrl } from "./client";
import type { components } from "./generated";

export function useAgentsRefresh(revision: number, now: number) {
  const [attempt, setAttempt] = useState<{ revision: number; deadline: number } | null>(null);
  const [cooldown, setCooldown] = useState({ nextAllowed: 0, receivedAt: 0 });
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const waiting = attempt !== null && revision === attempt.revision;
  const refreshing = waiting && now < attempt.deadline;
  const seconds = Math.max(
    0,
    Math.ceil((cooldown.nextAllowed - Math.max(now, cooldown.receivedAt)) / 1000),
  );
  const message =
    error ??
    (waiting
      ? refreshing
        ? "Refreshing…"
        : "Refresh didn't complete"
      : attempt
        ? "Updated"
        : null);

  async function refresh() {
    if (request.current || refreshing || seconds > 0) return;
    const controller = new AbortController();
    request.current = controller;
    setError(null);
    setAttempt({ revision, deadline: Date.now() + 90_000 });
    const timeout = setTimeout(() => controller.abort(), 90_000);
    try {
      const response = await fetch(apiUrl("/v1/agents/refresh"), {
        method: "POST",
        signal: controller.signal,
      });
      if (response.status !== 202 && response.status !== 429) throw new Error("Refresh failed");
      const data = (await response.json()) as
        | components["schemas"]["AgentsRefresh"]
        | components["schemas"]["AgentsRefreshCooldown"];
      if (!Number.isSafeInteger(data.next_allowed_at_ms))
        throw new Error("Invalid refresh response");
      setCooldown({ nextAllowed: data.next_allowed_at_ms, receivedAt: Date.now() });
      if (response.status === 429) setAttempt(null);
    } catch {
      if (!controller.signal.aborted) {
        setAttempt(null);
        setError("Refresh failed");
      }
    } finally {
      clearTimeout(timeout);
      request.current = null;
    }
  }
  return { refresh, refreshing, seconds, message };
}
