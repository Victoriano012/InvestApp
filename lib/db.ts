import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Asset, BasketComponent, Category, Txn } from "./types";

let _db: Database.Database | null = null;

const SEED: { symbol: string; name: string; category: Category; currency: string }[] = [
  { symbol: "ESPX.AS", name: "S&P 500 ESG Acc (iShares)", category: "etf", currency: "USD" },
  { symbol: "6AQQ.DE", name: "Amundi Nasdaq-100 Acc", category: "etf", currency: "EUR" },
  { symbol: "NVDA", name: "NVIDIA", category: "us_stock", currency: "USD" },
  { symbol: "AAPL", name: "Apple", category: "us_stock", currency: "USD" },
  { symbol: "GOOGL", name: "Alphabet A", category: "us_stock", currency: "USD" },
  { symbol: "AGRO", name: "Adecoagro", category: "arg_stock", currency: "USD" },
  { symbol: "VIST", name: "Vista Energy", category: "arg_stock", currency: "USD" },
  { symbol: "CRESY", name: "Cresud", category: "arg_stock", currency: "USD" },
  { symbol: "CEPU", name: "Central Puerto", category: "arg_stock", currency: "USD" },
  { symbol: "GC=F", name: "Gold (oz t)", category: "gold", currency: "USD" },
  { symbol: "BTC-EUR", name: "Bitcoin", category: "crypto", currency: "EUR" },
];

// Best-guess composition of Vesto's "Colección Argentina" (equal parts per buy).
// Not published by Vesto — edit the list on the Activity page to match the app.
const COLECCION_ARGENTINA: { symbol: string; name: string }[] = [
  { symbol: "MELI", name: "MercadoLibre" },
  { symbol: "GLOB", name: "Globant" },
  { symbol: "YPF", name: "YPF" },
  { symbol: "GGAL", name: "Grupo Financiero Galicia" },
  { symbol: "BMA", name: "Banco Macro" },
  { symbol: "SUPV", name: "Grupo Supervielle" },
  { symbol: "PAM", name: "Pampa Energía" },
  { symbol: "CEPU", name: "Central Puerto" },
  { symbol: "EDN", name: "Edenor" },
  { symbol: "TGS", name: "Transportadora de Gas del Sur" },
  { symbol: "TEO", name: "Telecom Argentina" },
  { symbol: "CRESY", name: "Cresud" },
  { symbol: "IRS", name: "IRSA" },
  { symbol: "LOMA", name: "Loma Negra" },
  { symbol: "AGRO", name: "Adecoagro" },
  { symbol: "VIST", name: "Vista Energy" },
];

export function db(): Database.Database {
  if (_db) return _db;
  const file =
    process.env.INVESTAPP_DB || path.join(process.cwd(), "data", "investapp.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  _db = new Database(file);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('etf','us_stock','arg_stock','gold','crypto')),
      currency TEXT NOT NULL DEFAULT 'USD',
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY,
      asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('buy','sell')),
      date TEXT NOT NULL,
      quantity REAL NOT NULL CHECK (quantity > 0),
      price REAL NOT NULL CHECK (price >= 0),
      fees REAL NOT NULL DEFAULT 0,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_txn_asset_date ON transactions(asset_id, date);
    CREATE TABLE IF NOT EXISTS price_history (
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      close REAL NOT NULL,
      PRIMARY KEY (symbol, date)
    );
    CREATE TABLE IF NOT EXISTS quotes (
      symbol TEXT PRIMARY KEY,
      price REAL NOT NULL,
      currency TEXT NOT NULL,
      prev_close REAL,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS basket_components (
      id INTEGER PRIMARY KEY,
      asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      UNIQUE (asset_id, symbol)
    );
  `);
  const cols = _db.prepare("PRAGMA table_info(assets)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "kind")) {
    _db.exec("ALTER TABLE assets ADD COLUMN kind TEXT NOT NULL DEFAULT 'single'");
  }
  const count = (_db.prepare("SELECT COUNT(*) AS n FROM assets").get() as { n: number }).n;
  if (count === 0) {
    const ins = _db.prepare(
      "INSERT INTO assets (symbol, name, category, currency, sort) VALUES (?, ?, ?, ?, ?)"
    );
    SEED.forEach((a, i) => ins.run(a.symbol, a.name, a.category, a.currency, i));
  }
  const seeded = _db.prepare("SELECT value FROM meta WHERE key = 'seed:coleccion-argentina'").get();
  if (!seeded) {
    const maxSort =
      (_db.prepare("SELECT MAX(sort) AS m FROM assets").get() as { m: number | null }).m ?? 0;
    const r = _db
      .prepare(
        "INSERT INTO assets (symbol, name, category, currency, sort, kind) VALUES (?, ?, ?, ?, ?, 'basket')"
      )
      .run("BASKET:COLECCION-ARGENTINA", "Colección Argentina", "arg_stock", "EUR", maxSort + 1);
    const insC = _db.prepare(
      "INSERT INTO basket_components (asset_id, symbol, name) VALUES (?, ?, ?)"
    );
    for (const c of COLECCION_ARGENTINA) insC.run(r.lastInsertRowid, c.symbol, c.name);
    _db.prepare("INSERT INTO meta (key, value) VALUES ('seed:coleccion-argentina', '1')").run();
  }
  return _db;
}

// ---- assets ----

export function listAssets(): Asset[] {
  return db()
    .prepare("SELECT * FROM assets ORDER BY sort, id")
    .all() as Asset[];
}

export function getAsset(id: number): Asset | undefined {
  return db().prepare("SELECT * FROM assets WHERE id = ?").get(id) as Asset | undefined;
}

export function createAsset(a: Omit<Asset, "id" | "sort" | "kind"> & { kind?: Asset["kind"] }): Asset {
  const maxSort =
    (db().prepare("SELECT MAX(sort) AS m FROM assets").get() as { m: number | null }).m ?? 0;
  const r = db()
    .prepare("INSERT INTO assets (symbol, name, category, currency, sort, kind) VALUES (?, ?, ?, ?, ?, ?)")
    .run(a.symbol, a.name, a.category, a.currency, maxSort + 1, a.kind ?? "single");
  return getAsset(Number(r.lastInsertRowid))!;
}

export function updateAsset(id: number, patch: Partial<Omit<Asset, "id">>): Asset | undefined {
  const cur = getAsset(id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  db()
    .prepare("UPDATE assets SET symbol = ?, name = ?, category = ?, currency = ?, sort = ? WHERE id = ?")
    .run(next.symbol, next.name, next.category, next.currency, next.sort, id);
  return getAsset(id);
}

export function deleteAsset(id: number): void {
  db().prepare("DELETE FROM assets WHERE id = ?").run(id);
}

// ---- basket components ----

export function listBasketComponents(assetId: number): BasketComponent[] {
  return db()
    .prepare("SELECT * FROM basket_components WHERE asset_id = ? ORDER BY name, id")
    .all(assetId) as BasketComponent[];
}

export function addBasketComponent(assetId: number, symbol: string, name: string): BasketComponent {
  db()
    .prepare(
      "INSERT INTO basket_components (asset_id, symbol, name) VALUES (?, ?, ?) ON CONFLICT(asset_id, symbol) DO UPDATE SET name = excluded.name"
    )
    .run(assetId, symbol, name);
  return db()
    .prepare("SELECT * FROM basket_components WHERE asset_id = ? AND symbol = ?")
    .get(assetId, symbol) as BasketComponent;
}

export function removeBasketComponent(assetId: number, symbol: string): void {
  db().prepare("DELETE FROM basket_components WHERE asset_id = ? AND symbol = ?").run(assetId, symbol);
}

// ---- transactions ----

export function listTxns(assetId?: number): Txn[] {
  if (assetId != null)
    return db()
      .prepare("SELECT * FROM transactions WHERE asset_id = ? ORDER BY date, id")
      .all(assetId) as Txn[];
  return db().prepare("SELECT * FROM transactions ORDER BY date, id").all() as Txn[];
}

export function getTxn(id: number): Txn | undefined {
  return db().prepare("SELECT * FROM transactions WHERE id = ?").get(id) as Txn | undefined;
}

export function createTxn(t: Omit<Txn, "id">): Txn {
  const r = db()
    .prepare(
      "INSERT INTO transactions (asset_id, type, date, quantity, price, fees, note) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(t.asset_id, t.type, t.date, t.quantity, t.price, t.fees ?? 0, t.note ?? null);
  return getTxn(Number(r.lastInsertRowid))!;
}

export function updateTxn(id: number, patch: Partial<Omit<Txn, "id">>): Txn | undefined {
  const cur = getTxn(id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  db()
    .prepare(
      "UPDATE transactions SET asset_id = ?, type = ?, date = ?, quantity = ?, price = ?, fees = ?, note = ? WHERE id = ?"
    )
    .run(next.asset_id, next.type, next.date, next.quantity, next.price, next.fees, next.note, id);
  return getTxn(id);
}

export function deleteTxn(id: number): void {
  db().prepare("DELETE FROM transactions WHERE id = ?").run(id);
}

// ---- price history & quote cache ----

export function getHistory(symbol: string): { date: string; close: number }[] {
  return db()
    .prepare("SELECT date, close FROM price_history WHERE symbol = ? ORDER BY date")
    .all(symbol) as { date: string; close: number }[];
}

export function upsertHistory(symbol: string, rows: { date: string; close: number }[]): void {
  const d = db();
  const stmt = d.prepare(
    "INSERT INTO price_history (symbol, date, close) VALUES (?, ?, ?) ON CONFLICT(symbol, date) DO UPDATE SET close = excluded.close"
  );
  const tx = d.transaction((rs: { date: string; close: number }[]) => {
    for (const r of rs) stmt.run(symbol, r.date, r.close);
  });
  tx(rows);
}

export interface CachedQuote {
  symbol: string;
  price: number;
  currency: string;
  prev_close: number | null;
  fetched_at: number;
}

export function getCachedQuote(symbol: string): CachedQuote | undefined {
  return db().prepare("SELECT * FROM quotes WHERE symbol = ?").get(symbol) as
    | CachedQuote
    | undefined;
}

export function setCachedQuote(q: CachedQuote): void {
  db()
    .prepare(
      "INSERT INTO quotes (symbol, price, currency, prev_close, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET price = excluded.price, currency = excluded.currency, prev_close = excluded.prev_close, fetched_at = excluded.fetched_at"
    )
    .run(q.symbol, q.price, q.currency, q.prev_close, q.fetched_at);
}

export function getMeta(key: string): string | undefined {
  const r = db().prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return r?.value;
}

export function setMeta(key: string, value: string): void {
  db()
    .prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(key, value);
}
