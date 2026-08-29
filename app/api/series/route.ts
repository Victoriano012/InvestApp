import { NextResponse } from "next/server";
import { currentUserId } from "@/auth";
import { getExplorerData } from "@/lib/portfolio";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const uid = await currentUserId();
  if (uid == null) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  try {
    return NextResponse.json(await getExplorerData(uid));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
