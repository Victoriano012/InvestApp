import { NextRequest, NextResponse } from "next/server";
import { currentUserId } from "@/auth";
import { getAsset, getHistory } from "@/lib/db";
import { ensureAllHistory, FX_SYMBOL, GBP_FX_SYMBOL } from "@/lib/market";
import { basketUnitValueOn } from "@/lib/portfolio";
import { addDays } from "@/lib/format";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Last known close of `symbol` on or before `date` (from the cached history). */
async function closeOnOrBefore(symbol: string, date: string): Promise<number | null> {
  const rows = await getHistory(symbol);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].date <= date) return rows[i].close;
  }
  return null;
}

/**
 * Price context for money-based transaction entry:
 * GET /api/close?asset=<id>&date=YYYY-MM-DD
 * → { price, currency, usdPerEur, gbpPerEur, unitValue }
 * `price` is the asset's close on/before the date (1 for baskets — buys are
 * priced in EUR units); `unitValue` is the basket's per-unit market value on
 * that date (needed to size basket sells); `usdPerEur`/`gbpPerEur` convert
 * entered amounts between EUR, USD and GBP at that day's rates.
 */
export async function GET(req: NextRequest) {
  const uid = await currentUserId();
  if (uid == null) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const assetId = Number(req.nextUrl.searchParams.get("asset"));
  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!assetId || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return NextResponse.json({ error: "asset and date (YYYY-MM-DD) required" }, { status: 400 });
  const asset = await getAsset(uid, assetId);
  if (!asset) return NextResponse.json({ error: "unknown asset" }, { status: 404 });

  const lookback = addDays(date, -14);
  await ensureAllHistory([GBP_FX_SYMBOL], lookback); // + FX_SYMBOL implicitly
  const [usdPerEur, gbpPerEur] = await Promise.all([
    closeOnOrBefore(FX_SYMBOL, date),
    closeOnOrBefore(GBP_FX_SYMBOL, date),
  ]);

  if (asset.kind === "basket") {
    const unitValue = await basketUnitValueOn(uid, asset.id, date);
    return NextResponse.json({ price: 1, currency: "EUR", usdPerEur, gbpPerEur, unitValue });
  }

  await ensureAllHistory([asset.symbol], lookback);
  const price = await closeOnOrBefore(asset.symbol, date);
  return NextResponse.json({ price, currency: asset.currency, usdPerEur, gbpPerEur, unitValue: null });
}
