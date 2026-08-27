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

## Notes

- Quotes are cached 5 minutes; daily history 1 hour. If Yahoo is
  unreachable the app falls back to the last cached prices and says so.
- Gold uses COMEX front-month (`GC=F`), quoted per **troy ounce** — Revolut
  shows grams (1 ozt = 31.1035 g). Bitcoin uses `BTC-EUR` market price;
  Revolut's displayed price includes their spread, so expect a small offset.
- Returns per lot are price-based in EUR, from your actual entry price
  including fees, so currency moves are part of the return. Annualized and
  monthly rates are hidden for lots held under 30 days.
