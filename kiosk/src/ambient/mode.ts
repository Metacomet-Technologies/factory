/**
 * Ambient scene modes. `both` (sweep plus the night layer) is the kiosk default; the others
 * are diagnostic overrides reached with `?ambient=` (docs/design/kiosk-v2/spike.md).
 */
export const AMBIENT_MODES = ["both", "sweep", "none", "static"] as const;
export type AmbientMode = (typeof AMBIENT_MODES)[number];
export const DEFAULT_AMBIENT: AmbientMode = "both";

export function parseAmbient(search: string): { mode: AmbientMode; perf: boolean } {
  const params = new URLSearchParams(search);
  const value = params.get("ambient");
  return {
    mode: AMBIENT_MODES.find((mode) => mode === value) ?? DEFAULT_AMBIENT,
    perf: params.get("perf") === "1",
  };
}
