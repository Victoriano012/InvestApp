import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

// Per-user envelope encryption: every user's rows are AES-256-GCM encrypted
// with a key derived from DATA_ENCRYPTION_KEY (lives only in the server env)
// and the user id, so the database alone holds only ciphertext and one user's
// key opens nothing of another's. Deterministic HMACs stand in for values
// that need SQL uniqueness (asset symbols).

let _master: Buffer | null = null;

function master(): Buffer {
  if (_master) return _master;
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (raw) {
    const buf = Buffer.from(raw, "base64");
    if (buf.length < 32)
      throw new Error("DATA_ENCRYPTION_KEY must be >= 32 bytes of base64 (openssl rand -base64 32)");
    _master = buf;
    return buf;
  }
  // Zero-config local dev only (embedded PGlite). Real deployments set the key.
  if (process.env.DATABASE_URL)
    throw new Error("DATA_ENCRYPTION_KEY is required when DATABASE_URL is set");
  _master = Buffer.from("investapp-dev-insecure-key-32bytes!!");
  return _master;
}

const keyCache = new Map<number, Buffer>();

function userKey(uid: number): Buffer {
  let k = keyCache.get(uid);
  if (!k) {
    k = Buffer.from(hkdfSync("sha256", master(), "investapp-v1", `user:${uid}`, 32));
    keyCache.set(uid, k);
  }
  return k;
}

/** Encrypt a JSON-serializable value for `uid` -> base64(iv || tag || ciphertext). */
export function encrypt(uid: number, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", userKey(uid), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decrypt<T>(uid: number, blob: string): T {
  const buf = Buffer.from(blob, "base64");
  const decipher = createDecipheriv("aes-256-gcm", userKey(uid), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  const pt = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as T;
}

/** Deterministic per-user digest, for UNIQUE columns over encrypted values. */
export function digest(uid: number, value: string): string {
  return createHmac("sha256", userKey(uid)).update(value).digest("hex");
}
