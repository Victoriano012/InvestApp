export type Category = "etf" | "us_stock" | "arg_stock" | "gold" | "crypto";

export const CATEGORIES: { key: Category; label: string }[] = [
  { key: "etf", label: "ETFs" },
  { key: "us_stock", label: "US stocks" },
  { key: "arg_stock", label: "Argentine stocks" },
  { key: "gold", label: "Gold" },
  { key: "crypto", label: "Bitcoin" },
];

export const CATEGORY_LABEL: Record<Category, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.key, c.label])
) as Record<Category, string>;

export type AssetKind = "single" | "basket";

export interface Asset {
  id: number;
  symbol: string;
  name: string;
  category: Category;
  currency: string; // currency the symbol is quoted in (EUR for baskets)
  sort: number;
  kind: AssetKind;
}

/**
 * A basket asset (e.g. Vesto's "Colección Argentina") holds several symbols.
 * Each BUY splits the amount equally across components at that day's prices;
 * basket transactions are stored with price=1, quantity=EUR invested ("units").
 */
export interface BasketComponent {
  id: number;
  asset_id: number;
  symbol: string;
  name: string;
}

export type TxnType = "buy" | "sell";

export interface Txn {
  id: number;
  asset_id: number;
  type: TxnType;
  date: string; // YYYY-MM-DD
  quantity: number;
  price: number; // per unit, in asset currency
  fees: number; // in asset currency
  note: string | null;
}

export interface ReturnStats {
  days: number;
  totalPct: number; // e.g. 0.12 = +12%
  annualPct: number;
  monthlyPct: number;
}

export interface LotStats {
  txnId: number;
  date: string;
  quantity: number; // as bought (not reduced by sells)
  remaining: number; // still held after FIFO sells
  priceNative: number;
  priceEUR: number; // per unit at buy date
  costEUR: number; // quantity * priceEUR
  valueEUR: number; // remaining * current price EUR
  gainEUR: number; // remaining * (current - entry) EUR
  stats: ReturnStats; // price-based return since this buy, in EUR
}

export interface Holding {
  asset: Asset;
  quantity: number;
  priceNative: number | null; // latest price in asset currency
  priceEUR: number | null;
  valueEUR: number;
  costEUR: number; // FIFO cost of remaining shares, EUR
  unrealizedEUR: number;
  unrealizedPct: number | null;
  realizedEUR: number;
  weightPct: number; // share of total portfolio value
  sinceFirstBuy: ReturnStats | null;
  sinceLastBuy: ReturnStats | null;
  firstBuyDate: string | null;
  lastBuyDate: string | null;
  lots: LotStats[];
  txnCount: number;
}

export interface PortfolioSummary {
  totalValueEUR: number;
  totalCostEUR: number;
  totalUnrealizedEUR: number;
  totalRealizedEUR: number;
  totalInvestedEUR: number; // cumulative money put in (cost of current holdings)
  holdings: Holding[];
  quotesAsOf: string | null; // ISO timestamp of oldest quote used
  staleQuotes: string[]; // symbols whose quote fetch failed (using cache)
}

// ---- Chart explorer payload ----

export interface ExplorerAsset {
  id: number;
  symbol: string;
  name: string;
  category: Category;
  currency: string;
  dashIndex: number; // index within its category, for line dash pattern
  priceEUR: (number | null)[];
  priceNative: (number | null)[];
  valueEUR: (number | null)[]; // holding value per date
  costEUR: (number | null)[]; // FIFO cost of held shares per date
  realizedEUR: (number | null)[]; // cumulative realized P&L per date
  lots: {
    txnId: number;
    date: string;
    quantity: number;
    priceNative: number;
    priceEUR: number;
  }[];
  txns: { id: number; type: TxnType; date: string; quantity: number; price: number }[];
}

export interface ExplorerData {
  dates: string[]; // calendar dates, YYYY-MM-DD
  assets: ExplorerAsset[];
}

// ---- Capital composition payload ----

export interface CapitalData {
  dates: string[];
  // invested capital (EUR, FIFO cost of held shares) per category per date
  byCategory: Record<Category, number[]>;
  // market value (EUR) of held shares per category per date
  valueByCategory: Record<Category, number[]>;
  // per-asset breakdown (only assets with transactions), for the "Assets" split
  assets: {
    id: number;
    name: string;
    symbol: string;
    category: Category;
    invested: number[]; // FIFO cost EUR per date
    value: number[]; // market value EUR per date
  }[];
  txnDates: {
    date: string;
    txns: {
      id: number;
      assetId: number;
      assetName: string;
      symbol: string;
      category: Category;
      type: TxnType;
      quantity: number;
      price: number;
      currency: string;
      amountEUR: number;
    }[];
  }[];
}
