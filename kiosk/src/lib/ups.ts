import type { Gpu, UpsPoint } from "../api/types";

// GPU history is sorted by time ascending; UPS points may be in any order.
export function upsChartData(history: UpsPoint[], gpu: Gpu["history"]) {
  return history.map((point) => {
    let low = 0;
    let high = gpu.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (gpu[middle]!.ts_ms < point.ts_ms) low = middle + 1;
      else high = middle;
    }
    const before = gpu[low - 1];
    const after = gpu[low];
    const nearest =
      before && (!after || point.ts_ms - before.ts_ms <= after.ts_ms - point.ts_ms)
        ? before
        : after;
    return {
      ts_ms: point.ts_ms,
      load: point.load_w.avg,
      input: point.input_v.avg,
      charge: point.charge_percent.avg,
      runtime: point.runtime_s == null ? null : point.runtime_s / 60,
      gpu: nearest && Math.abs(nearest.ts_ms - point.ts_ms) <= 30_000 ? nearest.power_w : undefined,
    };
  });
}

export function electricityRate(value: string): number | null {
  if (value === "") return null;
  if (!/^\d+(?:\.\d{1,6})?$/.test(value))
    throw new Error("Enter a nonnegative USD rate with at most 6 decimals.");
  const [whole, fraction = ""] = value.split(".");
  const micro = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (micro > 10_000_000n) throw new Error("Rate must not exceed $10 per kWh.");
  return Number(micro);
}

export function rateInput(micro: number | null): string {
  if (micro === null) return "";
  return `${Math.trunc(micro / 1_000_000)}.${String(micro % 1_000_000).padStart(6, "0")}`;
}
