// One-time migration: copy the local SQLite database into Neon Postgres,
// encrypted, owned by your Google account's email.
//
//   DATABASE_URL=postgres://... DATA_ENCRYPTION_KEY=<base64> OWNER_EMAIL=you@gmail.com \
//     node scripts/push-to-neon.mjs [sqlite-file]
//
// Idempotent: re-running wipes and re-imports that user's assets/transactions.
import Database from "better-sqlite3";
import { neon } from "@neondatabase/serverless";
import { createCipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_EMAIL = process.env.OWNER_EMAIL?.toLowerCase();
const KEY = process.env.DATA_ENCRYPTION_KEY;
if (!DATABASE_URL || !OWNER_EMAIL || !KEY) {
  console.error(
    "Usage: DATABASE_URL=postgres://... DATA_ENCRYPTION_KEY=<base64> OWNER_EMAIL=you@gmail.com node scripts/push-to-neon.mjs [sqlite-file]"
  );
  process.exit(1);
}
const file = process.argv[2] ?? path.join(process.cwd(), "data", "investapp.db");

// Keep crypto + schema in sync with lib/crypto.ts and lib/db.ts.
const master = Buffer.from(KEY, "base64");
if (master.length < 32) throw new Error("DATA_ENCRYPTION_KEY must be >= 32 bytes of base64");
const userKey = (uid) => Buffer.from(hkdfSync("sha256", master, "investapp-v1", `user:${uid}`, 32));
function encrypt(uid, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", userKey(uid), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}
const digest = (uid, value) => createHmac("sha256", userKey(uid)).update(value).digest("hex");

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT)`,
  `CREATE TABLE IF NOT EXISTS assets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol_h TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, enc TEXT NOT NULL,
    UNIQUE (user_id, symbol_h))`,
  `CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    enc TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_txn_asset ON transactions(asset_id)`,
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
    symbol_h TEXT NOT NULL, enc TEXT NOT NULL,
    UNIQUE (asset_id, symbol_h))`,
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
  const payload = {
    symbol: a.symbol,
    name: a.name,
    short_name: a.short_name ?? null,
    category: a.category,
    currency: a.currency,
    kind: a.kind ?? "single",
  };
  const [row] = await sql.query(
    `INSERT INTO assets (user_id, symbol_h, sort, enc) VALUES ($1, $2, $3, $4) RETURNING id`,
    [uid, digest(uid, a.symbol), a.sort, encrypt(uid, payload)]
  );
  idMap.set(a.id, row.id);
}
console.log(`assets: ${assets.length}`);

const txns = sqlite.prepare("SELECT * FROM transactions ORDER BY date, id").all();
for (const t of txns) {
  const payload = {
    type: t.type,
    date: t.date,
    quantity: t.quantity,
    price: t.price,
    fees: t.fees ?? 0,
    note: t.note ?? null,
    paid_amount: t.paid_amount ?? null,
    paid_currency: t.paid_currency ?? null,
  };
  await sql.query(`INSERT INTO transactions (asset_id, enc) VALUES ($1, $2)`, [
    idMap.get(t.asset_id),
    encrypt(uid, payload),
  ]);
}
console.log(`transactions: ${txns.length}`);

const comps = sqlite.prepare("SELECT * FROM basket_components").all();
for (const c of comps) {
  await sql.query(
    `INSERT INTO basket_components (asset_id, symbol_h, enc) VALUES ($1, $2, $3)
     ON CONFLICT (asset_id, symbol_h) DO UPDATE SET enc = EXCLUDED.enc`,
    [idMap.get(c.asset_id), digest(uid, c.symbol), encrypt(uid, { symbol: c.symbol, name: c.name })]
  );
}
console.log(`basket components: ${comps.length}`);

// Shared public market-data cache: price history (bulk), quotes, hist:* markers.
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
