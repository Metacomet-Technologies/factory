import { useEffect, useMemo, useState } from "react";
import type { Endpoints } from "./types";

export const apiUrl = (path: string) =>
  `${(import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "")}${path}`;
export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

const requests = new Set<AbortController>();
export function abortApiRequests() {
  for (const controller of requests) controller.abort();
}

/**
 * `enabled: false` skips the request (for a resource the current page does not show).
 * `keepPrevious` keeps the last page on screen, marked `refreshing`, while a new query loads,
 * so paging a list dims it instead of collapsing it to a skeleton.
 */
export function useApi<K extends keyof Endpoints>(
  path: K,
  query = "",
  revision = 0,
  { enabled = true, keepPrevious = false }: { enabled?: boolean; keepPrevious?: boolean } = {},
): Resource<Endpoints[K]> & { refreshing: boolean } {
  const scope = `${path}${query}`;
  const [resource, setResource] = useState<
    Resource<Endpoints[K]> & { scope: string; revision: number }
  >({
    scope,
    revision,
    data: null,
    error: null,
    loading: true,
  });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    requests.add(controller);
    async function refresh() {
      try {
        const response = await fetch(apiUrl(path + query), { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as Endpoints[K];
        if (!controller.signal.aborted)
          setResource({ scope, revision, data, error: null, loading: false });
      } catch (error) {
        if (!controller.signal.aborted)
          setResource({
            scope,
            revision,
            data: null,
            error: error instanceof Error ? error.message : "Request failed",
            loading: false,
          });
      }
    }
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 60_000);
    return () => {
      controller.abort();
      requests.delete(controller);
      clearInterval(timer);
    };
  }, [path, query, scope, revision, enabled]);
  // A revision bump refetches the same resource: the last response (or error) stays on
  // screen, marked `refreshing`, until the new one lands, so a stream-driven refresh never
  // flashes a skeleton, collapses a card or remounts its chart. A new path or query starts
  // from loading.
  const current = resource.scope === scope;
  const refreshing = current && resource.revision !== revision;
  return useMemo(
    () =>
      !enabled
        ? { data: null, error: null, loading: false, refreshing: false }
        : current
          ? { data: resource.data, error: resource.error, loading: resource.loading, refreshing }
          : keepPrevious && resource.data !== null
            ? { data: resource.data, error: null, loading: false, refreshing: true }
            : { data: null, error: null, loading: true, refreshing: false },
    [enabled, current, keepPrevious, resource, refreshing],
  );
}
