import { NextRequest, NextResponse } from "next/server";
import { addBasketComponent, getAsset, listBasketComponents, removeBasketComponent } from "@/lib/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const asset = getAsset(Number(id));
  if (!asset) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(listBasketComponents(Number(id)));
}

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const asset = getAsset(Number(id));
  if (!asset) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (asset.kind !== "basket")
    return NextResponse.json({ error: "not a basket" }, { status: 400 });
  const b = await req.json();
  if (!b?.symbol || typeof b.symbol !== "string")
    return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const c = addBasketComponent(Number(id), b.symbol.trim(), (b.name || b.symbol).trim());
  return NextResponse.json(c, { status: 201 });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const symbol = req.nextUrl.searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol query param required" }, { status: 400 });
  removeBasketComponent(Number(id), symbol);
  return NextResponse.json({ ok: true });
}
