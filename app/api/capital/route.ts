import { NextResponse } from "next/server";
import { getCapitalData } from "@/lib/portfolio";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getCapitalData());
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
