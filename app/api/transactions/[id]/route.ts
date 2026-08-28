import { NextRequest, NextResponse } from "next/server";
import { deleteTxn, getTxn, updateTxn } from "@/lib/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!getTxn(Number(id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const b = await req.json();
  const patch: Record<string, unknown> = {};
  for (const k of ["asset_id", "type", "date", "quantity", "price", "fees", "note", "paid_amount", "paid_currency"]) {
    if (b[k] !== undefined) patch[k] = b[k];
  }
  return NextResponse.json(updateTxn(Number(id), patch));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  deleteTxn(Number(id));
  return NextResponse.json({ ok: true });
}
