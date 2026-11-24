import { getCachedQuotes, listAssets, listBasketComponents, listTxns, type CachedQuote } from "./db";
import {
  ensureAllHistory,
  FX_SYMBOL,
  getQuotes,
  historiesMap,
  type Histories,
} from "./market";
import { addDays, daysBetween, todayISO } from "./format";
import { CATEGORIES } from "./types";
import type {
  Asset,
  BasketComponent,
  CapitalData,
  Category,
  ExplorerAsset,
  ExplorerData,
  Holding,
  LotStats,
  PortfolioSummary,
  ReturnStats,
  Txn,
} from "./types";

// ---------- primitives ----------

function buildAxis(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Forward-fill a sparse date->value map along an axis. Leading gap stays null. */
function ffill(axis: string[], map: Map<string, number>): (number | null)[] {
  const out: (number | null)[] = new Array(axis.length);
  let last: number | null = null;
  for (let i = 0; i < axis.length; i++) {
    const v = map.get(axis[i]);
    if (v != null) last = v;
    out[i] = last;
  }
  return out;
}

function returnStats(entry: number, current: number, fromDate: string, toDate: string): ReturnStats {
  const days = Math.max(daysBetween(fromDate, toDate), 0);
  const total = entry > 0 ? current / entry - 1 : 0;
  const d = Math.max(days, 1);
  const growth = 1 + total;
  const annual = growth > 0 ? Math.pow(growth, 365.25 / d) - 1 : -1;
  const monthly = growth > 0 ? Math.pow(growth, 30.4375 / d) - 1 : -1;
  return { days, totalPct: total, annualPct: annual, monthlyPct: monthly };
}

/** Return stats when there is no current price: holding period only. */
const unpriced = (fromDate: string, toDate: string): ReturnStats => ({
  days: Math.max(daysBetween(fromDate, toDate), 0),
  totalPct: null,
  annualPct: null,
  monthlyPct: null,
});

/** EUR value of 1 unit of `currency`, given USD-per-EUR rate. */
function eurFactor(currency: string, usdPerEur: number | null): number | null {
  if (currency === "EUR") return 1;
  if (currency === "USD") return usdPerEur && usdPerEur > 0 ? 1 / usdPerEur : null;
  return null; // unsupported quote currency
}

interface FxLookup {
  axis: string[];
  index: Map<string, number>;
  usdPerEur: (number | null)[];
  at(date: string): number | null;
}

/** Symbol -> (date -> close) maps, prefetched per request. */
type Hist = Map<string, Map<string, number>>;

const histOf = (hist: Hist, symbol: string) => hist.get(symbol) ?? new Map<string, number>();

function buildFx(from: string, to: string, hist: Hist, fallback: number | null = null): FxLookup {
  const axis = buildAxis(from, to);
  const rates = new Map(histOf(hist, FX_SYMBOL));
  // Start from the last rate before the axis (weekend first txn), so a txn's
  // FX doesn't depend on where each caller's axis begins.
  let before: number | undefined;
  for (const [d, r] of rates) {
    if (d >= from) break;
    before = r;
  }
  if (before != null && !rates.has(from)) rates.set(from, before);
  const filled = ffill(axis, rates);
  const index = new Map(axis.map((d, i) => [d, i]));
  // Backfill the leading gap with the first known rate so early txns still
  // convert; with no FX history at all, the live quote (if any).
  const firstKnown = filled.find((v) => v != null) ?? fallback;
  const usdPerEur = filled.map((v) => v ?? firstKnown);
  return {
    axis,
    index,
    usdPerEur,
    at(date: string) {
      const i = index.get(date);
      if (i == null) return date > to ? usdPerEur[usdPerEur.length - 1] : firstKnown;
      return usdPerEur[i];
    },
  };
}

/**
 * Restate txns in the history's share basis. Stored quantity/price are in the
 * trade date's basis, but history is split-adjusted to today's, so a split
 * after the trade would value n× too many/few shares. Rescale (keeping
 * quantity × price) by the splits dated after the trade, if the txn price sits
 * nearer that pre-split basis than today's; no split after it, no change.
 */
function toHistoryBasis(txns: Txn[], hist: Histories, symbol: string): Txn[] {
  const closes = histOf(hist, symbol);
  const splits = hist.splits.get(symbol) ?? [];
  return txns.map((t) => {
    const n = splits.reduce((f, s) => (s.date > t.date ? f * s.ratio : f), 1);
    if (n === 1) return t;
    let close: number | undefined;
    for (const [d, c] of closes) {
      // Txn before the cached history (e.g. a weekend buy): next close, if within a week.
      if (d > t.date) {
        if (close == null && d <= addDays(t.date, 7)) close = c;
        break;
      }
      close = c;
    }
    const r = close ? t.price / close : 1;
    return Math.abs(Math.log(r / n)) < Math.abs(Math.log(r)) ? { ...t, quantity: t.quantity * n, price: t.price / n } : t;
  });
}

const lastValue = (m: Map<string, number>): number | null => {
  let v: number | null = null;
  for (const x of m.values()) v = x;
  return v;
};

/**
 * Put today's quotes (fetched today) on top of the cached closes, so the
 * charts' last point uses the same price as the holdings page (getPortfolio).
 */
async function withTodayQuotes(hist: Hist, symbols: string[], today: string): Promise<void> {
  const quotes = await getCachedQuotes(symbols);
  for (const [s, q] of quotes) {
    if (new Date(q.fetched_at).toISOString().slice(0, 10) !== today) continue;
    if (!hist.has(s)) hist.set(s, new Map());
    hist.get(s)!.set(today, q.price);
  }
}

// ---------- FIFO timeline ----------

/** Same-day buys before sells, so a sell entered first still finds the shares. */
const buysFirst = (ts: Txn[]) => [...ts].sort((a, b) => (a.type === b.type ? 0 : a.type === "buy" ? -1 : 1));

/** Remaining below this fraction of the lot is float dust from a full sell. */
const DUST = 1e-9;

interface OpenLot {
  txnId: number;
  date: string;
  quantity: number; // original
  remaining: number;
  priceNative: number;
  unitCostEUR: number; // (price + fees/qty) converted at txn-date FX
}

interface Timeline {
  qty: number[];
  costEUR: number[]; // FIFO cost of shares still held
  realizedEUR: number[]; // cumulative realized P&L
  lots: OpenLot[]; // final state (remaining may be 0)
}

/** Walk the axis applying transactions FIFO; fx converts native->EUR at each txn date. */
function computeTimeline(
  txns: Txn[],
  axis: string[],
  currency: string,
  fx: FxLookup
): Timeline {
  const byDate = new Map<string, Txn[]>();
  for (const t of txns) {
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date)!.push(t);
  }
  const lots: OpenLot[] = [];
  const qty: number[] = new Array(axis.length);
  const costEUR: number[] = new Array(axis.length);
  const realizedEUR: number[] = new Array(axis.length);
  let q = 0;
  let cost = 0;
  let realized = 0;

  for (let i = 0; i < axis.length; i++) {
    const todays = byDate.get(axis[i]);
    if (todays) {
      for (const t of buysFirst(todays)) {
        const f = eurFactor(currency, fx.at(t.date)) ?? 0;
        if (t.type === "buy") {
          const unitCostEUR = (t.price + (t.fees || 0) / t.quantity) * f;
          lots.push({
            txnId: t.id,
            date: t.date,
            quantity: t.quantity,
            remaining: t.quantity,
            priceNative: t.price,
            unitCostEUR,
          });
        } else {
          const unitProceedsEUR = (t.price - (t.fees || 0) / t.quantity) * f;
          let toSell = t.quantity;
          for (const lot of lots) {
            if (toSell <= 0) break;
            if (lot.remaining <= 0) continue;
            const take = Math.min(lot.remaining, toSell);
            lot.remaining -= take;
            if (lot.remaining < lot.quantity * DUST) lot.remaining = 0;
            toSell -= take;
            realized += take * (unitProceedsEUR - lot.unitCostEUR);
          }
          // Any oversell beyond held quantity is ignored.
        }
      }
      // From the lots, not running sums: a closed position is exactly 0/0.
      q = 0;
      cost = 0;
      for (const lot of lots) {
        q += lot.remaining;
        cost += lot.remaining * lot.unitCostEUR;
      }
    }
    qty[i] = q;
    costEUR[i] = cost;
    realizedEUR[i] = realized;
  }
  return { qty, costEUR, realizedEUR, lots };
}

/** Cumulative EUR cash paid into buys, including fees and never reduced by sells. */
function cumulativeContributions(
  txns: Txn[],
  axis: string[],
  currency: string,
  fx: FxLookup
): number[] {
  const byDate = new Map<string, number>();
  for (const t of txns) {
    if (t.type !== "buy") continue;
    const f = eurFactor(currency, fx.at(t.date)) ?? 0;
    const paid = (t.quantity * t.price + (t.fees || 0)) * f;
    byDate.set(t.date, (byDate.get(t.date) ?? 0) + paid);
  }
  let total = 0;
  return axis.map((date) => {
    total += byDate.get(date) ?? 0;
    return total;
  });
}

// ---------- basket timeline ----------
//
// A basket buy of A € (stored as quantity=A "units" at price=1 EUR) is split
// equally across the components at that day's closes: each unit is a fixed
// mini-portfolio. Sells consume units FIFO, like any other asset.

interface BasketLot {
  txnId: number;
  date: string;
  units: number; // EUR invested at buy (= txn quantity)
  remaining: number;
  unitCostEUR: number; // 1 + fees/units
  compQty: number[]; // shares of each component bought with these units
  buyPx: (number | null)[]; // EUR price each component was bought at
}

interface BasketTimeline {
  units: number[];
  costEUR: number[];
  realizedEUR: number[];
  valueEUR: number[]; // market value of remaining units per date
  lots: BasketLot[];
}

/** Quoted currency per component symbol (from the quote cache; ADRs default to USD). */
async function componentCurrencies(symbols: string[]): Promise<Map<string, string>> {
  const quotes = await getCachedQuotes(symbols);
  return new Map(symbols.map((s) => [s, quotes.get(s)?.currency ?? "USD"]));
}

/** EUR price series for each component along the axis (ffilled daily closes). */
function componentPricesEUR(
  comps: BasketComponent[],
  axis: string[],
  fx: FxLookup,
  hist: Hist,
  curOf: Map<string, string>
): (number | null)[][] {
  return comps.map((c) => {
    const cur = curOf.get(c.symbol) ?? "USD";
    const nat = ffill(axis, histOf(hist, c.symbol));
    return nat.map((p, i) => {
      if (p == null) return null;
      // fx.at() is date-keyed: the axis here may be shorter than fx's own axis.
      const f = eurFactor(cur, fx.at(axis[i]));
      return f != null ? p * f : null;
    });
  });
}

function computeBasketTimeline(
  txns: Txn[],
  axis: string[],
  compPricesEUR: (number | null)[][],
  comps: BasketComponent[]
): BasketTimeline {
  const byDate = new Map<string, Txn[]>();
  for (const t of txns) {
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date)!.push(t);
  }
  const n = compPricesEUR.length;
  const lots: BasketLot[] = [];
  const units: number[] = new Array(axis.length);
  const costEUR: number[] = new Array(axis.length);
  const realizedEUR: number[] = new Array(axis.length);
  const valueEUR: number[] = new Array(axis.length);
  let u = 0;
  let cost = 0;
  let realized = 0;

  for (let i = 0; i < axis.length; i++) {
    const todays = byDate.get(axis[i]);
    if (todays) {
      for (const t of buysFirst(todays)) {
        if (t.type === "buy") {
          const amount = t.quantity * t.price; // EUR (price is 1 by convention)
          const unitCostEUR = t.price + (t.fees || 0) / t.quantity;
          // Buy-day price per component; a buy before its first close (weekend
          // buy at the start of the history) takes the next close within a week.
          const px = compPricesEUR.map((cp) => {
            for (let k = i; k < Math.min(i + 8, axis.length); k++) if (cp[k] != null && cp[k]! > 0) return cp[k]!;
            return null;
          });
          const avail: number[] = [];
          // Only components in the basket on the buy date (added/removed later don't rewrite it).
          for (let j = 0; j < n; j++) {
            const { since, until } = comps[j];
            if (px[j] != null && !(since && t.date < since) && !(until && t.date >= until)) avail.push(j);
          }
          const compQty = new Array<number>(n).fill(0);
          for (const j of avail) compQty[j] = amount / avail.length / px[j]!;
          lots.push({ txnId: t.id, date: t.date, units: t.quantity, remaining: t.quantity, unitCostEUR, compQty, buyPx: px });
        } else {
          const unitProceedsEUR = t.price - (t.fees || 0) / t.quantity;
          let toSell = t.quantity;
          for (const lot of lots) {
            if (toSell <= 0) break;
            if (lot.remaining <= 0) continue;
            const take = Math.min(lot.remaining, toSell);
            lot.remaining -= take;
            if (lot.remaining < lot.units * DUST) lot.remaining = 0;
            toSell -= take;
            realized += take * (unitProceedsEUR - lot.unitCostEUR);
          }
        }
      }
      u = 0;
      cost = 0;
      for (const lot of lots) {
        u += lot.remaining;
        cost += lot.remaining * lot.unitCostEUR;
      }
    }
    units[i] = u;
    costEUR[i] = cost;
    realizedEUR[i] = realized;
    let v = 0;
    for (const lot of lots) {
      if (lot.remaining <= 0) continue;
      let full = 0;
      for (let j = 0; j < n; j++) {
        // Before a component's first close, it's still worth what was paid.
        const p = compPricesEUR[j][i] ?? lot.buyPx[j];
        if (p != null) full += lot.compQty[j] * p;
      }
      v += (lot.remaining / lot.units) * full;
    }
    valueEUR[i] = v;
  }
  return { units, costEUR, realizedEUR, valueEUR, lots };
}

/**
 * Market value of 1 basket unit at `date` (EUR), given the transactions up to
 * that date. Used by the money-entry form to size basket sells. Null when the
 * basket holds nothing on that date.
 */
export async function basketUnitValueOn(
  uid: number,
  assetId: number,
  date: string
): Promise<number | null> {
  const comps = await listBasketComponents(uid, assetId, true);
  const txns = (await listTxns(uid, assetId)).filter((t) => t.date <= date);
  if (!comps.length || !txns.length) return null;
  const from = txns[0].date;
  const compSymbols = comps.map((c) => c.symbol);
  await ensureAllHistory(compSymbols, from);
  const [hist, curOf] = await Promise.all([
    historiesMap([...compSymbols, FX_SYMBOL]),
    componentCurrencies(compSymbols),
  ]);
  const axis = buildAxis(from, date);
  const fx = buildFx(from, date, hist);
  const prices = componentPricesEUR(comps, axis, fx, hist, curOf);
  const tl = computeBasketTimeline(txns, axis, prices, comps);
  const last = axis.length - 1;
  return tl.units[last] > 0 ? tl.valueEUR[last] / tl.units[last] : null;
}

// ---------- portfolio summary ----------

function basketHolding(
  asset: Asset,
  comps: BasketComponent[],
  at: Txn[],
  today: string,
  fx: FxLookup,
  fxNow: number | null,
  quotes: Map<string, CachedQuote>,
  hist: Hist,
  curOf: Map<string, string>
): Holding {
  const axis = at.length ? buildAxis(at[0].date, today) : [];
  const prices = at.length ? componentPricesEUR(comps, axis, fx, hist, curOf) : [];
  const tl = at.length ? computeBasketTimeline(at, axis, prices, comps) : null;

  // Current EUR price per component: live quote, else last cached close.
  const priceNow = comps.map((c, j) => {
    const q = quotes.get(c.symbol);
    if (q) {
      const f = eurFactor(q.currency, fxNow);
      if (f != null) return q.price * f;
    }
    const arr = prices[j] ?? [];
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
    return null;
  });

  const lots: LotStats[] = (tl?.lots ?? []).map((lot) => {
    let full = 0; // value now of the lot's original composition
    let priced = true; // every held component has a current price
    lot.compQty.forEach((q, j) => {
      const p = priceNow[j];
      if (p != null) full += q * p;
      else if (q > 0) priced = false;
    });
    const perUnit = lot.units > 0 ? full / lot.units : 0;
    const value = lot.units > 0 ? (lot.remaining / lot.units) * full : 0;
    return {
      txnId: lot.txnId,
      date: lot.date,
      quantity: lot.units,
      remaining: lot.remaining,
      priceNative: 1,
      priceEUR: lot.unitCostEUR,
      costEUR: lot.units * lot.unitCostEUR,
      valueEUR: value,
      gainEUR: priced ? value - lot.remaining * lot.unitCostEUR : null,
      stats: priced ? returnStats(lot.unitCostEUR, perUnit, lot.date, today) : unpriced(lot.date, today),
    };
  });

  const qty = tl ? tl.units[tl.units.length - 1] : 0;
  const cost = tl ? tl.costEUR[tl.costEUR.length - 1] : 0;
  const realized = tl ? tl.realizedEUR[tl.realizedEUR.length - 1] : 0;
  const value = lots.reduce((s, l) => s + l.valueEUR, 0);

  const buys = at.filter((t) => t.type === "buy");
  const lotBy = new Map(lots.map((l) => [l.txnId, l]));
  const firstBuy = buys[0] ?? null;
  const lastBuy = buys[buys.length - 1] ?? null;

  return {
    asset,
    quantity: qty,
    priceNative: qty > 0 ? value / qty : null,
    priceEUR: qty > 0 ? value / qty : null,
    valueEUR: value,
    costEUR: cost,
    unrealizedEUR: value - cost,
    unrealizedPct: cost > 0 ? (value - cost) / cost : null,
    realizedEUR: realized,
    weightPct: 0, // filled by the caller
    sinceFirstBuy: firstBuy ? lotBy.get(firstBuy.id)?.stats ?? null : null,
    sinceLastBuy: lastBuy ? lotBy.get(lastBuy.id)?.stats ?? null : null,
    firstBuyDate: firstBuy?.date ?? null,
    lastBuyDate: lastBuy?.date ?? null,
    lots,
    txnCount: at.length,
  };
}

/** Basket components per basket asset id. */
async function loadBaskets(uid: number, assets: Asset[]): Promise<Map<number, BasketComponent[]>> {
  const ids = assets.filter((a) => a.kind === "basket").map((a) => a.id);
  const comps = await Promise.all(ids.map((id) => listBasketComponents(uid, id, true)));
  return new Map(ids.map((id, i) => [id, comps[i]]));
}

export async function getPortfolio(uid: number, fresh = false): Promise<PortfolioSummary> {
  const cacheOnly = !fresh;
  const [assets, txns] = await Promise.all([listAssets(uid), listTxns(uid)]);
  const today = todayISO();
  const minDate = txns.length ? txns.reduce((m, t) => (t.date < m ? t.date : m), today) : today;

  const baskets = await loadBaskets(uid, assets);
  const compSymbols = [...new Set([...baskets.values()].flat().map((c) => c.symbol))];

  const symbols = assets.filter((a) => a.kind !== "basket").map((a) => a.symbol);
  // FX + component closes (needed back to the earliest basket buy, to split it).
  const [histSkipped, { quotes, stale, skipped }] = await Promise.all([
    ensureAllHistory([...symbols, ...compSymbols], minDate, cacheOnly),
    getQuotes([...symbols, ...compSymbols, FX_SYMBOL], cacheOnly),
  ]);
  const hist = await historiesMap([...symbols, ...compSymbols, FX_SYMBOL]);
  // Component currencies straight from the fresh quotes (fall back to USD).
  const curOf = new Map(compSymbols.map((s) => [s, quotes.get(s)?.currency ?? "USD"]));

  const fx = buildFx(minDate, today, hist, quotes.get(FX_SYMBOL)?.price ?? null);
  const fxNow = quotes.get(FX_SYMBOL)?.price ?? fx.at(today);

  const holdings: Holding[] = [];
  let totalValue = 0;
  let totalCost = 0;
  let totalRealized = 0;

  for (const asset of assets) {
    if (asset.kind === "basket") {
      const at = txns.filter((t) => t.asset_id === asset.id);
      const h = basketHolding(asset, baskets.get(asset.id) ?? [], at, today, fx, fxNow, quotes, hist, curOf);
      totalValue += h.valueEUR;
      totalCost += h.costEUR;
      totalRealized += h.realizedEUR;
      holdings.push(h);
      continue;
    }
    const at = toHistoryBasis(txns.filter((t) => t.asset_id === asset.id), hist, asset.symbol);
    // Live quote, else the last cached close (never value a holding at 0 for a missing quote).
    const priceNative = quotes.get(asset.symbol)?.price ?? lastValue(histOf(hist, asset.symbol));
    const f = eurFactor(asset.currency, fxNow);
    const priceEUR = priceNative != null && f != null ? priceNative * f : null;

    const axis = at.length ? buildAxis(at[0].date, today) : [];
    const tl = at.length ? computeTimeline(at, axis, asset.currency, fx) : null;
    const qty = tl ? tl.qty[tl.qty.length - 1] : 0;
    const cost = tl ? tl.costEUR[tl.costEUR.length - 1] : 0;
    const realized = tl ? tl.realizedEUR[tl.realizedEUR.length - 1] : 0;
    const value = priceEUR != null ? qty * priceEUR : 0;

    const buys = at.filter((t) => t.type === "buy");
    const firstBuy = buys[0] ?? null;
    const lastBuy = buys[buys.length - 1] ?? null;

    const lots: LotStats[] = (tl?.lots ?? []).map((lot) => {
      const entryEUR = lot.unitCostEUR;
      const stats = priceEUR != null ? returnStats(entryEUR, priceEUR, lot.date, today) : unpriced(lot.date, today);
      return {
        txnId: lot.txnId,
        date: lot.date,
        quantity: lot.quantity,
        remaining: lot.remaining,
        priceNative: lot.priceNative,
        priceEUR: entryEUR,
        costEUR: lot.quantity * entryEUR,
        valueEUR: priceEUR != null ? lot.remaining * priceEUR : 0,
        gainEUR: priceEUR != null ? lot.remaining * (priceEUR - entryEUR) : null,
        stats,
      };
    });
    // Same fee-inclusive entry as the per-lot table, so both views agree.
    const lotBy = new Map(lots.map((l) => [l.txnId, l]));

    totalValue += value;
    totalCost += cost;
    totalRealized += realized;

    holdings.push({
      asset,
      quantity: qty,
      priceNative,
      priceEUR,
      valueEUR: value,
      costEUR: cost,
      unrealizedEUR: value - cost,
      unrealizedPct: cost > 0 ? (value - cost) / cost : null,
      realizedEUR: realized,
      weightPct: 0, // filled below
      sinceFirstBuy: firstBuy ? lotBy.get(firstBuy.id)?.stats ?? null : null,
      sinceLastBuy: lastBuy ? lotBy.get(lastBuy.id)?.stats ?? null : null,
      firstBuyDate: firstBuy?.date ?? null,
      lastBuyDate: lastBuy?.date ?? null,
      lots,
      txnCount: at.length,
    });
  }

  for (const h of holdings) h.weightPct = totalValue > 0 ? h.valueEUR / totalValue : 0;

  const used = [...quotes.values()];
  const oldest = used.length ? Math.min(...used.map((q) => q.fetched_at)) : null;

  return {
    totalValueEUR: totalValue,
    totalCostEUR: totalCost,
    totalUnrealizedEUR: totalValue - totalCost,
    totalRealizedEUR: totalRealized,
    totalInvestedEUR: totalCost,
    holdings,
    quotesAsOf: oldest != null ? new Date(oldest).toISOString() : null,
    staleQuotes: stale,
    stale: histSkipped || skipped,
  };
}

// ---------- chart explorer data ----------

export async function getExplorerData(uid: number, fresh = false): Promise<ExplorerData> {
  const [assets, txns] = await Promise.all([listAssets(uid), listTxns(uid)]);
  const today = todayISO();
  const yearBack = addDays(today, -400);
  const minTxn = txns.length ? txns.reduce((m, t) => (t.date < m ? t.date : m), today) : today;
  const from = minTxn < yearBack ? minTxn : yearBack;

  const baskets = await loadBaskets(uid, assets);
  const compSymbols = [...new Set([...baskets.values()].flat().map((c) => c.symbol))];

  const ownSymbols = assets.filter((a) => a.kind !== "basket").map((a) => a.symbol);
  const stale = await ensureAllHistory([...ownSymbols, ...compSymbols], from, !fresh);
  const [hist, curOf] = await Promise.all([
    historiesMap([...ownSymbols, ...compSymbols, FX_SYMBOL]),
    componentCurrencies(compSymbols),
  ]);
  await withTodayQuotes(hist, [...ownSymbols, ...compSymbols, FX_SYMBOL], today);
  const axis = buildAxis(from, today);
  const fx = buildFx(from, today, hist);
  const catCounters = new Map<Category, number>();

  const out: ExplorerAsset[] = assets.map((asset) => {
    const dashIndex = catCounters.get(asset.category) ?? 0;
    catCounters.set(asset.category, dashIndex + 1);

    if (asset.kind === "basket") {
      const comps = baskets.get(asset.id) ?? [];
      const prices = componentPricesEUR(comps, axis, fx, hist, curOf);
      // Current components only; ones with no data at all would hold the index at null forever.
      const live = prices.filter((cp, j) => !comps[j].until && cp.some((p) => p != null));
      // Equal-weight index (base 100 at the first date all components trade).
      // Per-lot chart lines use this index, so they are equal-weight-at-index-
      // base rather than equal-weight-at-buy — close enough for plotting;
      // the per-buy table on the asset page is exact.
      let i0 = -1;
      for (let i = 0; i < axis.length && i0 < 0; i++) {
        if (live.length > 0 && live.every((cp) => cp[i] != null && cp[i]! > 0)) i0 = i;
      }
      const priceEUR = axis.map((_, i) => {
        if (i0 < 0 || i < i0) return null;
        let s = 0;
        for (const cp of live) s += cp[i]! / cp[i0]!;
        return (100 * s) / live.length;
      });
      const at = txns.filter((t) => t.asset_id === asset.id);
      const tl = at.length ? computeBasketTimeline(at, axis, prices, comps) : null;
      return {
        id: asset.id,
        symbol: asset.symbol,
        name: asset.name,
        short_name: asset.short_name,
        category: asset.category,
        currency: asset.currency,
        dashIndex,
        priceEUR,
        priceNative: priceEUR,
        valueEUR: tl ? tl.valueEUR : axis.map(() => null),
        costEUR: tl ? tl.costEUR : axis.map(() => null),
        contributedEUR: cumulativeContributions(at, axis, asset.currency, fx),
        realizedEUR: tl ? tl.realizedEUR : axis.map(() => null),
        // Exact per-lot economics: entry = EUR paid per unit (incl. fees),
        // unitValueEUR = the lot's frozen composition valued daily.
        lots: (tl?.lots ?? []).map((l) => ({
          txnId: l.txnId,
          date: l.date,
          quantity: l.units,
          priceNative: l.unitCostEUR,
          priceEUR: l.unitCostEUR,
          unitValueEUR: axis.map((d, i) => {
            if (d < l.date) return null;
            let s = 0;
            for (let j = 0; j < prices.length; j++) {
              const p = prices[j][i];
              if (p != null) s += l.compQty[j] * p;
            }
            return s > 0 ? s / l.units : null;
          }),
        })),
        txns: at.map((t) => ({
          id: t.id,
          type: t.type,
          date: t.date,
          quantity: t.quantity,
          price: t.price,
          fees: t.fees || 0,
        })),
      };
    }

    const at = toHistoryBasis(txns.filter((t) => t.asset_id === asset.id), hist, asset.symbol);
    const nativeHistory = new Map(histOf(hist, asset.symbol));
    // A transaction can be dated on a weekend/holiday. Use its execution
    // price when no market close exists so the series and trade marker begin
    // on the actual transaction date instead of one trading day later.
    for (const t of at) {
      if (!nativeHistory.has(t.date)) nativeHistory.set(t.date, t.price);
    }
    const priceNative = ffill(axis, nativeHistory);
    const priceEUR = priceNative.map((p, i) => {
      if (p == null) return null;
      const f = eurFactor(asset.currency, fx.usdPerEur[i]);
      return f != null ? p * f : null;
    });

    const tl = at.length ? computeTimeline(at, axis, asset.currency, fx) : null;

    const valueEUR = axis.map((_, i) => {
      if (!tl) return null;
      const p = priceEUR[i];
      return p != null ? tl.qty[i] * p : null;
    });

    return {
      id: asset.id,
      symbol: asset.symbol,
      name: asset.name,
      short_name: asset.short_name,
      category: asset.category,
      currency: asset.currency,
      dashIndex,
      priceEUR,
      priceNative,
      valueEUR,
      costEUR: tl ? tl.costEUR : axis.map(() => null),
      contributedEUR: cumulativeContributions(at, axis, asset.currency, fx),
      realizedEUR: tl ? tl.realizedEUR : axis.map(() => null),
      lots: (tl?.lots ?? []).map((l) => ({
        txnId: l.txnId,
        date: l.date,
        quantity: l.quantity,
        priceNative: l.priceNative,
        priceEUR: l.unitCostEUR,
      })),
      txns: at.map((t) => ({
        id: t.id,
        type: t.type,
        date: t.date,
        quantity: t.quantity,
        price: t.price,
        fees: t.fees || 0,
      })),
    };
  });

  return { dates: axis, assets: out, stale };
}

// ---------- capital composition data ----------

export async function getCapitalData(uid: number, fresh = false): Promise<CapitalData> {
  const [assets, txns] = await Promise.all([listAssets(uid), listTxns(uid)]);
  const today = todayISO();
  // Known categories come from CATEGORIES (single source of truth); the DB can
  // additionally hold categories outside the current union (older DBs, external
  // imports), so buckets for those are created on demand below.
  const catRecord = (make: () => number[]): Record<Category, number[]> => {
    const rec = {} as Record<Category, number[]>;
    for (const { key } of CATEGORIES) rec[key] = make();
    return rec;
  };
  const emptyCats = () => catRecord(() => []);
  if (txns.length === 0) {
    return { dates: [], byCategory: emptyCats(), valueByCategory: emptyCats(), assets: [], txnDates: [], stale: false };
  }
  const from = txns.reduce((m, t) => (t.date < m ? t.date : m), today);
  const baskets = await loadBaskets(uid, assets);
  const compSymbols = [...new Set([...baskets.values()].flat().map((c) => c.symbol))];
  const txnAssetIds = new Set(txns.map((t) => t.asset_id));
  // Market value needs each traded asset's price history, not just FX + baskets.
  const tradedSymbols = assets
    .filter((a) => a.kind !== "basket" && txnAssetIds.has(a.id))
    .map((a) => a.symbol);
  const stale = await ensureAllHistory([...tradedSymbols, ...compSymbols], from, !fresh);
  const [hist, curOf] = await Promise.all([
    historiesMap([...tradedSymbols, ...compSymbols, FX_SYMBOL]),
    componentCurrencies(compSymbols),
  ]);
  await withTodayQuotes(hist, [...tradedSymbols, ...compSymbols, FX_SYMBOL], today);
  const axis = buildAxis(from, today);
  const fx = buildFx(from, today, hist);

  const zeroSeries = () => new Array<number>(axis.length).fill(0);
  const byCategory = catRecord(zeroSeries);
  const valueByCategory = catRecord(zeroSeries);

  const assetById = new Map(assets.map((a) => [a.id, a]));

  const assetSeries: CapitalData["assets"] = [];

  for (const asset of assets) {
    const at = txns.filter((t) => t.asset_id === asset.id);
    if (!at.length) continue;
    const invested = new Array<number>(axis.length).fill(0);
    const value = new Array<number>(axis.length).fill(0);
    if (asset.kind === "basket") {
      const comps = baskets.get(asset.id) ?? [];
      const prices = componentPricesEUR(comps, axis, fx, hist, curOf);
      const tl = computeBasketTimeline(at, axis, prices, comps);
      for (let i = 0; i < axis.length; i++) {
        invested[i] = tl.costEUR[i];
        value[i] = tl.valueEUR[i];
      }
    } else {
      const tl = computeTimeline(toHistoryBasis(at, hist, asset.symbol), axis, asset.currency, fx);
      const priceNative = ffill(axis, histOf(hist, asset.symbol));
      for (let i = 0; i < axis.length; i++) {
        invested[i] = tl.costEUR[i];
        const p = priceNative[i];
        const f = p != null ? eurFactor(asset.currency, fx.usdPerEur[i]) : null;
        // Cost stands in on days with no price yet (fresh symbol, sparse history).
        value[i] = p != null && f != null ? tl.qty[i] * p * f : tl.costEUR[i];
      }
    }
    // An asset whose category isn't in CATEGORIES (open set at the DB level)
    // still gets a real bucket so its capital is counted, not dropped.
    const arr = (byCategory[asset.category] ??= zeroSeries());
    const varr = (valueByCategory[asset.category] ??= zeroSeries());
    for (let i = 0; i < axis.length; i++) {
      arr[i] += invested[i];
      varr[i] += value[i];
    }
    assetSeries.push({
      id: asset.id,
      name: asset.name,
      short_name: asset.short_name,
      symbol: asset.symbol,
      category: asset.category,
      invested,
      value,
    });
  }

  const byDate = new Map<string, CapitalData["txnDates"][number]["txns"]>();
  for (const t of txns) {
    const asset = assetById.get(t.asset_id);
    if (!asset) continue;
    const f = eurFactor(asset.currency, fx.at(t.date)) ?? 0;
    const gross = t.quantity * t.price;
    const amountEUR = (t.type === "buy" ? gross + (t.fees || 0) : gross - (t.fees || 0)) * f;
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date)!.push({
      id: t.id,
      assetId: asset.id,
      assetName: asset.name,
      symbol: asset.symbol,
      category: asset.category,
      type: t.type,
      quantity: t.quantity,
      price: t.price,
      currency: asset.currency,
      amountEUR,
    });
  }

  const txnDates = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, list]) => ({ date, txns: list }));

  return { dates: axis, byCategory, valueByCategory, assets: assetSeries, txnDates, stale };
}
