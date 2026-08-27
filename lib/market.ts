import YahooFinance from "yahoo-finance2";
import {
  getCachedQuote,
  getHistory,
  getMeta,
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

/**
 * Latest quotes for a set of symbols, cached in SQLite with a 5-minute TTL.
 * On fetch failure the stale cached quote is returned and the symbol is
 * reported in `stale`.
 */
export async function getQuotes(
  symbols: string[]
): Promise<{ quotes: Map<string, CachedQuote>; stale: string[] }> {
  const now = Date.now();
  const out = new Map<string, CachedQuote>();
  const stale: string[] = [];
  const toFetch: string[] = [];

  for (const s of symbols) {
    const c = getCachedQuote(s);
    if (c && now - c.fetched_at < QUOTE_TTL_MS) out.set(s, c);
    else toFetch.push(s);
  }

  await Promise.all(
    toFetch.map(async (s) => {
      try {
        const q = await yf.quote(s);
        const price = q?.regularMarketPrice;
        if (price == null || !isFinite(price)) throw new Error("no price");
        const cq: CachedQuote = {
          symbol: s,
          price,
          currency: q.currency ?? "USD",
          prev_close: q.regularMarketPreviousClose ?? null,
          fetched_at: now,
        };
        setCachedQuote(cq);
        out.set(s, cq);
      } catch {
        const c = getCachedQuote(s);
        if (c) {
          out.set(s, c);
          stale.push(s);
        } else {
          stale.push(s);
        }
      }
    })
  );

  return { quotes: out, stale };
}

/**
 * Ensure daily closes for `symbol` are cached from `fromDate` to today.
 * Refetches when the cached range starts too late or the last sync is stale.
 */
export async function ensureHistory(symbol: string, fromDate: string): Promise<void> {
  const metaKey = `hist:${symbol}`;
  const now = Date.now();
  const raw = getMeta(metaKey);
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
  const fresh = from !== null && from <= fromDate && now - syncedAt < HISTORY_TTL_MS;
  if (fresh) return;

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
      upsertHistory(symbol, rows);
      setMeta(metaKey, JSON.stringify({ from: period1, syncedAt: now }));
    }
  } catch {
    // Offline or Yahoo hiccup: keep whatever history is already cached.
  }
}

/** Cached daily closes as a date -> close map (after ensureHistory). */
export function historyMap(symbol: string): Map<string, number> {
  return new Map(getHistory(symbol).map((r) => [r.date, r.close]));
}

export async function ensureAllHistory(
  symbols: string[],
  fromDate: string
): Promise<void> {
  await Promise.all(
    [...new Set([...symbols, FX_SYMBOL])].map((s) => ensureHistory(s, fromDate))
  );
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

/** Earliest date we might ever need history from (min txn date, else 1 year back). */
export function defaultHistoryStart(minTxnDate: string | null): string {
  const yearAgo = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
  if (!minTxnDate) return yearAgo;
  return minTxnDate < yearAgo ? minTxnDate : yearAgo;
}

export { todayISO };
