import { NextResponse } from "next/server";
import { getUsageStatsSnapshot } from "@/lib/usage-stats";

export const dynamic = "force-dynamic";

/** GET 用量统计聚合视图（数据源：pi-tracker 的 analytics/usage.jsonl）。 */
export async function GET() {
  try {
    const snapshot = await getUsageStatsSnapshot();
    return NextResponse.json(snapshot);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
