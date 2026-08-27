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

export function fmtEUR(v: number | null | undefined, compact = false): string {
  if (v == null || !isFinite(v)) return "—";
  return compact && Math.abs(v) >= 1000 ? eurFmt0.format(v) : eurFmt.format(v);
}

export function fmtSignedEUR(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return "—";
  return (v > 0 ? "+" : "") + eurFmt.format(v);
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
    return new Intl.NumberFormat("en-IE", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(v);
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
