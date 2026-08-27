import { NextRequest, NextResponse } from "next/server";
import { createAsset, listAssets } from "@/lib/db";
import { symbolCurrency } from "@/lib/market";
import { CATEGORIES } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(listAssets());
}

export async function POST(req: NextRequest) {
  const b = await req.json();
  if (!CATEGORIES.some((c) => c.key === b.category))
    return NextResponse.json({ error: "invalid category" }, { status: 400 });

  // Baskets are app-local: no Yahoo symbol, always valued in EUR.
  if (b.kind === "basket") {
    if (!b?.name || typeof b.name !== "string")
      return NextResponse.json({ error: "name required" }, { status: 400 });
    const slug = b.name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
    try {
      const asset = createAsset({
        symbol: `BASKET:${slug || Date.now()}`,
        name: b.name.trim(),
        category: b.category,
        currency: "EUR",
        kind: "basket",
      });
      return NextResponse.json(asset, { status: 201 });
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 400 });
    }
  }

  if (!b?.symbol || typeof b.symbol !== "string")
    return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const currency = b.currency || (await symbolCurrency(b.symbol)) || "USD";
  try {
    const asset = createAsset({
      symbol: b.symbol.trim(),
      name: (b.name || b.symbol).trim(),
      category: b.category,
      currency,
    });
    return NextResponse.json(asset, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
