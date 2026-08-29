import { NextRequest, NextResponse } from "next/server";
import { currentUserId } from "@/auth";
import { createTxn, getAsset, listTxns } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const uid = await currentUserId();
  if (uid == null) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const assetId = req.nextUrl.searchParams.get("asset");
  return NextResponse.json(await listTxns(uid, assetId ? Number(assetId) : undefined));
}

export async function POST(req: NextRequest) {
  const uid = await currentUserId();
  if (uid == null) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const b = await req.json();
  const err = await validate(uid, b);
  if (err) return NextResponse.json({ error: err }, { status: 400 });
  const txn = await createTxn(uid, {
    asset_id: Number(b.asset_id),
    type: b.type,
    date: b.date,
    quantity: Number(b.quantity),
    price: Number(b.price),
    fees: Number(b.fees ?? 0),
    note: b.note ?? null,
    paid_amount: b.paid_amount != null ? Number(b.paid_amount) : null,
    paid_currency: b.paid_amount != null ? String(b.paid_currency) : null,
  });
  return NextResponse.json(txn, { status: 201 });
}

async function validate(uid: number, b: Record<string, unknown>): Promise<string | null> {
  if (!b) return "missing body";
  if (b.type !== "buy" && b.type !== "sell") return "type must be buy or sell";
  if (!(await getAsset(uid, Number(b.asset_id)))) return "unknown asset";
  if (typeof b.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return "date must be YYYY-MM-DD";
  if (b.date > new Date().toISOString().slice(0, 10)) return "date is in the future";
  if (!(Number(b.quantity) > 0)) return "quantity must be > 0";
  if (!(Number(b.price) >= 0)) return "price must be >= 0";
  if (b.fees != null && !(Number(b.fees) >= 0)) return "fees must be >= 0";
  if (b.paid_amount != null) {
    if (!(Number(b.paid_amount) > 0)) return "paid_amount must be > 0";
    if (typeof b.paid_currency !== "string" || !b.paid_currency)
      return "paid_currency required when paid_amount is set";
  }
  return null;
}
