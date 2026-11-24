import { NextRequest, NextResponse } from "next/server";
import { currentUserId } from "@/auth";
import { deleteTxn, getAsset, getTxn, listTxns, parseId, updateTxn } from "@/lib/db";
import { checkTxn, oversold } from "@/lib/txnValidation";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const uid = await currentUserId();
  if (uid == null) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const id = parseId((await params).id);
  const cur = id == null ? undefined : await getTxn(uid, id);
  if (!cur) return NextResponse.json({ error: "not found" }, { status: 404 });
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== "object") return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  if (b.asset_id !== undefined && Number(b.asset_id) !== cur.asset_id)
    return NextResponse.json(
      { error: "a transaction can't move to another asset — delete it and add it again" },
      { status: 400 }
    );
  const merged: Record<string, unknown> = { ...cur };
  for (const k of ["type", "date", "quantity", "price", "fees", "note", "paid_amount", "paid_currency", "amount_eur"]) {
    if (b[k] !== undefined) merged[k] = b[k];
  }
  const asset = (await getAsset(uid, cur.asset_id))!;
  const txn = checkTxn(merged, asset);
  if (typeof txn === "string") return NextResponse.json({ error: txn }, { status: 400 });
  const others = (await listTxns(uid, cur.asset_id)).filter((t) => t.id !== cur.id);
  const over = oversold([...others, { ...txn, id: cur.id }]);
  if (over) return NextResponse.json({ error: over }, { status: 400 });
  return NextResponse.json(await updateTxn(uid, cur.id, txn));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const uid = await currentUserId();
  if (uid == null) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const id = parseId((await params).id);
  const cur = id == null ? undefined : await getTxn(uid, id);
  if (!cur) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (cur.type === "buy") {
    const over = oversold((await listTxns(uid, cur.asset_id)).filter((t) => t.id !== cur.id));
    if (over) return NextResponse.json({ error: `can't delete this buy: ${over}` }, { status: 409 });
  }
  await deleteTxn(uid, cur.id);
  return NextResponse.json({ ok: true });
}
