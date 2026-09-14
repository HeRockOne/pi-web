import { NextResponse } from "next/server";
import { getUsageStatsIntermediate, getUsageStatsSnapshot } from "@/lib/usage-stats";
import { aggregateProviderCosts, computeBalances, saveProviderBalance } from "@/lib/usage-balances";

export const dynamic = "force-dynamic";

/** GET 用量统计聚合视图 + 各供应商余额（数据源：pi-tracker 的 analytics/usage.jsonl）。 */
export async function GET() {
  try {
    const snapshot = await getUsageStatsSnapshot();
    const intermediate = await getUsageStatsIntermediate();
    const balances = computeBalances(intermediate);
    return NextResponse.json({ ...snapshot, balances });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/**
 * POST 设置/清除某供应商余额。
 * body: { provider, balance, resetSpent? }
 *  - balance: 非负金额；null = 清除该供应商配置。
 *  - resetSpent: true 时把扣减基线重置为当前累计成本（已扣从 0 重新累计）。
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      provider?: unknown;
      balance?: unknown;
      resetSpent?: unknown;
    };
    if (typeof body.provider !== "string" || body.provider.trim().length === 0) {
      return NextResponse.json({ error: "provider is required" }, { status: 400 });
    }
    const provider = body.provider.trim();
    const balance = body.balance;
    if (balance !== null && (typeof balance !== "number" || !Number.isFinite(balance) || balance < 0)) {
      return NextResponse.json({ error: "balance must be a non-negative number or null" }, { status: 400 });
    }

    const intermediate = await getUsageStatsIntermediate();
    const costs = intermediate ? aggregateProviderCosts(intermediate) : new Map<string, never>();
    const currentCost = costs.get(provider)?.cost ?? 0;
    saveProviderBalance(provider, balance as number | null, {
      resetSpent: body.resetSpent === true,
      currentCost,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
