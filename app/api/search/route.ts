import { NextRequest, NextResponse } from "next/server";
import { searchSymbols } from "@/lib/market";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) return NextResponse.json([]);
  try {
    return NextResponse.json(await searchSymbols(q));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
