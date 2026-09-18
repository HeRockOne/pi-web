import { NextResponse } from "next/server";
import { getUsageStatsIntermediate, getUsageStatsSnapshot } from "@/lib/usage-stats";
import { aggregateProviderCosts, computeBalances, saveProviderBalance, undoProviderBalance } from "@/lib/usage-balances";

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
 * POST 管理某供应商余额。
 * body: { provider, balance?, add?, resetSpent?, undo? }
 *  - balance: 非负金额；null = 清除该供应商配置（覆盖设置）。
 *  - add: 非负金额；提供时在现有余额上叠加充值（已扣/基线不动，balance 参数忽略）。
 *  - undo: true 时撤销该供应商最近一次写入（恢复快照）。
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      provider?: unknown;
      balance?: unknown;
      resetSpent?: unknown;
      add?: unknown;
      undo?: unknown;
    };
    if (typeof body.provider !== "string" || body.provider.trim().length === 0) {
      return NextResponse.json({ error: "provider is required" }, { status: 400 });
    }
    const provider = body.provider.trim();
    if (body.undo === true) {
      const restored = undoProviderBalance(provider);
      if (restored === undefined) {
        return NextResponse.json({ error: "nothing to undo" }, { status: 400 });
      }
      return NextResponse.json({ ok: true, restored });
    }
    const add = body.add;
    const balance = body.balance;
    // add 提供时（叠加充值）无需 balance 字段；仅 balance 模式校验
    if (add === undefined && balance !== null && (typeof balance !== "number" || !Number.isFinite(balance) || balance < 0)) {
      return NextResponse.json({ error: "balance must be a non-negative number or null" }, { status: 400 });
    }
    if (add !== undefined && (typeof add !== "number" || !Number.isFinite(add) || add < 0)) {
      return NextResponse.json({ error: "add must be a non-negative number" }, { status: 400 });
    }
    const intermediate = await getUsageStatsIntermediate();
    const costs = intermediate ? aggregateProviderCosts(intermediate) : new Map<string, never>();
    const currentCost = costs.get(provider)?.cost ?? 0;
    const opts = {
      resetSpent: body.resetSpent === true,
      currentCost,
    };
    if (add !== undefined) {
      // 叠加充值：新余额 = 现有余额 + add（首次无配置从 0 起）
      saveProviderBalance(provider, null, { ...opts, add });
    } else {
      saveProviderBalance(provider, balance as number | null, opts);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
