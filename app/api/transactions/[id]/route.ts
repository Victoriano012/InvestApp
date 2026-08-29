import { NextRequest, NextResponse } from "next/server";
import { currentUserId } from "@/auth";
import { deleteTxn, getAsset, getTxn, updateTxn } from "@/lib/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const uid = await currentUserId();
  if (uid == null) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await params;
  if (!(await getTxn(uid, Number(id))))
    return NextResponse.json({ error: "not found" }, { status: 404 });
  const b = await req.json();
  const patch: Record<string, unknown> = {};
  for (const k of ["asset_id", "type", "date", "quantity", "price", "fees", "note", "paid_amount", "paid_currency"]) {
    if (b[k] !== undefined) patch[k] = b[k];
  }
  if (patch.asset_id !== undefined && !(await getAsset(uid, Number(patch.asset_id))))
    return NextResponse.json({ error: "unknown asset" }, { status: 400 });
  return NextResponse.json(await updateTxn(uid, Number(id), patch));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const uid = await currentUserId();
  if (uid == null) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await params;
  await deleteTxn(uid, Number(id));
  return NextResponse.json({ ok: true });
}
