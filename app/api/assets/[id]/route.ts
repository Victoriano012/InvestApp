import { NextRequest, NextResponse } from "next/server";
import { currentUserId } from "@/auth";
import { deleteAsset, getAsset, listTxns, parseId, updateAsset } from "@/lib/db";
import { CATEGORIES } from "@/lib/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const uid = await currentUserId();
  if (uid == null) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const id = parseId((await params).id);
  if (id == null || !(await getAsset(uid, id)))
    return NextResponse.json({ error: "not found" }, { status: 404 });
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== "object") return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  // Symbol and currency are fixed at creation: changing them would reprice every stored txn.
  if (b.symbol !== undefined || b.currency !== undefined)
    return NextResponse.json({ error: "symbol and currency can't be changed — add a new asset instead" }, { status: 400 });
  if (b.name !== undefined && (typeof b.name !== "string" || !b.name.trim()))
    return NextResponse.json({ error: "name required" }, { status: 400 });
  if (b.short_name != null && typeof b.short_name !== "string")
    return NextResponse.json({ error: "short_name must be text" }, { status: 400 });
  if (b.category !== undefined && !CATEGORIES.some((c) => c.key === b.category))
    return NextResponse.json({ error: "invalid category" }, { status: 400 });
  if (b.sort !== undefined && !Number.isInteger(b.sort))
    return NextResponse.json({ error: "sort must be an integer" }, { status: 400 });
  const patch: Record<string, unknown> = {};
  for (const k of ["name", "short_name", "category", "sort"]) {
    if (b[k] !== undefined) patch[k] = typeof b[k] === "string" ? b[k].trim() || null : b[k];
  }
  return NextResponse.json(await updateAsset(uid, id, patch));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const uid = await currentUserId();
  if (uid == null) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const id = parseId((await params).id);
  if (id == null || !(await getAsset(uid, id)))
    return NextResponse.json({ error: "not found" }, { status: 404 });
  const txns = await listTxns(uid, id);
  if (txns.length > 0)
    return NextResponse.json(
      { error: `asset has ${txns.length} transactions; delete them first` },
      { status: 409 }
    );
  await deleteAsset(uid, id);
  return NextResponse.json({ ok: true });
}
