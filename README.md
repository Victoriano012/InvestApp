# InvestApp

Personal investment tracker. Transactions are entered manually (no bank/broker
connections); market prices are fetched automatically from Yahoo Finance and
cached locally. Everything is computed in EUR (USD assets converted at the
daily EURUSD rate).

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
```

For a permanent setup: `npm run build && npm start`.

Your data lives in a single SQLite file at `data/investapp.db` (git-ignored).
Back that file up and you've backed up everything.

## Pages

- **Portfolio** — total value, unrealized/realized P&L, and per-asset
  annualized returns since your first and since your most recent buy.
  Click an asset for per-lot stats (mean monthly / annualized return for
  every individual purchase). The €/% button toggles absolute vs relative
  numbers everywhere.
- **Charts** — customizable line chart: any subset of assets, metric
  (price %, price, holding value, gain € / gain %), accumulated vs
  per-period wins, one-line-per-buy mode, ✕ marks or vertical lines at your
  trades, rebase to range start or first buy, native currency, log scale,
  and a data-table view.
- **Capital** — stacked chart of invested capital split by category
  (ETFs / US stocks / Argentine stocks / gold / Bitcoin), in % or €.
  Vertical black lines mark transactions; tap one for the details.
- **Activity** — add/edit/delete transactions, and manage assets
  (add any instrument via Yahoo search by ticker, ISIN, or name).
  Transactions are entered **by money, not quantity**: type what you paid
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
the ☰ button next to the basket on the Activity page (search results there
also get a "→ add to basket" button), or create new baskets from the same
page. In charts, a basket appears as an equal-weight index (base 100).

## Notes

- Quotes are cached 5 minutes; daily history 1 hour. If Yahoo is
  unreachable the app falls back to the last cached prices and says so.
- Gold (XAU): Yahoo has no XAU spot series, so the app uses COMEX
  front-month futures (`GC=F`) as the closest proxy, quoted per **troy
  ounce** — Revolut shows grams (1 ozt = 31.1035 g). Bitcoin uses `BTC-EUR` market price;
  Revolut's displayed price includes their spread, so expect a small offset.
- Returns per lot are price-based in EUR, from your actual entry price
  including fees, so currency moves are part of the return. Annualized and
  monthly rates are hidden for lots held under 30 days.
- Money-based entry uses the **closing price** of the chosen day (closest
  earlier close if markets were shut), so derived quantities can differ
  slightly from your broker's fill — edit the transaction if you need the
  exact quantity.
