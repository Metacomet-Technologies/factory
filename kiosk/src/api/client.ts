import { useEffect, useState } from "react";
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

export function useApi<K extends keyof Endpoints>(
  path: K,
  query = "",
  revision = 0,
): Resource<Endpoints[K]> {
  const key = `${path}${query}:${revision}`;
  const [resource, setResource] = useState<Resource<Endpoints[K]> & { key: string }>({
    key,
    data: null,
    error: null,
    loading: true,
  });
  useEffect(() => {
    const controller = new AbortController();
    requests.add(controller);
    async function refresh() {
      try {
        const response = await fetch(apiUrl(path + query), { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as Endpoints[K];
        if (!controller.signal.aborted) setResource({ key, data, error: null, loading: false });
      } catch (error) {
        if (!controller.signal.aborted)
          setResource({
            key,
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
  }, [path, query, key]);
  return resource.key === key ? resource : { data: null, error: null, loading: true };
}
