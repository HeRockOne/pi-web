import { NextResponse } from "next/server";
import { readRunningSnapshot } from "@/lib/running-state";

export const dynamic = "force-dynamic";

// GET /api/agent/running - one-shot snapshot, kept for tooling and as a manual
// fallback. The app itself subscribes to the `running` hub channel instead of
// polling this: every poll costs a full round trip, and over a public link that
// round trip is the most expensive thing the client does.
export async function GET() {
  return NextResponse.json(readRunningSnapshot(), {
    headers: { "Cache-Control": "no-store" },
  });
}
