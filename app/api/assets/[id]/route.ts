import { NextRequest, NextResponse } from "next/server";
import { currentUserId } from "@/auth";
import { deleteAsset, getAsset, listTxns, updateAsset } from "@/lib/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const uid = await currentUserId();
  if (uid == null) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await params;
  if (!(await getAsset(uid, Number(id))))
    return NextResponse.json({ error: "not found" }, { status: 404 });
  const b = await req.json();
  const patch: Record<string, unknown> = {};
  for (const k of ["symbol", "name", "short_name", "category", "currency", "sort"]) {
    if (b[k] !== undefined) patch[k] = b[k];
  }
  try {
    return NextResponse.json(await updateAsset(uid, Number(id), patch));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const uid = await currentUserId();
  if (uid == null) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await params;
  const txns = await listTxns(uid, Number(id));
  if (txns.length > 0)
    return NextResponse.json(
      { error: `asset has ${txns.length} transactions; delete them first` },
      { status: 409 }
    );
  await deleteAsset(uid, Number(id));
  return NextResponse.json({ ok: true });
}
