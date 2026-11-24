import { NextRequest, NextResponse } from "next/server";
import { currentUserId } from "@/auth";
import { createAsset, listAssets } from "@/lib/db";
import { symbolCurrency } from "@/lib/market";
import { CATEGORIES } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const uid = await currentUserId();
  if (uid == null) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  return NextResponse.json(await listAssets(uid));
}

export async function POST(req: NextRequest) {
  const uid = await currentUserId();
  if (uid == null) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== "object") return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  if (!CATEGORIES.some((c) => c.key === b.category))
    return NextResponse.json({ error: "invalid category" }, { status: 400 });

  // Baskets are app-local: no Yahoo symbol, always valued in EUR.
  if (b.kind === "basket") {
    if (typeof b.name !== "string" || !b.name.trim())
      return NextResponse.json({ error: "name required" }, { status: 400 });
    const slug = b.name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
    const symbol = `BASKET:${slug || Date.now()}`;
    if ((await listAssets(uid)).some((a) => a.symbol === symbol))
      return NextResponse.json({ error: `a basket named like "${b.name.trim()}" already exists` }, { status: 409 });
    const asset = await createAsset(uid, {
      symbol,
      name: b.name.trim(),
      short_name: null,
      category: b.category,
      currency: "EUR",
      kind: "basket",
    });
    return NextResponse.json(asset, { status: 201 });
  }

  if (!b?.symbol || typeof b.symbol !== "string" || !b.symbol.trim())
    return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const symbol = b.symbol.trim().toUpperCase();
  // Always the quote's own currency: every stored price is read in it.
  const currency = await symbolCurrency(symbol);
  if (!currency)
    return NextResponse.json({ error: `couldn't look up ${symbol} on Yahoo — check the symbol or try again` }, { status: 400 });
  if (b.currency && b.currency !== currency)
    return NextResponse.json({ error: `${symbol} is quoted in ${currency}, not ${b.currency}` }, { status: 400 });
  if (currency !== "EUR" && currency !== "USD")
    return NextResponse.json(
      { error: `${symbol} is quoted in ${currency}; only EUR and USD listings are supported — pick another listing` },
      { status: 400 }
    );
  if ((await listAssets(uid)).some((a) => a.symbol.toUpperCase() === symbol))
    return NextResponse.json({ error: `${symbol} is already in your assets` }, { status: 409 });
  const asset = await createAsset(uid, {
    symbol,
    name: (typeof b.name === "string" && b.name.trim()) || symbol,
    short_name: null,
    category: b.category,
    currency,
  });
  return NextResponse.json(asset, { status: 201 });
}
