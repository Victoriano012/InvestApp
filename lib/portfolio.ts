import { getCachedQuotes, listAssets, listBasketComponents, listTxns, type CachedQuote } from "./db";
import {
  ensureAllHistory,
  FX_SYMBOL,
  getQuotes,
  historiesMap,
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

function buildFx(from: string, to: string, hist: Hist): FxLookup {
  const axis = buildAxis(from, to);
  const filled = ffill(axis, histOf(hist, FX_SYMBOL));
  const index = new Map(axis.map((d, i) => [d, i]));
  // Backfill the leading gap with the first known rate so early txns still convert.
  const firstKnown = filled.find((v) => v != null) ?? null;
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

// ---------- FIFO timeline ----------

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
      for (const t of todays) {
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
          q += t.quantity;
          cost += t.quantity * unitCostEUR;
        } else {
          const unitProceedsEUR = (t.price - (t.fees || 0) / t.quantity) * f;
          let toSell = t.quantity;
          for (const lot of lots) {
            if (toSell <= 0) break;
            if (lot.remaining <= 0) continue;
            const take = Math.min(lot.remaining, toSell);
            lot.remaining -= take;
            toSell -= take;
            q -= take;
            cost -= take * lot.unitCostEUR;
            realized += take * (unitProceedsEUR - lot.unitCostEUR);
          }
          // Any oversell beyond held quantity is ignored.
        }
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
  compPricesEUR: (number | null)[][]
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
      for (const t of todays) {
        if (t.type === "buy") {
          const amount = t.quantity * t.price; // EUR (price is 1 by convention)
          const unitCostEUR = t.price + (t.fees || 0) / t.quantity;
          const avail: number[] = [];
          for (let j = 0; j < n; j++) if (compPricesEUR[j][i] != null) avail.push(j);
          const compQty = new Array<number>(n).fill(0);
          for (const j of avail) compQty[j] = amount / avail.length / compPricesEUR[j][i]!;
          lots.push({ txnId: t.id, date: t.date, units: t.quantity, remaining: t.quantity, unitCostEUR, compQty });
          u += t.quantity;
          cost += t.quantity * unitCostEUR;
        } else {
          const unitProceedsEUR = t.price - (t.fees || 0) / t.quantity;
          let toSell = t.quantity;
          for (const lot of lots) {
            if (toSell <= 0) break;
            if (lot.remaining <= 0) continue;
            const take = Math.min(lot.remaining, toSell);
            lot.remaining -= take;
            toSell -= take;
            u -= take;
            cost -= take * lot.unitCostEUR;
            realized += take * (unitProceedsEUR - lot.unitCostEUR);
          }
        }
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
        const p = compPricesEUR[j][i];
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
  const comps = await listBasketComponents(uid, assetId);
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
  const tl = computeBasketTimeline(txns, axis, prices);
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
  const tl = at.length ? computeBasketTimeline(at, axis, prices) : null;

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
    lot.compQty.forEach((q, j) => {
      const p = priceNow[j];
      if (p != null) full += q * p;
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
      gainEUR: value - lot.remaining * lot.unitCostEUR,
      stats: returnStats(lot.unitCostEUR, perUnit, lot.date, today),
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

export async function getPortfolio(uid: number): Promise<PortfolioSummary> {
  const [assets, txns] = await Promise.all([listAssets(uid), listTxns(uid)]);
  const today = todayISO();
  const minDate = txns.length ? txns.reduce((m, t) => (t.date < m ? t.date : m), today) : today;

  const baskets = new Map<number, BasketComponent[]>();
  for (const a of assets)
    if (a.kind === "basket") baskets.set(a.id, await listBasketComponents(uid, a.id));
  const compSymbols = [...new Set([...baskets.values()].flat().map((c) => c.symbol))];

  await ensureAllHistory([], minDate); // FX
  // Component closes are needed back to the earliest basket buy (to split it).
  const basketTxns = txns.filter((t) => baskets.has(t.asset_id));
  if (basketTxns.length && compSymbols.length) {
    const from = basketTxns.reduce((m, t) => (t.date < m ? t.date : m), today);
    await ensureAllHistory(compSymbols, from);
  }

  const symbols = assets.filter((a) => a.kind !== "basket").map((a) => a.symbol);
  const { quotes, stale } = await getQuotes([...symbols, ...compSymbols, FX_SYMBOL]);
  const hist = await historiesMap([...compSymbols, FX_SYMBOL]);
  // Component currencies straight from the fresh quotes (fall back to USD).
  const curOf = new Map(compSymbols.map((s) => [s, quotes.get(s)?.currency ?? "USD"]));

  const fx = buildFx(minDate, today, hist);
  const fxNow = quotes.get(FX_SYMBOL)?.price ?? fx.at(today);

  const holdings: Holding[] = [];
  let totalValue = 0;
  let totalCost = 0;
  let totalRealized = 0;

  for (const asset of assets) {
    const at = txns.filter((t) => t.asset_id === asset.id);
    if (asset.kind === "basket") {
      const h = basketHolding(asset, baskets.get(asset.id) ?? [], at, today, fx, fxNow, quotes, hist, curOf);
      totalValue += h.valueEUR;
      totalCost += h.costEUR;
      totalRealized += h.realizedEUR;
      holdings.push(h);
      continue;
    }
    const quote = quotes.get(asset.symbol);
    const priceNative = quote?.price ?? null;
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
      const stats =
        priceEUR != null
          ? returnStats(entryEUR, priceEUR, lot.date, today)
          : { days: daysBetween(lot.date, today), totalPct: 0, annualPct: 0, monthlyPct: 0 };
      return {
        txnId: lot.txnId,
        date: lot.date,
        quantity: lot.quantity,
        remaining: lot.remaining,
        priceNative: lot.priceNative,
        priceEUR: entryEUR,
        costEUR: lot.quantity * entryEUR,
        valueEUR: priceEUR != null ? lot.remaining * priceEUR : 0,
        gainEUR: priceEUR != null ? lot.remaining * (priceEUR - entryEUR) : 0,
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
  };
}

// ---------- chart explorer data ----------

export async function getExplorerData(uid: number): Promise<ExplorerData> {
  const [assets, txns] = await Promise.all([listAssets(uid), listTxns(uid)]);
  const today = todayISO();
  const yearBack = addDays(today, -400);
  const minTxn = txns.length ? txns.reduce((m, t) => (t.date < m ? t.date : m), today) : today;
  const from = minTxn < yearBack ? minTxn : yearBack;

  const baskets = new Map<number, BasketComponent[]>();
  for (const a of assets)
    if (a.kind === "basket") baskets.set(a.id, await listBasketComponents(uid, a.id));
  const compSymbols = [...new Set([...baskets.values()].flat().map((c) => c.symbol))];

  const ownSymbols = assets.filter((a) => a.kind !== "basket").map((a) => a.symbol);
  await ensureAllHistory([...ownSymbols, ...compSymbols], from);
  const [hist, curOf] = await Promise.all([
    historiesMap([...ownSymbols, ...compSymbols, FX_SYMBOL]),
    componentCurrencies(compSymbols),
  ]);
  const axis = buildAxis(from, today);
  const fx = buildFx(from, today, hist);
  const catCounters = new Map<Category, number>();

  const out: ExplorerAsset[] = assets.map((asset) => {
    const dashIndex = catCounters.get(asset.category) ?? 0;
    catCounters.set(asset.category, dashIndex + 1);

    if (asset.kind === "basket") {
      const comps = baskets.get(asset.id) ?? [];
      const prices = componentPricesEUR(comps, axis, fx, hist, curOf);
      // Equal-weight index (base 100 at the first date all components trade).
      // Per-lot chart lines use this index, so they are equal-weight-at-index-
      // base rather than equal-weight-at-buy — close enough for plotting;
      // the per-buy table on the asset page is exact.
      let i0 = -1;
      for (let i = 0; i < axis.length && i0 < 0; i++) {
        if (prices.length > 0 && prices.every((cp) => cp[i] != null)) i0 = i;
      }
      const priceEUR = axis.map((_, i) => {
        if (i0 < 0 || i < i0) return null;
        let s = 0;
        for (const cp of prices) s += cp[i]! / cp[i0]!;
        return (100 * s) / prices.length;
      });
      const at = txns.filter((t) => t.asset_id === asset.id);
      const tl = at.length ? computeBasketTimeline(at, axis, prices) : null;
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
        })),
      };
    }

    const at = txns.filter((t) => t.asset_id === asset.id);
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
      })),
    };
  });

  return { dates: axis, assets: out };
}

// ---------- capital composition data ----------

export async function getCapitalData(uid: number): Promise<CapitalData> {
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
    return { dates: [], byCategory: emptyCats(), valueByCategory: emptyCats(), assets: [], txnDates: [] };
  }
  const from = txns.reduce((m, t) => (t.date < m ? t.date : m), today);
  const baskets = new Map<number, BasketComponent[]>();
  for (const a of assets)
    if (a.kind === "basket") baskets.set(a.id, await listBasketComponents(uid, a.id));
  const compSymbols = [...new Set([...baskets.values()].flat().map((c) => c.symbol))];
  const txnAssetIds = new Set(txns.map((t) => t.asset_id));
  // Market value needs each traded asset's price history, not just FX + baskets.
  const tradedSymbols = assets
    .filter((a) => a.kind !== "basket" && txnAssetIds.has(a.id))
    .map((a) => a.symbol);
  await ensureAllHistory([...tradedSymbols, ...compSymbols], from);
  const [hist, curOf] = await Promise.all([
    historiesMap([...tradedSymbols, ...compSymbols, FX_SYMBOL]),
    componentCurrencies(compSymbols),
  ]);
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
      const prices = componentPricesEUR(baskets.get(asset.id) ?? [], axis, fx, hist, curOf);
      const tl = computeBasketTimeline(at, axis, prices);
      for (let i = 0; i < axis.length; i++) {
        invested[i] = tl.costEUR[i];
        value[i] = tl.valueEUR[i];
      }
    } else {
      const tl = computeTimeline(at, axis, asset.currency, fx);
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

  return { dates: axis, byCategory, valueByCategory, assets: assetSeries, txnDates };
}
