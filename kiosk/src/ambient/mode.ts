/** MET-237 spike modes. Anything else, including no parameter, keeps the v1 kiosk. */
export const AMBIENT_MODES = ["both", "sweep", "none", "static"] as const;
export type AmbientMode = (typeof AMBIENT_MODES)[number];

export function parseAmbient(search: string): { mode: AmbientMode | null; perf: boolean } {
  const params = new URLSearchParams(search);
  const value = params.get("ambient");
  return {
    mode: AMBIENT_MODES.find((mode) => mode === value) ?? null,
    perf: params.get("perf") === "1",
  };
}
