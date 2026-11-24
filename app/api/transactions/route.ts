import { NextRequest, NextResponse } from "next/server";
import { currentUserId } from "@/auth";
import { createTxn, getAsset, listTxns } from "@/lib/db";
import { checkTxn, oversold } from "@/lib/txnValidation";

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
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== "object") return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  const aid = typeof b.asset_id === "number" || typeof b.asset_id === "string" ? Number(b.asset_id) : NaN;
  const asset = Number.isSafeInteger(aid) ? await getAsset(uid, aid) : undefined;
  if (!asset) return NextResponse.json({ error: "unknown asset" }, { status: 400 });
  const txn = checkTxn(b, asset);
  if (typeof txn === "string") return NextResponse.json({ error: txn }, { status: 400 });
  const over = oversold([...(await listTxns(uid, asset.id)), { ...txn, id: Infinity }]);
  if (over) return NextResponse.json({ error: over }, { status: 400 });
  return NextResponse.json(await createTxn(uid, txn), { status: 201 });
}
