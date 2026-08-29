// One-time migration: copy the local SQLite database into Neon Postgres,
// owned by your Google account's email.
//
//   DATABASE_URL=postgres://... OWNER_EMAIL=you@gmail.com node scripts/push-to-neon.mjs [sqlite-file]
//
// Idempotent: re-running wipes and re-imports that user's assets/transactions.
import Database from "better-sqlite3";
import { neon } from "@neondatabase/serverless";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_EMAIL = process.env.OWNER_EMAIL?.toLowerCase();
if (!DATABASE_URL || !OWNER_EMAIL) {
  console.error("Usage: DATABASE_URL=postgres://... OWNER_EMAIL=you@gmail.com node scripts/push-to-neon.mjs [sqlite-file]");
  process.exit(1);
}
const file = process.argv[2] ?? path.join(process.cwd(), "data", "investapp.db");

// Keep in sync with SCHEMA in lib/db.ts.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT)`,
  `CREATE TABLE IF NOT EXISTS assets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL, name TEXT NOT NULL, short_name TEXT,
    category TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
    sort INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'single',
    UNIQUE (user_id, symbol))`,
  `CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('buy','sell')),
    date TEXT NOT NULL,
    quantity DOUBLE PRECISION NOT NULL CHECK (quantity > 0),
    price DOUBLE PRECISION NOT NULL CHECK (price >= 0),
    fees DOUBLE PRECISION NOT NULL DEFAULT 0,
    note TEXT, paid_amount DOUBLE PRECISION, paid_currency TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_txn_asset_date ON transactions(asset_id, date)`,
  `CREATE TABLE IF NOT EXISTS price_history (
    symbol TEXT NOT NULL, date TEXT NOT NULL, close DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (symbol, date))`,
  `CREATE TABLE IF NOT EXISTS quotes (
    symbol TEXT PRIMARY KEY, price DOUBLE PRECISION NOT NULL, currency TEXT NOT NULL,
    prev_close DOUBLE PRECISION, fetched_at DOUBLE PRECISION NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS basket_components (
    id SERIAL PRIMARY KEY,
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL, name TEXT NOT NULL,
    UNIQUE (asset_id, symbol))`,
];

const sqlite = new Database(file, { readonly: true, fileMustExist: true });
const sql = neon(DATABASE_URL);

for (const stmt of SCHEMA) await sql.query(stmt);

const [{ id: uid }] = await sql.query(
  `INSERT INTO users (email, name) VALUES ($1, NULL)
   ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
  [OWNER_EMAIL]
);
console.log(`user ${OWNER_EMAIL} -> id ${uid}`);

// Wipe this user's previous import (cascades to transactions & components).
await sql.query(`DELETE FROM assets WHERE user_id = $1`, [uid]);

const assets = sqlite.prepare("SELECT * FROM assets ORDER BY sort, id").all();
const idMap = new Map();
for (const a of assets) {
  const [row] = await sql.query(
    `INSERT INTO assets (user_id, symbol, name, short_name, category, currency, sort, kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [uid, a.symbol, a.name, a.short_name ?? null, a.category, a.currency, a.sort, a.kind ?? "single"]
  );
  idMap.set(a.id, row.id);
}
console.log(`assets: ${assets.length}`);

const txns = sqlite.prepare("SELECT * FROM transactions ORDER BY date, id").all();
for (const t of txns) {
  await sql.query(
    `INSERT INTO transactions (asset_id, type, date, quantity, price, fees, note, paid_amount, paid_currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [idMap.get(t.asset_id), t.type, t.date, t.quantity, t.price, t.fees ?? 0, t.note ?? null,
     t.paid_amount ?? null, t.paid_currency ?? null]
  );
}
console.log(`transactions: ${txns.length}`);

const comps = sqlite.prepare("SELECT * FROM basket_components").all();
for (const c of comps) {
  await sql.query(
    `INSERT INTO basket_components (asset_id, symbol, name) VALUES ($1, $2, $3)
     ON CONFLICT (asset_id, symbol) DO UPDATE SET name = EXCLUDED.name`,
    [idMap.get(c.asset_id), c.symbol, c.name]
  );
}
console.log(`basket components: ${comps.length}`);

// Shared market-data cache: price history (bulk), quotes, hist:* sync markers.
const hist = sqlite.prepare("SELECT symbol, date, close FROM price_history").all();
for (let i = 0; i < hist.length; i += 500) {
  const chunk = hist.slice(i, i + 500);
  const values = [];
  const params = [];
  for (const r of chunk) {
    values.push(`($${params.length + 1}, $${params.length + 2}, $${params.length + 3})`);
    params.push(r.symbol, r.date, r.close);
  }
  await sql.query(
    `INSERT INTO price_history (symbol, date, close) VALUES ${values.join(", ")}
     ON CONFLICT (symbol, date) DO UPDATE SET close = EXCLUDED.close`,
    params
  );
}
console.log(`price history rows: ${hist.length}`);

const quotes = sqlite.prepare("SELECT * FROM quotes").all();
for (const q of quotes) {
  await sql.query(
    `INSERT INTO quotes (symbol, price, currency, prev_close, fetched_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (symbol) DO UPDATE SET price = EXCLUDED.price, currency = EXCLUDED.currency,
       prev_close = EXCLUDED.prev_close, fetched_at = EXCLUDED.fetched_at`,
    [q.symbol, q.price, q.currency, q.prev_close, q.fetched_at]
  );
}
const metas = sqlite.prepare("SELECT key, value FROM meta WHERE key LIKE 'hist:%'").all();
for (const m of metas) {
  await sql.query(
    `INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [m.key, m.value]
  );
}
console.log(`quotes: ${quotes.length}, meta: ${metas.length}`);
console.log("done — sign in with that Google account and your portfolio is there.");
