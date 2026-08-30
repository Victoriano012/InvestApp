const eurFmt = new Intl.NumberFormat("en-IE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 2,
});

const eurFmt0 = new Intl.NumberFormat("en-IE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

/**
 * en-IE renders "€1,234.56"; we want the symbol after the number
 * ("1,234.56 €", non-breaking space) while keeping en-IE grouping/decimals.
 * The sign stays with the number: "-1,234.56 €".
 */
function euroAfter(fmt: Intl.NumberFormat, v: number): string {
  const num = fmt
    .formatToParts(v)
    .filter((p) => p.type !== "currency")
    .map((p) => p.value)
    .join("")
    .trim();
  return `${num}\u00A0€`;
}

export function fmtEUR(v: number | null | undefined, compact = false): string {
  if (v == null || !isFinite(v)) return "—";
  return euroAfter(compact && Math.abs(v) >= 1000 ? eurFmt0 : eurFmt, v);
}

/** Compact axis tick: 0, 950, 10k, 14.5k, 1.2M — no symbol, no trailing zeros. */
export function fmtCompact(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return "";
  const one = (x: number, d: number) => String(Number(x.toFixed(d)));
  const abs = Math.abs(v);
  // Thresholds sit at the rounding boundary so 999.6 shows as 1k, not 1000.
  if (abs >= 999.95e6) return one(v / 1e9, 1) + "B";
  if (abs >= 999.95e3) return one(v / 1e6, 1) + "M";
  if (abs >= 999.5) return one(v / 1e3, 1) + "k";
  return one(v, abs < 10 ? 2 : 0);
}

export function fmtSignedEUR(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return "—";
  return (v > 0 ? "+" : "") + euroAfter(eurFmt, v);
}

/** v is a ratio: 0.12 -> "+12.0%" */
export function fmtPct(v: number | null | undefined, signed = true, digits = 1): string {
  if (v == null || !isFinite(v)) return "—";
  const s = (v * 100).toFixed(digits) + "%";
  return signed && v > 0 ? "+" + s : s;
}

export function fmtNum(v: number | null | undefined, maxDigits = 4): string {
  if (v == null || !isFinite(v)) return "—";
  return new Intl.NumberFormat("en-IE", { maximumFractionDigits: maxDigits }).format(v);
}

export function fmtMoney(v: number | null | undefined, currency: string): string {
  if (v == null || !isFinite(v)) return "—";
  try {
    const fmt = new Intl.NumberFormat("en-IE", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 2,
    });
    return currency === "EUR" ? euroAfter(fmt, v) : fmt.format(v);
  } catch {
    return `${fmtNum(v, 2)} ${currency}`;
  }
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const dt = new Date(d + "T00:00:00Z");
  return dt.toLocaleDateString("en-IE", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function fmtDateShort(d: string): string {
  const dt = new Date(d + "T00:00:00Z");
  return dt.toLocaleDateString("en-IE", { month: "short", year: "2-digit", timeZone: "UTC" });
}

/** Numeric day label for zoomed-in axis ticks: 10/08/26. */
export function fmtDayShort(d: string): string {
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(2, 4)}`;
}

/**
 * Axis tick formatter for a window of `spanDays` rendered as ~`ticks` ticks:
 * month labels normally, day labels once ticks would repeat the same month.
 */
export function axisDateFmt(spanDays: number, rowCount: number): (d: string) => string {
  const ticks = Math.max(1, Math.min(rowCount - 1, 12));
  return spanDays / ticks < 28 ? fmtDayShort : fmtDateShort;
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(fromISO + "T00:00:00Z");
  const b = Date.parse(toISO + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}

export function addDays(iso: string, n: number): string {
  const d = new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000);
  return d.toISOString().slice(0, 10);
}

// ---- shared x-axis time-range presets (Charts + Capital) ----

export type RangeKey = "1m" | "3m" | "6m" | "ytd" | "1y" | "all";

export const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "1m", label: "1M" },
  { key: "3m", label: "3M" },
  { key: "6m", label: "6M" },
  { key: "ytd", label: "YTD" },
  { key: "1y", label: "1Y" },
  { key: "all", label: "All" },
];

/** First date (inclusive) of a range preset; "0000-00-00" sorts before any real date. */
export function rangeStart(range: RangeKey, today: string): string {
  switch (range) {
    case "1m": return addDays(today, -31);
    case "3m": return addDays(today, -92);
    case "6m": return addDays(today, -183);
    case "1y": return addDays(today, -366);
    case "ytd": return today.slice(0, 4) + "-01-01";
    case "all": return "0000-00-00";
  }
}
