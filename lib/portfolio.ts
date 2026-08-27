import { listAssets, listTxns } from "./db";
import {
  ensureAllHistory,
  ensureHistory,
  FX_SYMBOL,
  getQuotes,
  historyMap,
} from "./market";
import { addDays, daysBetween, todayISO } from "./format";
import type {
  Asset,
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

function buildFx(from: string, to: string): FxLookup {
  const axis = buildAxis(from, to);
  const filled = ffill(axis, historyMap(FX_SYMBOL));
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

// ---------- portfolio summary ----------

export async function getPortfolio(): Promise<PortfolioSummary> {
  const assets = listAssets();
  const txns = listTxns();
  const today = todayISO();
  const minDate = txns.length ? txns.reduce((m, t) => (t.date < m ? t.date : m), today) : today;

  await ensureHistory(FX_SYMBOL, minDate);
  const symbols = assets.map((a) => a.symbol);
  const { quotes, stale } = await getQuotes([...symbols, FX_SYMBOL]);

  const fx = buildFx(minDate, today);
  const fxNow = quotes.get(FX_SYMBOL)?.price ?? fx.at(today);

  const holdings: Holding[] = [];
  let totalValue = 0;
  let totalCost = 0;
  let totalRealized = 0;
  let dayChangeTotal: number | null = 0;

  const axisIdxToday = fx.axis.length - 1;
  void axisIdxToday;

  for (const asset of assets) {
    const at = txns.filter((t) => t.asset_id === asset.id);
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

    const statsFor = (b: Txn | null): ReturnStats | null => {
      if (!b || priceEUR == null) return null;
      const fb = eurFactor(asset.currency, fx.at(b.date));
      if (fb == null) return null;
      return returnStats(b.price * fb, priceEUR, b.date, today);
    };

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

    const dayPct =
      quote?.prev_close != null && quote.prev_close > 0 && priceNative != null
        ? priceNative / quote.prev_close - 1
        : null;
    const dayEUR =
      dayPct != null && priceNative != null && f != null
        ? qty * (priceNative - quote!.prev_close!) * f
        : null;

    if (dayEUR == null && qty > 0) dayChangeTotal = null;
    else if (dayChangeTotal != null && dayEUR != null) dayChangeTotal += dayEUR;

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
      dayChangePct: dayPct,
      dayChangeEUR: dayEUR,
      sinceFirstBuy: statsFor(firstBuy),
      sinceLastBuy: statsFor(lastBuy),
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
    dayChangeEUR: dayChangeTotal,
    holdings,
    quotesAsOf: oldest != null ? new Date(oldest).toISOString() : null,
    staleQuotes: stale,
  };
}

// ---------- chart explorer data ----------

export async function getExplorerData(): Promise<ExplorerData> {
  const assets = listAssets();
  const txns = listTxns();
  const today = todayISO();
  const yearBack = addDays(today, -400);
  const minTxn = txns.length ? txns.reduce((m, t) => (t.date < m ? t.date : m), today) : today;
  const from = minTxn < yearBack ? minTxn : yearBack;

  await ensureAllHistory(assets.map((a) => a.symbol), from);
  const axis = buildAxis(from, today);
  const fx = buildFx(from, today);

  const catCounters = new Map<Category, number>();

  const out: ExplorerAsset[] = assets.map((asset) => {
    const dashIndex = catCounters.get(asset.category) ?? 0;
    catCounters.set(asset.category, dashIndex + 1);

    const priceNative = ffill(axis, historyMap(asset.symbol));
    const priceEUR = priceNative.map((p, i) => {
      if (p == null) return null;
      const f = eurFactor(asset.currency, fx.usdPerEur[i]);
      return f != null ? p * f : null;
    });

    const at = txns.filter((t) => t.asset_id === asset.id);
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
      category: asset.category,
      currency: asset.currency,
      dashIndex,
      priceEUR,
      priceNative,
      valueEUR,
      costEUR: tl ? tl.costEUR : axis.map(() => null),
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

export async function getCapitalData(): Promise<CapitalData> {
  const assets = listAssets();
  const txns = listTxns();
  const today = todayISO();
  if (txns.length === 0) {
    return {
      dates: [],
      byCategory: { etf: [], us_stock: [], arg_stock: [], gold: [], crypto: [] },
      txnDates: [],
    };
  }
  const from = txns.reduce((m, t) => (t.date < m ? t.date : m), today);
  await ensureHistory(FX_SYMBOL, from);
  const axis = buildAxis(from, today);
  const fx = buildFx(from, today);

  const byCategory: Record<Category, number[]> = {
    etf: new Array(axis.length).fill(0),
    us_stock: new Array(axis.length).fill(0),
    arg_stock: new Array(axis.length).fill(0),
    gold: new Array(axis.length).fill(0),
    crypto: new Array(axis.length).fill(0),
  };

  const assetById = new Map(assets.map((a) => [a.id, a]));

  for (const asset of assets) {
    const at = txns.filter((t) => t.asset_id === asset.id);
    if (!at.length) continue;
    const tl = computeTimeline(at, axis, asset.currency, fx);
    const arr = byCategory[asset.category];
    for (let i = 0; i < axis.length; i++) arr[i] += tl.costEUR[i];
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

  return { dates: axis, byCategory, txnDates };
}
