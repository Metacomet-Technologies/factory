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
