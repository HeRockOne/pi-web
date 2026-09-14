import { NextResponse } from "next/server";
import { getUsageStatsIntermediate } from "@/lib/usage-stats";
import { computeBalances } from "@/lib/usage-balances";

export const dynamic = "force-dynamic";

/**
 * GET 各供应商当前余额（轻量视图，供会话界面消息下方显示）。
 * 只返回配置了余额的供应商：{ providers: { [provider]: { balance, spent, remaining } } }。
 */
export async function GET() {
  try {
    const intermediate = await getUsageStatsIntermediate();
    const rows = computeBalances(intermediate);
    const providers: Record<string, { balance: number; spent: number; remaining: number }> = {};
    for (const row of rows) {
      if (row.balance === null || row.remaining === null) continue;
      providers[row.provider] = { balance: row.balance, spent: row.spent, remaining: row.remaining };
    }
    return NextResponse.json({ providers });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
