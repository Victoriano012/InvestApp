import YahooFinance from "yahoo-finance2";
import {
  getCachedQuotes,
  getHistories,
  getMetaMany,
  setCachedQuote,
  setMeta,
  upsertHistory,
  type CachedQuote,
} from "./db";
import { todayISO } from "./format";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const QUOTE_TTL_MS = 5 * 60 * 1000;
const HISTORY_TTL_MS = 60 * 60 * 1000;

export const FX_SYMBOL = "EURUSD=X"; // USD per 1 EUR
export const GBP_FX_SYMBOL = "EURGBP=X"; // GBP per 1 EUR (money-based entry only)

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
        const price = quote?.regularMarketPrice;
        if (price == null || !isFinite(price)) throw new Error("no price");
        const cq: CachedQuote = {
          symbol: s,
          price,
          currency: quote.currency ?? "USD",
          prev_close: quote.regularMarketPreviousClose ?? null,
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
      const raw = metas.get(`hist:${symbol}`);
      let from: string | null = null;
      let syncedAt = 0;
      if (raw) {
        try {
          const m = JSON.parse(raw) as { from: string; syncedAt: number };
          from = m.from;
          syncedAt = m.syncedAt;
        } catch {
          /* refetch */
        }
      }
      if (from !== null && from <= fromDate) {
        const fresh = now - syncedAt < HISTORY_TTL_MS;
        if (!fresh && cacheOnly) skipped = true;
        if (fresh || cacheOnly) return;
      }

      const period1 = from && from <= fromDate ? from : fromDate;
      try {
        const res = await yf.chart(symbol, { period1, interval: "1d" });
        const rows = (res.quotes ?? [])
          .filter((q) => q.close != null && isFinite(q.close))
          .map((q) => ({
            date: new Date(q.date).toISOString().slice(0, 10),
            close: q.close as number,
          }));
        if (rows.length > 0) {
          await upsertHistory(symbol, rows);
          await setMeta(`hist:${symbol}`, JSON.stringify({ from: period1, syncedAt: now }));
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

/**
 * n when `ratio` is within 5% of an integer split n >= 2, 1/n for a reverse
 * split, else 1. (A real one-day move of -50% or worse would be misread as a
 * split; accepted, as Yahoo missing splits is far more common.)
 */
export function splitRatio(ratio: number): number {
  if (!(ratio > 0)) return 1;
  const r = ratio >= 1 ? ratio : 1 / ratio;
  const n = Math.round(r);
  if (n < 2 || Math.abs(r / n - 1) > 0.05) return 1;
  return ratio >= 1 ? n : 1 / n;
}

/**
 * Yahoo doesn't always record splits (6AQQ.DE's 60:1 on 2026-11-16 came
 * through as raw closes 288.75 -> 4.78). Restate closes before any day-over-day
 * split-sized jump in the latest share basis.
 */
export function splitAdjusted<T extends { close: number }>(rows: T[]): T[] {
  const out = rows.slice();
  let f = 1;
  for (let i = out.length - 1; i > 0; i--) {
    f /= splitRatio(rows[i - 1].close / rows[i].close);
    if (f !== 1) out[i - 1] = { ...rows[i - 1], close: rows[i - 1].close * f };
  }
  return out;
}

/** Cached daily closes as symbol -> (date -> close) maps (after ensureAllHistory), split-adjusted. */
export async function historiesMap(symbols: string[]): Promise<Map<string, Map<string, number>>> {
  const hist = await getHistories([...new Set(symbols)]);
  const out = new Map<string, Map<string, number>>();
  for (const [s, rows] of hist) out.set(s, new Map(splitAdjusted(rows).map((r) => [r.date, r.close])));
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
    return q.currency ?? null;
  } catch {
    return null;
  }
}

export { todayISO };
