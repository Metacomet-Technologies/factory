const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const count = (value: number | null) => (value === null ? "—" : compact.format(value));
export const usd = (value: number | null) => (value === null ? "—" : dollars.format(value));
export const number = (value: number | null, unit = "") =>
  value === null
    ? "—"
    : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value)}${unit ? ` ${unit}` : ""}`;
export const ms = (value: number | null) =>
  value === null
    ? "—"
    : value < 1000
      ? `${Math.round(value)} ms`
      : value < 60_000
        ? `${number(value / 1000)} s`
        : value < 3_600_000
          ? `${number(value / 60_000)} min`
          : value < 86_400_000
            ? `${number(value / 3_600_000)} h`
            : `${number(value / 86_400_000)} d`;
export const seen = (value: number | null, now = Date.now()) =>
  value === null ? "—" : `${ms(Math.max(0, now - value))} ago`;
export const time = (value: number) =>
  new Date(value).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
