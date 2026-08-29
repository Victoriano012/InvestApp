import { NextRequest, NextResponse } from "next/server";
import { currentUserId } from "@/auth";
import { addBasketComponent, getAsset, listBasketComponents, removeBasketComponent } from "@/lib/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const uid = await currentUserId();
  if (uid == null) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await params;
  const asset = await getAsset(uid, Number(id));
  if (!asset) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(await listBasketComponents(Number(id)));
}

export async function POST(req: NextRequest, { params }: Params) {
  const uid = await currentUserId();
  if (uid == null) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await params;
  const asset = await getAsset(uid, Number(id));
  if (!asset) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (asset.kind !== "basket")
    return NextResponse.json({ error: "not a basket" }, { status: 400 });
  const b = await req.json();
  if (!b?.symbol || typeof b.symbol !== "string")
    return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const c = await addBasketComponent(Number(id), b.symbol.trim(), (b.name || b.symbol).trim());
  return NextResponse.json(c, { status: 201 });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const uid = await currentUserId();
  if (uid == null) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await params;
  const asset = await getAsset(uid, Number(id));
  if (!asset) return NextResponse.json({ error: "not found" }, { status: 404 });
  const symbol = req.nextUrl.searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol query param required" }, { status: 400 });
  await removeBasketComponent(Number(id), symbol);
  return NextResponse.json({ ok: true });
}
