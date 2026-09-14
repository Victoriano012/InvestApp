import { NextResponse } from "next/server";
import { currentUserId } from "@/auth";
import { getPortfolio } from "@/lib/portfolio";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const uid = await currentUserId();
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  if (uid == null) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  try {
    return NextResponse.json(await getPortfolio(uid, fresh));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
