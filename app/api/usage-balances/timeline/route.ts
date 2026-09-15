import { NextRequest, NextResponse } from "next/server";
import { getUsageRecords } from "@/lib/usage-stats";
import { computeRemainingSeries } from "@/lib/usage-balances";

export const dynamic = "force-dynamic";

/**
 * POST 逐消息余额时间线。
 * body: { timestamps: number[] } —— 当前会话各 assistant 消息的完成时刻。
 * 返回每个 provider 在这些时刻的剩余余额（remaining），
 * 使每条消息能显示「它完成那一刻」的余额快照（余额全局共享，跨会话请求也扣减）。
 */
export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json().catch(() => null);
    const timestamps = Array.isArray(body)
      ? body
      : (body as { timestamps?: unknown } | null)?.timestamps;
    const tsList: number[] = Array.isArray(timestamps)
      ? timestamps.filter((t): t is number => typeof t === "number" && Number.isFinite(t))
      : [];

    const records = await getUsageRecords();
    if (!records) {
      return NextResponse.json({ providers: {} });
    }
    const { providers } = computeRemainingSeries(records, tsList);
    return NextResponse.json({ providers });
  } catch (error) {
    console.error("[usage-balances/timeline] failed:", error);
    return NextResponse.json({ error: "failed to compute balance timeline" }, { status: 500 });
  }
}
