import { fmtDate, fmtNum, todayISO } from "./format";
import type { Asset, Txn } from "./types";

export type TxnInput = Omit<Txn, "id">;

/** A JSON number or numeric string; anything else (booleans, "", null) is NaN. */
function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return NaN;
}

function validDate(d: unknown): d is string {
  return (
    typeof d === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(d) &&
    d >= "1970-01-01" &&
    !isNaN(Date.parse(d + "T00:00:00Z")) &&
    new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d
  );
}

/**
 * Check a transaction body against its asset; returns the clean txn or an
 * error message. Holdings (oversell) are checked separately — see `oversold`.
 */
export function checkTxn(b: Record<string, unknown>, asset: Asset): TxnInput | string {
  if (b.type !== "buy" && b.type !== "sell") return "type must be buy or sell";
  if (!validDate(b.date)) return "date must be a real YYYY-MM-DD date (1970 or later)";
  if (b.date > todayISO()) return "date is in the future";
  const quantity = num(b.quantity);
  const price = num(b.price);
  const fees = b.fees == null || b.fees === "" ? 0 : num(b.fees);
  if (!(quantity > 0 && isFinite(quantity))) return "quantity must be a number > 0";
  if (!(price > 0 && isFinite(price))) return "price must be a number > 0";
  if (!(fees >= 0 && isFinite(fees))) return "fees must be a number >= 0";
  if (b.type === "sell" && fees >= quantity * price) return "fees can't exceed the sale proceeds";
  if (asset.kind === "basket" && b.type === "buy" && Math.abs(price - 1) > 1e-6)
    return "basket buys are stored at price 1 (quantity = EUR invested)";
  if (b.note != null && (typeof b.note !== "string" || b.note.length > 500))
    return "note must be text (max 500 characters)";

  let paid_amount: number | null = null;
  let paid_currency: string | null = null;
  if (b.paid_amount != null && b.paid_amount !== "") {
    paid_amount = num(b.paid_amount);
    if (!(paid_amount > 0 && isFinite(paid_amount))) return "paid_amount must be a number > 0";
    if (typeof b.paid_currency !== "string" || !/^[A-Z]{3}$/.test(b.paid_currency))
      return "paid_currency must be a 3-letter currency code";
    paid_currency = b.paid_currency;
    // Same currency as the asset: the total must match quantity × price ± fees.
    if (paid_currency === asset.currency) {
      const expected = quantity * price + (b.type === "buy" ? fees : -fees);
      if (Math.abs(expected - paid_amount) > 0.005 * paid_amount + 0.01)
        return `total ${fmtNum(paid_amount, 2)} doesn't match quantity × price ${b.type === "buy" ? "+" : "−"} fees (${fmtNum(expected, 2)})`;
    }
  }

  return {
    asset_id: asset.id,
    type: b.type,
    date: b.date,
    quantity,
    price: asset.kind === "basket" && b.type === "buy" ? 1 : price,
    fees,
    note: typeof b.note === "string" && b.note.trim() ? b.note.trim() : null,
    paid_amount,
    paid_currency,
  };
}

/**
 * First sell (in the date-then-id order the portfolio math uses) that exceeds
 * the quantity held at that point, as an error message; null when none does.
 * `txns` are one asset's transactions.
 */
export function oversold(txns: Txn[]): string | null {
  const sorted = [...txns].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  let held = 0;
  for (const t of sorted) {
    if (t.type === "buy") {
      held += t.quantity;
      continue;
    }
    if (t.quantity > held * (1 + 1e-9) + 1e-12)
      return `the sell of ${fmtNum(t.quantity, 8)} on ${fmtDate(t.date)} exceeds the ${fmtNum(held, 8)} held then`;
    held = Math.max(held - t.quantity, 0);
  }
  return null;
}
