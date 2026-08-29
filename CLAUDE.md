# InvestApp

Investment tracker: Next.js (App Router) + TypeScript + Tailwind v4 +
Recharts + Postgres + yahoo-finance2. Manual transaction entry, automatic
market data. Home currency is EUR. Multi-user: Google sign-in (Auth.js v5),
every user sees only their own portfolio. Deployed on Vercel with Neon
Postgres.

## Architecture

- `lib/db.ts` — async Postgres layer: Neon serverless driver when
  `DATABASE_URL` is set, embedded PGlite at `data/pg` otherwise (override dir
  with `INVESTAPP_PG_DIR` — used by tests). Schema (auto-created) + CRUD.
  Tables: `users`, `assets` (user_id, UNIQUE(user_id, symbol)),
  `transactions`, `basket_components`, and shared market-data caches
  `price_history`, `quotes` (5-min TTL), `meta`. `assets`/`transactions`
  CRUD is scoped by user id; price/quote/meta caches are global.
- `auth.ts` — Auth.js v5 with Google provider, JWT sessions; `jwt` callback
  maps the Google email to a `users` row (`getOrCreateUser`), `session.uid`
  carries the db user id. `currentUserId()` is what routes call;
  `AUTH_DEV_USER=<email>` bypasses Google for local dev/tests. `proxy.ts`
  gates everything: pages redirect to sign-in, APIs get 401
  (`/api/auth/*` and static assets excluded). New users start with an
  empty portfolio; `scripts/push-to-neon.mjs` imports a legacy SQLite file
  under `OWNER_EMAIL`.
- `lib/market.ts` — yahoo-finance2 wrapper: quote cache with stale fallback,
  incremental daily-history sync (1h TTL, batched via `ensureAllHistory` +
  `historiesMap`), symbol search. FX = `EURUSD=X`.
- `lib/portfolio.ts` — all the math, per user. FIFO lots; cost basis fixed
  at purchase-date FX; realized P&L on sells; per-lot return stats
  (total/annualized/monthly, price-based in EUR incl. fees). Top-level
  functions prefetch history/quote maps once and thread them through the
  (synchronous) math helpers — don't add per-symbol queries inside loops.
  `getExplorerData()` ships full daily series and the chart client does
  every transform; `getCapitalData()` ships per-category invested capital.
- `lib/palette.ts` — validated dataviz palette. Color = **category** (fixed,
  never repaints on filter), dash pattern distinguishes assets within a
  category. Light/dark are separate validated steps, picked via matchMedia
  (`useDark`), not CSS, because Recharts needs concrete hex.
- API routes under `app/api/*` are thin wrappers: resolve `currentUserId()`,
  401 when null, pass uid down; pages are thin server shells around client
  components in `components/`.
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

- Dates are `YYYY-MM-DD` strings everywhere (TEXT columns); all date math in
  UTC (`lib/format.ts`). Percentages are ratios (0.12 = +12%) until
  formatting.
- Charts follow the dataviz skill: 2px lines, hairline grid, one y-axis,
  legend always, tooltip + table view as contrast relief, no dual axes.
- The €/% toggle (`useValueMode`) is global via localStorage.
- Annualized/monthly rates are suppressed in the UI for holdings < 30 days.

## Testing

`npm run build` type-checks. For runtime checks: start with
`INVESTAPP_PG_DIR=/tmp/pgtest AUTH_SECRET=test AUTH_DEV_USER=test@local
PORT=3199 npm start`, POST sample transactions to `/api/transactions`, then
verify `/api/portfolio`, `/api/series`, `/api/capital`. Never point tests at
the default `data/pg` directory or at the production `DATABASE_URL`.
Local prod-mode auth testing additionally needs `AUTH_TRUST_HOST=true`
(automatic on Vercel).

## Deploy

Vercel project → Neon via Vercel Storage (sets `DATABASE_URL`); env vars
`AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` (Google OAuth redirect
URI: `https://<domain>/api/auth/callback/google`). One-time data import:
`DATABASE_URL=... OWNER_EMAIL=... node scripts/push-to-neon.mjs <sqlite file>`.
