import path from "node:path";
import { decrypt, digest, encrypt } from "./crypto";
import type { Asset, BasketComponent, Txn } from "./types";

// Postgres: Neon over HTTP in production (DATABASE_URL), embedded PGlite for
// local dev/tests (persisted under data/pg, override with INVESTAPP_PG_DIR).
//
// Per-user data (assets, transactions, basket components) is stored as an
// encrypted `enc` blob per row (lib/crypto.ts) — the DB alone holds only
// ciphertext. Plain columns are limited to ids/foreign keys, `sort`, and
// deterministic `symbol_h` digests used for uniqueness. Market data
// (price_history, quotes, hist:* meta) is public and shared, so it stays
// plain; users.email stays plain because it's the sign-in lookup key.

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
    symbol_h TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    enc TEXT NOT NULL,
    UNIQUE (user_id, symbol_h)
  )`,
  `CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    enc TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_txn_asset ON transactions(asset_id)`,
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
    symbol_h TEXT NOT NULL,
    enc TEXT NOT NULL,
    UNIQUE (asset_id, symbol_h)
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

// ---- assets (scoped to the logged-in user, contents encrypted) ----

type AssetPayload = Omit<Asset, "id" | "sort">;
type AssetRow = { id: number; sort: number; enc: string };

function rowToAsset(uid: number, r: AssetRow): Asset {
  return { id: r.id, sort: r.sort, ...decrypt<AssetPayload>(uid, r.enc) };
}

export async function listAssets(uid: number): Promise<Asset[]> {
  const rows = (await q(
    "SELECT id, sort, enc FROM assets WHERE user_id = $1 ORDER BY sort, id",
    [uid]
  )) as AssetRow[];
  return rows.map((r) => rowToAsset(uid, r));
}

export async function getAsset(uid: number, id: number): Promise<Asset | undefined> {
  const r = await one<AssetRow>(
    "SELECT id, sort, enc FROM assets WHERE user_id = $1 AND id = $2",
    [uid, id]
  );
  return r && rowToAsset(uid, r);
}

export async function createAsset(
  uid: number,
  a: Omit<Asset, "id" | "sort" | "kind"> & { kind?: Asset["kind"] }
): Promise<Asset> {
  const payload: AssetPayload = {
    symbol: a.symbol,
    name: a.name,
    short_name: a.short_name ?? null,
    category: a.category,
    currency: a.currency,
    kind: a.kind ?? "single",
  };
  const r = await one<AssetRow>(
    `INSERT INTO assets (user_id, symbol_h, sort, enc)
     VALUES ($1, $2, (SELECT COALESCE(MAX(sort), 0) + 1 FROM assets WHERE user_id = $1), $3)
     RETURNING id, sort, enc`,
    [uid, digest(uid, a.symbol), encrypt(uid, payload)]
  );
  return rowToAsset(uid, r!);
}

export async function updateAsset(
  uid: number,
  id: number,
  patch: Partial<Omit<Asset, "id">>
): Promise<Asset | undefined> {
  const cur = await getAsset(uid, id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  const payload: AssetPayload = {
    symbol: next.symbol,
    name: next.name,
    short_name: next.short_name ?? null,
    category: next.category,
    currency: next.currency,
    kind: next.kind,
  };
  const r = await one<AssetRow>(
    `UPDATE assets SET symbol_h = $1, sort = $2, enc = $3
     WHERE user_id = $4 AND id = $5 RETURNING id, sort, enc`,
    [digest(uid, next.symbol), next.sort, encrypt(uid, payload), uid, id]
  );
  return r && rowToAsset(uid, r);
}

export async function deleteAsset(uid: number, id: number): Promise<void> {
  await q("DELETE FROM assets WHERE user_id = $1 AND id = $2", [uid, id]);
}

// ---- basket components (via asset ownership, contents encrypted) ----

type CompPayload = { symbol: string; name: string };
type CompRow = { id: number; asset_id: number; enc: string };

function rowToComp(uid: number, r: CompRow): BasketComponent {
  return { id: r.id, asset_id: r.asset_id, ...decrypt<CompPayload>(uid, r.enc) };
}

export async function listBasketComponents(uid: number, assetId: number): Promise<BasketComponent[]> {
  const rows = (await q(
    `SELECT c.id, c.asset_id, c.enc FROM basket_components c
     JOIN assets a ON a.id = c.asset_id
     WHERE a.user_id = $1 AND c.asset_id = $2`,
    [uid, assetId]
  )) as CompRow[];
  return rows
    .map((r) => rowToComp(uid, r))
    .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : x.id - y.id));
}

export async function addBasketComponent(
  uid: number,
  assetId: number,
  symbol: string,
  name: string
): Promise<BasketComponent> {
  const r = await one<CompRow>(
    `INSERT INTO basket_components (asset_id, symbol_h, enc) VALUES ($1, $2, $3)
     ON CONFLICT (asset_id, symbol_h) DO UPDATE SET enc = EXCLUDED.enc
     RETURNING id, asset_id, enc`,
    [assetId, digest(uid, symbol), encrypt(uid, { symbol, name })]
  );
  return rowToComp(uid, r!);
}

export async function removeBasketComponent(uid: number, assetId: number, symbol: string): Promise<void> {
  await q("DELETE FROM basket_components WHERE asset_id = $1 AND symbol_h = $2", [
    assetId,
    digest(uid, symbol),
  ]);
}

// ---- transactions (scoped through asset ownership, contents encrypted) ----

type TxnPayload = Omit<Txn, "id" | "asset_id">;
type TxnRow = { id: number; asset_id: number; enc: string };

function rowToTxn(uid: number, r: TxnRow): Txn {
  return { id: r.id, asset_id: r.asset_id, ...decrypt<TxnPayload>(uid, r.enc) };
}

const byDateThenId = (a: Txn, b: Txn) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id;

export async function listTxns(uid: number, assetId?: number): Promise<Txn[]> {
  const rows = (assetId != null
    ? await q(
        `SELECT t.id, t.asset_id, t.enc FROM transactions t JOIN assets a ON a.id = t.asset_id
         WHERE a.user_id = $1 AND t.asset_id = $2`,
        [uid, assetId]
      )
    : await q(
        `SELECT t.id, t.asset_id, t.enc FROM transactions t JOIN assets a ON a.id = t.asset_id
         WHERE a.user_id = $1`,
        [uid]
      )) as TxnRow[];
  return rows.map((r) => rowToTxn(uid, r)).sort(byDateThenId);
}

export async function getTxn(uid: number, id: number): Promise<Txn | undefined> {
  const r = await one<TxnRow>(
    `SELECT t.id, t.asset_id, t.enc FROM transactions t JOIN assets a ON a.id = t.asset_id
     WHERE a.user_id = $1 AND t.id = $2`,
    [uid, id]
  );
  return r && rowToTxn(uid, r);
}

function txnPayload(t: Omit<Txn, "id" | "asset_id">): TxnPayload {
  return {
    type: t.type,
    date: t.date,
    quantity: t.quantity,
    price: t.price,
    fees: t.fees ?? 0,
    note: t.note ?? null,
    paid_amount: t.paid_amount ?? null,
    paid_currency: t.paid_currency ?? null,
  };
}

export async function createTxn(uid: number, t: Omit<Txn, "id">): Promise<Txn> {
  const r = await one<TxnRow>(
    "INSERT INTO transactions (asset_id, enc) VALUES ($1, $2) RETURNING id, asset_id, enc",
    [t.asset_id, encrypt(uid, txnPayload(t))]
  );
  return rowToTxn(uid, r!);
}

export async function updateTxn(
  uid: number,
  id: number,
  patch: Partial<Omit<Txn, "id">>
): Promise<Txn | undefined> {
  const cur = await getTxn(uid, id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  const r = await one<TxnRow>(
    "UPDATE transactions SET asset_id = $1, enc = $2 WHERE id = $3 RETURNING id, asset_id, enc",
    [next.asset_id, encrypt(uid, txnPayload(next)), id]
  );
  return r && rowToTxn(uid, r);
}

export async function deleteTxn(uid: number, id: number): Promise<void> {
  await q(
    `DELETE FROM transactions WHERE id = $1
       AND asset_id IN (SELECT id FROM assets WHERE user_id = $2)`,
    [id, uid]
  );
}

// ---- price history & quote cache (shared public market data, plain) ----

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
