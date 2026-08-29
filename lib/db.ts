import path from "node:path";
import type { Asset, BasketComponent, Txn } from "./types";

// Postgres: Neon over HTTP in production (DATABASE_URL), embedded PGlite for
// local dev/tests (persisted under data/pg, override with INVESTAPP_PG_DIR).

type Row = Record<string, unknown>;
type Query = (text: string, params?: unknown[]) => Promise<Row[]>;

// Shared by the app and scripts/push-to-neon.mjs (keep the copies in sync).
export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS assets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    short_name TEXT,
    category TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    sort INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'single',
    UNIQUE (user_id, symbol)
  )`,
  `CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('buy','sell')),
    date TEXT NOT NULL,
    quantity DOUBLE PRECISION NOT NULL CHECK (quantity > 0),
    price DOUBLE PRECISION NOT NULL CHECK (price >= 0),
    fees DOUBLE PRECISION NOT NULL DEFAULT 0,
    note TEXT,
    paid_amount DOUBLE PRECISION,
    paid_currency TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_txn_asset_date ON transactions(asset_id, date)`,
  `CREATE TABLE IF NOT EXISTS price_history (
    symbol TEXT NOT NULL,
    date TEXT NOT NULL,
    close DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (symbol, date)
  )`,
  `CREATE TABLE IF NOT EXISTS quotes (
    symbol TEXT PRIMARY KEY,
    price DOUBLE PRECISION NOT NULL,
    currency TEXT NOT NULL,
    prev_close DOUBLE PRECISION,
    fetched_at DOUBLE PRECISION NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS basket_components (
    id SERIAL PRIMARY KEY,
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    UNIQUE (asset_id, symbol)
  )`,
];

// Cached on globalThis so dev-mode module re-evaluation reuses the connection
// (PGlite allows one instance per data dir).
const g = globalThis as { __investappDb?: Promise<Query> };

async function connect(): Promise<Query> {
  const url = process.env.DATABASE_URL;
  let q: Query;
  if (url) {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(url);
    q = (text, params = []) => sql.query(text, params) as Promise<Row[]>;
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = process.env.INVESTAPP_PG_DIR || path.join(process.cwd(), "data", "pg");
    const pg = new PGlite(dir);
    q = async (text, params = []) => (await pg.query(text, params)).rows as Row[];
  }
  for (const stmt of SCHEMA) await q(stmt);
  return q;
}

function q(text: string, params?: unknown[]): Promise<Row[]> {
  if (!g.__investappDb) g.__investappDb = connect();
  return g.__investappDb.then((fn) => fn(text, params));
}

async function one<T>(text: string, params?: unknown[]): Promise<T | undefined> {
  return (await q(text, params))[0] as T | undefined;
}

// ---- users ----

export async function getOrCreateUser(email: string, name: string | null): Promise<number> {
  const r = await one<{ id: number }>(
    `INSERT INTO users (email, name) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET name = COALESCE(EXCLUDED.name, users.name)
     RETURNING id`,
    [email.toLowerCase(), name]
  );
  return r!.id;
}

// ---- assets (scoped to the logged-in user) ----

export async function listAssets(uid: number): Promise<Asset[]> {
  return (await q("SELECT * FROM assets WHERE user_id = $1 ORDER BY sort, id", [uid])) as unknown as Asset[];
}

export async function getAsset(uid: number, id: number): Promise<Asset | undefined> {
  return one<Asset>("SELECT * FROM assets WHERE user_id = $1 AND id = $2", [uid, id]);
}

export async function createAsset(
  uid: number,
  a: Omit<Asset, "id" | "sort" | "kind"> & { kind?: Asset["kind"] }
): Promise<Asset> {
  const r = await one<Asset>(
    `INSERT INTO assets (user_id, symbol, name, short_name, category, currency, sort, kind)
     VALUES ($1, $2, $3, $4, $5, $6,
       (SELECT COALESCE(MAX(sort), 0) + 1 FROM assets WHERE user_id = $1), $7)
     RETURNING *`,
    [uid, a.symbol, a.name, a.short_name ?? null, a.category, a.currency, a.kind ?? "single"]
  );
  return r!;
}

export async function updateAsset(
  uid: number,
  id: number,
  patch: Partial<Omit<Asset, "id">>
): Promise<Asset | undefined> {
  const cur = await getAsset(uid, id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  return one<Asset>(
    `UPDATE assets SET symbol = $1, name = $2, short_name = $3, category = $4, currency = $5, sort = $6
     WHERE user_id = $7 AND id = $8 RETURNING *`,
    [next.symbol, next.name, next.short_name ?? null, next.category, next.currency, next.sort, uid, id]
  );
}

export async function deleteAsset(uid: number, id: number): Promise<void> {
  await q("DELETE FROM assets WHERE user_id = $1 AND id = $2", [uid, id]);
}

// ---- basket components (ownership checked by callers via getAsset) ----

export async function listBasketComponents(assetId: number): Promise<BasketComponent[]> {
  return (await q(
    "SELECT * FROM basket_components WHERE asset_id = $1 ORDER BY name, id",
    [assetId]
  )) as unknown as BasketComponent[];
}

export async function addBasketComponent(
  assetId: number,
  symbol: string,
  name: string
): Promise<BasketComponent> {
  const r = await one<BasketComponent>(
    `INSERT INTO basket_components (asset_id, symbol, name) VALUES ($1, $2, $3)
     ON CONFLICT (asset_id, symbol) DO UPDATE SET name = EXCLUDED.name RETURNING *`,
    [assetId, symbol, name]
  );
  return r!;
}

export async function removeBasketComponent(assetId: number, symbol: string): Promise<void> {
  await q("DELETE FROM basket_components WHERE asset_id = $1 AND symbol = $2", [assetId, symbol]);
}

// ---- transactions (scoped through asset ownership) ----

export async function listTxns(uid: number, assetId?: number): Promise<Txn[]> {
  if (assetId != null)
    return (await q(
      `SELECT t.* FROM transactions t JOIN assets a ON a.id = t.asset_id
       WHERE a.user_id = $1 AND t.asset_id = $2 ORDER BY t.date, t.id`,
      [uid, assetId]
    )) as unknown as Txn[];
  return (await q(
    `SELECT t.* FROM transactions t JOIN assets a ON a.id = t.asset_id
     WHERE a.user_id = $1 ORDER BY t.date, t.id`,
    [uid]
  )) as unknown as Txn[];
}

export async function getTxn(uid: number, id: number): Promise<Txn | undefined> {
  return one<Txn>(
    `SELECT t.* FROM transactions t JOIN assets a ON a.id = t.asset_id
     WHERE a.user_id = $1 AND t.id = $2`,
    [uid, id]
  );
}

export async function createTxn(t: Omit<Txn, "id">): Promise<Txn> {
  const r = await one<Txn>(
    `INSERT INTO transactions (asset_id, type, date, quantity, price, fees, note, paid_amount, paid_currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      t.asset_id, t.type, t.date, t.quantity, t.price, t.fees ?? 0, t.note ?? null,
      t.paid_amount ?? null, t.paid_currency ?? null,
    ]
  );
  return r!;
}

export async function updateTxn(
  uid: number,
  id: number,
  patch: Partial<Omit<Txn, "id">>
): Promise<Txn | undefined> {
  const cur = await getTxn(uid, id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  return one<Txn>(
    `UPDATE transactions SET asset_id = $1, type = $2, date = $3, quantity = $4, price = $5,
       fees = $6, note = $7, paid_amount = $8, paid_currency = $9
     WHERE id = $10 RETURNING *`,
    [
      next.asset_id, next.type, next.date, next.quantity, next.price, next.fees, next.note,
      next.paid_amount ?? null, next.paid_currency ?? null, id,
    ]
  );
}

export async function deleteTxn(uid: number, id: number): Promise<void> {
  await q(
    `DELETE FROM transactions WHERE id = $1
       AND asset_id IN (SELECT id FROM assets WHERE user_id = $2)`,
    [id, uid]
  );
}

// ---- price history & quote cache (shared market data, not per-user) ----

export async function getHistory(symbol: string): Promise<{ date: string; close: number }[]> {
  return (await q(
    "SELECT date, close FROM price_history WHERE symbol = $1 ORDER BY date",
    [symbol]
  )) as unknown as { date: string; close: number }[];
}

/** Daily closes for many symbols in one query. */
export async function getHistories(
  symbols: string[]
): Promise<Map<string, { date: string; close: number }[]>> {
  const out = new Map<string, { date: string; close: number }[]>();
  if (!symbols.length) return out;
  const rows = (await q(
    "SELECT symbol, date, close FROM price_history WHERE symbol = ANY($1) ORDER BY symbol, date",
    [symbols]
  )) as unknown as { symbol: string; date: string; close: number }[];
  for (const s of symbols) out.set(s, []);
  for (const r of rows) out.get(r.symbol)?.push({ date: r.date, close: r.close });
  return out;
}

export async function upsertHistory(
  symbol: string,
  rows: { date: string; close: number }[]
): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values: string[] = [];
    const params: unknown[] = [symbol];
    for (const r of chunk) {
      values.push(`($1, $${params.length + 1}, $${params.length + 2})`);
      params.push(r.date, r.close);
    }
    await q(
      `INSERT INTO price_history (symbol, date, close) VALUES ${values.join(", ")}
       ON CONFLICT (symbol, date) DO UPDATE SET close = EXCLUDED.close`,
      params
    );
  }
}

export interface CachedQuote {
  symbol: string;
  price: number;
  currency: string;
  prev_close: number | null;
  fetched_at: number;
}

export async function getCachedQuotes(symbols: string[]): Promise<Map<string, CachedQuote>> {
  if (!symbols.length) return new Map();
  const rows = (await q("SELECT * FROM quotes WHERE symbol = ANY($1)", [
    symbols,
  ])) as unknown as CachedQuote[];
  return new Map(rows.map((r) => [r.symbol, r]));
}

export async function setCachedQuote(quote: CachedQuote): Promise<void> {
  await q(
    `INSERT INTO quotes (symbol, price, currency, prev_close, fetched_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (symbol) DO UPDATE SET price = EXCLUDED.price, currency = EXCLUDED.currency,
       prev_close = EXCLUDED.prev_close, fetched_at = EXCLUDED.fetched_at`,
    [quote.symbol, quote.price, quote.currency, quote.prev_close, quote.fetched_at]
  );
}

export async function getMeta(key: string): Promise<string | undefined> {
  return (await one<{ value: string }>("SELECT value FROM meta WHERE key = $1", [key]))?.value;
}

export async function getMetaMany(keys: string[]): Promise<Map<string, string>> {
  if (!keys.length) return new Map();
  const rows = (await q("SELECT key, value FROM meta WHERE key = ANY($1)", [
    keys,
  ])) as unknown as { key: string; value: string }[];
  return new Map(rows.map((r) => [r.key, r.value]));
}

export async function setMeta(key: string, value: string): Promise<void> {
  await q(
    `INSERT INTO meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}
