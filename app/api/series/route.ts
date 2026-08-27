import { NextResponse } from "next/server";
import { getExplorerData } from "@/lib/portfolio";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getExplorerData());
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
