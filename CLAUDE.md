# InvestApp

Personal investment tracker: Next.js (App Router) + TypeScript + Tailwind v4 +
Recharts + better-sqlite3 + yahoo-finance2. Manual transaction entry, automatic
market data. Home currency is EUR.

## Architecture

- `lib/db.ts` — SQLite (WAL) at `data/investapp.db` (override with
  `INVESTAPP_DB` env var — used by tests). Schema + seed + CRUD. Tables:
  `assets`, `transactions`, `price_history`, `quotes` (5-min TTL),
  `basket_components`, `meta`. Migrations: PRAGMA table_info check before
  ALTER TABLE; one-time seeds guarded by `meta` keys.
- `lib/market.ts` — yahoo-finance2 wrapper: quote cache with stale fallback,
  incremental daily-history sync (1h TTL), symbol search. FX = `EURUSD=X`.
- `lib/portfolio.ts` — all the math. FIFO lots; cost basis fixed at
  purchase-date FX; realized P&L on sells; per-lot return stats
  (total/annualized/monthly, price-based in EUR incl. fees);
  `getExplorerData()` ships full daily series (price/value/cost/realized per
  asset) and the chart client does every transform; `getCapitalData()` ships
  per-category invested capital.
- `lib/palette.ts` — validated dataviz palette. Color = **category** (fixed,
  never repaints on filter), dash pattern distinguishes assets within a
  category. Light/dark are separate validated steps, picked via matchMedia
  (`useDark`), not CSS, because Recharts needs concrete hex.
- API routes under `app/api/*` are thin wrappers; pages are thin server
  shells around client components in `components/`.
- **Basket assets** (`kind: "basket"`, e.g. Colección Argentina): a group of
  symbols bought in equal parts at each buy. Txns store price=1,
  quantity=EUR invested ("units"); each buy fixes a `compQty[]` per lot at
  that day's EUR closes; sells consume units FIFO. Per-buy stats are exact;
  the chart series is an equal-weight base-100 index (approximation
  documented in `lib/portfolio.ts`). Components editable via
  `/api/assets/[id]/components`.
- **Money-based entry**: the add-transaction form takes an amount + currency
  and derives quantity from that day's close via `/api/close`
  (`{price, currency, usdPerEur, unitValue}`); the DB stays canonical in
  quantity/price/fees, so portfolio math is untouched. Edit mode exposes the
  raw fields.
- No daily-change ("Today") numbers anywhere — Victor explicitly doesn't
  want them.

## Conventions

- Dates are `YYYY-MM-DD` strings everywhere; all date math in UTC
  (`lib/format.ts`). Percentages are ratios (0.12 = +12%) until formatting.
- Charts follow the dataviz skill: 2px lines, hairline grid, one y-axis,
  legend always, tooltip + table view as contrast relief, no dual axes.
- The €/% toggle (`useValueMode`) is global via localStorage.
- Annualized/monthly rates are suppressed in the UI for holdings < 30 days.

## Testing

`npm run build` type-checks. For runtime checks: start with
`INVESTAPP_DB=/tmp/test.db PORT=3199 npm start`, POST sample transactions to
`/api/transactions`, then verify `/api/portfolio`, `/api/series`,
`/api/capital`. Never run test data against the default `data/` database.
