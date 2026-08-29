# InvestApp

Investment tracker. Transactions are entered manually (no bank/broker
connections); market prices are fetched automatically from Yahoo Finance and
cached. Everything is computed in EUR (USD assets converted at the
daily EURUSD rate). Multi-user: everyone signs in with Google and sees only
their own portfolio.

## Run it locally

```bash
npm install
npm run dev        # http://localhost:3000
```

Locally the database is an embedded Postgres (PGlite) persisted under
`data/pg` (git-ignored) — no server to install. Sign-in needs either real
Google OAuth env vars (see below) or the dev bypass:

```bash
AUTH_SECRET=dev AUTH_DEV_USER=you@example.com npm run dev
```

## Deploy (Vercel + Neon + Google)

1. **Vercel**: push the repo to GitHub, import it at vercel.com.
2. **Neon**: in the Vercel project → Storage → Create Database → Neon
   (free tier). This sets `DATABASE_URL` automatically.
3. **Google OAuth**: in [Google Cloud Console](https://console.cloud.google.com)
   create OAuth credentials (Web application) with redirect URI
   `https://<your-app>.vercel.app/api/auth/callback/google`.
4. **Env vars** (Vercel → Settings → Environment Variables):
   `AUTH_SECRET` (`openssl rand -base64 32`), `AUTH_GOOGLE_ID`,
   `AUTH_GOOGLE_SECRET`.
5. **Migrate existing data** (optional): copy your old SQLite file's contents
   into Neon, owned by your Google email:

   ```bash
   DATABASE_URL=postgres://... OWNER_EMAIL=you@gmail.com \
     node scripts/push-to-neon.mjs data/investapp.db
   ```

## Pages

- **Portfolio** — total value, unrealized/realized P&L, and per-asset
  annualized returns since your first and since your most recent buy (the
  buy date shown small next to each). Sortable by value, invested, gain,
  category, or buy dates (persisted). Click an asset for per-lot stats
  (mean monthly / annualized return for every individual purchase). The €/%
  button toggles absolute vs relative numbers everywhere.
- **Charts** — customizable line chart: metric (gain €, gain %, or holding
  value — gain % by default, over the full range), one-line-per-buy mode (each buy keeps the
  asset's exact line style), and ✕ marks at your trades. The asset picker
  sits inline below the chart and doubles as the legend: All/None buttons,
  per-category select-all buttons, and a line-style swatch per asset. Gain
  metrics start at 0 at the left edge of the visible range and draw nothing
  before an asset's first buy. Hovering bolds the nearest line; hovering
  near a trade lists that day's transactions in the tooltip.
- **Capital** — stacked chart of the market value you hold, split by
  category (ETFs / Bitcoin / gold / US stocks / Basket) or by
  individual asset (shades of the category color), in % or € (the €/%
  toggle sits at the far left of the options row). Group filter
  chips show any subset of categories (All/None buttons included; an empty
  selection keeps the block at its full size). Vertical lines mark transactions,
  with a darker segment over the stack band of what was traded; hovering
  near one lists that day's transactions, tap for full details. The hover
  list bolds whichever band the cursor is inside.

Both charts share a range control: presets (1M…All) and start/end calendar
pickers where transaction dates carry a dot in the day, month, and year
views (hover a day's dot for the transactions, click the header to jump by
year/month). Zooming happens directly on the plot: drag a region to zoom
in on it; double-click to reset to the last preset/calendar range you set.
Axis labels switch from months to days once month labels would repeat. In
both charts, "All" starts at the first day with anything selected on the
plot (first buy among selected assets / first capital among selected groups).
- **Activity** — add/edit/delete transactions, and manage assets: search
  Yahoo by ticker, ISIN, or name and click a result to add it — the
  category is inferred from Yahoo's instrument type. Assets can carry an
  optional short name (✎ on an asset opens an inline name/short-name
  editor), used in the chart legends, tooltips, and calendar hovers, and,
  on phones, everywhere in the UI. Transactions are entered **by money, not quantity**: type what you paid
  (or received), pick the currency (defaults to the asset's; EUR↔USD converts
  at that day's rate), and the app derives the quantity from that day's
  closing price. Editing a transaction still exposes the raw
  quantity/price/fees if you want exact figures.

## Basket assets

A basket is a group of instruments bought together in **equal parts at the
moment of each buy** (like Vesto's "Colecciones"). Buys are recorded in EUR;
each buy locks in the component quantities at that day's prices, so per-buy
returns are exact. Sells consume buys FIFO. The seeded **Colección
Argentina** ships with a best-guess list of 16 Argentine ADRs — edit it via
the ☰ button next to the basket on the Activity page (components are added
via a search bar inside the editor), or create new baskets from the same
page (they land in the "Basket" category). In charts, a basket's aggregate line is an equal-weight index
(base 100); per-buy lines use the buy's exact frozen composition.

## Notes

- Quotes are cached 5 minutes; daily history 1 hour. If Yahoo is
  unreachable the app falls back to the last cached prices and says so.
- Gold (XAU): Yahoo has no XAU spot series, so the app uses PAX Gold
  (`PAXG-USD`, a token redeemable for 1 fine troy ounce of vaulted gold)
  which tracks XAU/USD spot, quoted per **troy ounce** — Revolut shows
  grams (1 ozt = 31.1035 g). (Previously `GC=F` futures, which carry a
  small contango premium over spot.) Bitcoin uses `BTC-EUR` market price;
  Revolut's displayed price includes their spread, so expect a small offset.
- Returns per lot are price-based in EUR, from your actual entry price
  including fees, so currency moves are part of the return. Annualized and
  monthly rates are hidden for lots held under 30 days.
- Money-based entry uses the **closing price** of the chosen day (closest
  earlier close if markets were shut), so derived quantities can differ
  slightly from your broker's fill — edit the transaction if you need the
  exact quantity.

Coded using Claude.
