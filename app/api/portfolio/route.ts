import { NextResponse } from "next/server";
import { getPortfolio } from "@/lib/portfolio";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getPortfolio());
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
