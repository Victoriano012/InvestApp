# InvestApp

Personal investment tracker: Next.js (App Router) + TypeScript + Tailwind v4 +
Recharts + better-sqlite3 + yahoo-finance2. Manual transaction entry, automatic
market data. Home currency is EUR.

## Architecture

- `lib/db.ts` — SQLite (WAL) at `data/investapp.db` (override with
  `INVESTAPP_DB` env var — used by tests). Schema + seed + CRUD. Tables:
  `assets`, `transactions`, `price_history`, `quotes` (5-min TTL), `meta`.
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
