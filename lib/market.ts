import YahooFinance from "yahoo-finance2";
import {
  getCachedQuotes,
  getHistories,
  getLastCloses,
  getMetaMany,
  setCachedQuote,
  setMeta,
  upsertHistory,
  type CachedQuote,
} from "./db";
import { daysBetween, todayISO } from "./format";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const QUOTE_TTL_MS = 5 * 60 * 1000;
const HISTORY_TTL_MS = 60 * 60 * 1000;

export const FX_SYMBOL = "EURUSD=X"; // USD per 1 EUR
export const GBP_FX_SYMBOL = "EURGBP=X"; // GBP per 1 EUR (money-based entry only)

/** Yahoo quotes some exchanges in minor units (LSE pence, JSE cents, TASE agorot). */
const MINOR_UNITS: Record<string, string> = { GBp: "GBP", GBX: "GBP", ZAc: "ZAR", ILA: "ILS" };

/** Yahoo price + currency in major units: 102.9 GBp -> 1.029 GBP. */
function major(price: number, currency: string | undefined): { price: number; currency: string } {
  const m = currency && MINOR_UNITS[currency];
  return m ? { price: price / 100, currency: m } : { price, currency: currency ?? "USD" };
}

const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A split as Yahoo reports it; `ratio` = old price / new price (60 for 60:1, 0.1 for 1:10). */
export interface Split {
  date: string;
  ratio: number;
}

interface HistMeta {
  from: string;
  syncedAt: number;
  splits?: Split[];
}

function parseMeta(raw: string | undefined): HistMeta | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HistMeta;
  } catch {
    return null;
  }
}

/**
 * Latest quotes for a set of symbols, cached in Postgres with a 5-minute TTL.
 * On fetch failure the stale cached quote is returned and the symbol is
 * reported in `stale`. With `cacheOnly`, any cached quote (even past TTL) is
 * used without fetching; `skipped` is true if one past TTL was used that way.
 */
export async function getQuotes(
  symbols: string[],
  cacheOnly = false
): Promise<{ quotes: Map<string, CachedQuote>; stale: string[]; skipped: boolean }> {
  const now = Date.now();
  const out = new Map<string, CachedQuote>();
  const stale: string[] = [];
  const toFetch: string[] = [];
  let skipped = false;

  const cached = await getCachedQuotes(symbols);
  for (const s of symbols) {
    const c = cached.get(s);
    if (c && (cacheOnly || now - c.fetched_at < QUOTE_TTL_MS)) {
      out.set(s, c);
      if (now - c.fetched_at >= QUOTE_TTL_MS) skipped = true;
    } else toFetch.push(s);
  }

  await Promise.all(
    toFetch.map(async (s) => {
      try {
        const quote = await yf.quote(s);
        const raw = quote?.regularMarketPrice;
        if (raw == null || !(raw > 0) || !isFinite(raw)) throw new Error("no price");
        const { price, currency } = major(raw, quote.currency);
        const prev = quote.regularMarketPreviousClose;
        const cq: CachedQuote = {
          symbol: s,
          price,
          currency,
          prev_close: prev != null ? major(prev, quote.currency).price : null,
          fetched_at: now,
        };
        await setCachedQuote(cq);
        out.set(s, cq);
      } catch {
        const c = cached.get(s);
        if (c) out.set(s, c);
        stale.push(s);
      }
    })
  );

  // A quote older than the newest cached close may predate a split that the
  // history (and so the split-adjusted holdings) already reflects.
  const old = [...out.values()].filter((c) => isoOf(c.fetched_at) < todayISO());
  if (old.length) {
    const syms = old.map((c) => c.symbol);
    const [last, metas] = await Promise.all([getLastCloses(syms), getMetaMany(syms.map((s) => `hist:${s}`))]);
    for (const c of old) {
      const l = last.get(c.symbol);
      if (!l || l.date <= isoOf(c.fetched_at)) continue;
      const splits = parseMeta(metas.get(`hist:${c.symbol}`))?.splits ?? [];
      const n = jumpSplit(c.price / l.close, l.date, splits, c.symbol);
      if (n !== 1) out.set(c.symbol, { ...c, price: c.price / n });
    }
  }

  return { quotes: out, stale, skipped };
}

/**
 * Ensure daily closes for `symbols` are cached from `fromDate` to today.
 * Refetches when the cached range starts too late or the last sync is stale.
 * With `cacheOnly`, a range that covers `fromDate` is not refreshed even past
 * TTL. Returns true if a symbol was skipped that a fresh pass would refetch.
 */
export async function ensureAllHistory(
  symbols: string[],
  fromDate: string,
  cacheOnly = false
): Promise<boolean> {
  const list = [...new Set([...symbols, FX_SYMBOL])];
  const now = Date.now();
  const metas = await getMetaMany(list.map((s) => `hist:${s}`));
  let skipped = false;

  await Promise.all(
    list.map(async (symbol) => {
      const m = parseMeta(metas.get(`hist:${symbol}`));
      const from = m?.from ?? null;
      const syncedAt = m?.syncedAt ?? 0;
      if (from !== null && from <= fromDate) {
        const fresh = now - syncedAt < HISTORY_TTL_MS;
        if (!fresh && cacheOnly) skipped = true;
        if (fresh || cacheOnly) return;
      }

      // Refetch the whole cached range so Yahoo's retroactive split
      // adjustments restate every row. (Floor: partial dates like 0002-…)
      const want = from && from <= fromDate ? from : fromDate;
      const period1 = want < EPOCH ? EPOCH : want;
      try {
        const res = await yf.chart(symbol, { period1, interval: "1d" });
        // Dates in the exchange's own timezone: Sydney bars start 23:00 UTC
        // the previous day. One row per date (Yahoo can repeat today's bar).
        const day = dayIn(res.meta?.exchangeTimezoneName);
        const byDate = new Map<string, number>();
        for (const q of res.quotes ?? []) {
          if (q.close != null && q.close > 0 && isFinite(q.close))
            byDate.set(day(q.date), major(q.close, res.meta?.currency).price);
        }
        const rows = [...byDate].map(([date, close]) => ({ date, close }));
        const splits: Split[] = (res.events?.splits ?? [])
          .filter((e) => e.numerator > 0 && e.denominator > 0)
          .map((e) => ({ date: day(e.date), ratio: e.numerator / e.denominator }));
        if (rows.length > 0) {
          await upsertHistory(symbol, rows);
          await setMeta(`hist:${symbol}`, JSON.stringify({ from: period1, syncedAt: now, splits }));
        }
      } catch {
        // Offline or Yahoo hiccup: keep whatever history is already cached.
      }
    })
  );
  return skipped;
}

export async function ensureHistory(symbol: string, fromDate: string): Promise<void> {
  await ensureAllHistory([symbol], fromDate);
}

const EPOCH = "1970-01-02";

/** Date -> YYYY-MM-DD in `timeZone` (UTC when unknown). */
function dayIn(timeZone: string | undefined): (d: Date) => string {
  let f: Intl.DateTimeFormat;
  try {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC" });
  } catch {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" });
  }
  return (d) => f.format(new Date(d));
}

/** FX pairs, indices, futures and crypto pairs (BTC-EUR) never split. */
const NEVER_SPLITS = /[=^]|-[A-Z]{3}$/;

/** Split ratios the guess accepts. Above 10 only round ones: every ratio is within 5% of some integer there. */
const SPLITS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 150, 200, 250, 300, 400, 500, 1000];

/**
 * Split implied by a day-over-day close ratio `prev/cur` dated `date`: a Yahoo
 * split event within 14 days whose ratio matches within 10% (any ratio, e.g.
 * 3:2), else — for symbols that can split — the nearest of SPLITS within 3%
 * for 2 (AAPL's real -52% day in 2000 is 2.08), 5% below 10, 8% from 10 up
 * (a quote vs a days-old close: 60:1 plus a -5% move must still read 60). 1 if none.
 */
export function jumpSplit(ratio: number, date: string, splits: Split[], symbol: string): number {
  if (!(ratio > 0) || !isFinite(ratio)) return 1;
  for (const s of splits) {
    if (Math.abs(daysBetween(s.date, date)) <= 14 && Math.abs(Math.log(ratio / s.ratio)) < 0.1) return s.ratio;
  }
  if (NEVER_SPLITS.test(symbol)) return 1;
  const lr = Math.abs(Math.log(ratio));
  const n = SPLITS.reduce((a, b) => (Math.abs(Math.log(b) - lr) < Math.abs(Math.log(a) - lr) ? b : a));
  if (Math.abs(lr - Math.log(n)) > Math.log(1 + (n === 2 ? 0.03 : n < 10 ? 0.05 : 0.08))) return 1;
  return ratio >= 1 ? n : 1 / n;
}

/**
 * Drop non-positive closes and bad ticks: a >= 1.5x jump that one of the next
 * 3 closes undoes (lands nearer the level before the jump).
 */
function dropBadTicks<T extends { close: number }>(rows: T[]): T[] {
  const ok = rows.filter((r) => r.close > 0 && isFinite(r.close));
  const out: T[] = [];
  for (let i = 0; i < ok.length; i++) {
    const c = ok[i].close;
    const prev = out[out.length - 1]?.close;
    if (prev != null && Math.abs(Math.log(c / prev)) >= Math.log(1.5)) {
      const next = ok.slice(i + 1, i + 4);
      if (next.some((r) => Math.abs(Math.log(r.close / prev)) < Math.abs(Math.log(r.close / c)))) continue;
    }
    out.push(ok[i]);
  }
  return out;
}

/**
 * Yahoo doesn't always restate history for splits (6AQQ.DE's 60:1 on
 * 2026-11-16 came through as raw closes 288.75 -> 4.78, and the event only
 * appeared dated 2026-11-23). Drop bad ticks, then restate closes before any
 * split-sized jump into the latest share basis. `latest` (a live quote newer
 * than the last close) anchors that basis, so a split between the last
 * cached close and the quote also restates the history.
 */
export function splitAdjusted<T extends { date: string; close: number }>(
  rows: T[],
  symbol: string,
  splits: Split[] = [],
  latest?: { date: string; close: number }
): T[] {
  const anchored = latest && (!rows.length || latest.date >= rows[rows.length - 1].date);
  const clean = dropBadTicks<{ date: string; close: number }>(anchored ? [...rows, latest] : rows);
  const out = clean.slice();
  let f = 1;
  for (let i = out.length - 1; i > 0; i--) {
    f /= jumpSplit(clean[i - 1].close / clean[i].close, clean[i].date, splits, symbol);
    if (f !== 1) out[i - 1] = { ...clean[i - 1], close: clean[i - 1].close * f };
  }
  if (anchored && clean[clean.length - 1] === latest) out.pop();
  return out as T[];
}

/**
 * Cached daily closes as symbol -> (date -> close) maps (after
 * ensureAllHistory): bad ticks dropped, split-adjusted to the basis of the
 * cached quote when that is newer than the last close.
 */
export async function historiesMap(symbols: string[]): Promise<Map<string, Map<string, number>>> {
  const list = [...new Set(symbols)];
  const [hist, metas, quotes] = await Promise.all([
    getHistories(list),
    getMetaMany(list.map((s) => `hist:${s}`)),
    getCachedQuotes(list),
  ]);
  const out = new Map<string, Map<string, number>>();
  for (const [s, rows] of hist) {
    const q = quotes.get(s);
    const latest = q && q.price > 0 ? { date: isoOf(q.fetched_at), close: q.price } : undefined;
    const splits = parseMeta(metas.get(`hist:${s}`))?.splits ?? [];
    out.set(s, new Map(splitAdjusted(rows, s, splits, latest).map((r) => [r.date, r.close])));
  }
  return out;
}

export interface SearchResult {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
  currency?: string;
}

export async function searchSymbols(q: string): Promise<SearchResult[]> {
  const res = await yf.search(q, { quotesCount: 10, newsCount: 0 });
  return (res.quotes ?? [])
    .map((r) => r as Record<string, unknown>)
    .filter((r) => typeof r.symbol === "string" && r.symbol)
    .map((r) => ({
      symbol: String(r.symbol),
      name: String(r.longname ?? r.shortname ?? r.symbol),
      exchange: String(r.exchDisp ?? r.exchange ?? ""),
      type: String(r.typeDisp ?? r.quoteType ?? ""),
    }));
}

/** Live currency of a symbol (used when adding an asset via search). */
export async function symbolCurrency(symbol: string): Promise<string | null> {
  try {
    const q = await yf.quote(symbol);
    return q.currency ? major(1, q.currency).currency : null;
  } catch {
    return null;
  }
}

export { todayISO };
