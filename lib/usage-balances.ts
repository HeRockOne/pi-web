/**
 * 供应商余额（Provider Balances）服务端模块。
 *
 * 每个供应商可设置一个余额额度（美元），该供应商下所有模型的成本
 * （来自 pi-tracker 的 analytics/usage.jsonl，按 provider 归集）共享此额度扣减：
 *   已扣 = max(0, 累计成本 - spentBaseline)
 *   剩余 = balance - 已扣
 *
 * spentBaseline 是扣减基线：设置余额时可选择"重置已扣"，把当刻的累计成本
 * 记为基线，之后只扣新增部分（默认基线为 0 = 全部历史都计入）。
 *
 * 配置持久化在 <agentDir>/analytics/balances.json（与 usage.jsonl 同目录），
 * 原子写入，损坏/缺失时容错为无配置。
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import type { UsageRecord, UsageStatsIntermediate } from "./usage-stats";

// ============================================================================
// 类型
// ============================================================================

export type ProviderBalanceConfig = {
  /** 设置的余额（美元）；null = 清除配置 */
  balance: number | null;
  /** 扣减基线：设置/重置时记录的累计成本，只扣其后的增量 */
  spentBaseline: number;
  /** 最近一次更新的 Unix ms */
  updatedAt: number;
};

/** 下发前端的每供应商余额行。 */
export type BalanceSnapshotRow = {
  provider: string;
  /** 设置的余额；未设置过为 null */
  balance: number | null;
  /** 已扣（累计成本 - 基线，下限 0） */
  spent: number;
  /** 剩余 = balance - spent；未设置余额为 null */
  remaining: number | null;
  /** 该 provider 出现过 costKnown=false 的记录（成本可能被低估） */
  costKnown: boolean;
  /** 是否在 usage.jsonl 中出现过（无用量但配置了余额也展示） */
  hasUsage: boolean;
};

type StoredBalanceFile = {
  version?: unknown;
  balances?: Record<string, unknown>;
};

type StoredEntry = Record<string, unknown> & {
  balance?: unknown;
  spentBaseline?: unknown;
  updatedAt?: unknown;
};

// ============================================================================
// 配置读写（容错解析 + 原子写）
// ============================================================================

export function getBalancesFilePath(agentDir = getAgentDir()): string {
  return join(agentDir, "analytics", "balances.json");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseStoredEntry(entry: unknown): ProviderBalanceConfig | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const { balance, spentBaseline, updatedAt } = entry as StoredEntry;
  if (balance !== null && !isFiniteNumber(balance)) return null;
  if (!isFiniteNumber(spentBaseline) || !isFiniteNumber(updatedAt)) return null;
  return {
    balance: balance === null ? null : Math.max(0, balance as number),
    spentBaseline: Math.max(0, spentBaseline as number),
    updatedAt: updatedAt as number,
  };
}

/** 读取全部余额配置；文件缺失/损坏时返回空对象。 */
export function readBalanceConfigs(filePath = getBalancesFilePath()): Record<string, ProviderBalanceConfig> {
  if (!existsSync(filePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const balances = (parsed as StoredBalanceFile).balances;
  if (balances === null || typeof balances !== "object" || Array.isArray(balances)) return {};

  const result: Record<string, ProviderBalanceConfig> = {};
  for (const [provider, entry] of Object.entries(balances)) {
    const config = parseStoredEntry(entry);
    if (config) result[provider] = config;
  }
  return result;
}

/**
 * 写入某个供应商的余额配置。balance 为 null 时清除该供应商配置；
 * resetSpent 为 true 时把 spentBaseline 设为 currentCost（重置已扣基线）。
 * 更新后返回该供应商的完整配置（未设置时为 null）。
 */
export function saveProviderBalance(
  provider: string,
  balance: number | null,
  opts: { resetSpent?: boolean; currentCost?: number } = {},
  filePath = getBalancesFilePath(),
): ProviderBalanceConfig | null {
  const configs = readBalanceConfigs(filePath);
  const existing = configs[provider];
  const baseline =
    existing && !opts.resetSpent
      ? existing.spentBaseline
      : opts.resetSpent
        ? Math.max(0, opts.currentCost ?? 0)
        : 0;

  if (balance === null) {
    delete configs[provider];
  } else {
    configs[provider] = {
      balance,
      spentBaseline: baseline,
      updatedAt: Date.now(),
    };
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writePrivateFileAtomicSync(
    filePath,
    JSON.stringify({ version: 1, balances: configs }, null, 2),
  );
  return configs[provider] ?? null;
}

// ============================================================================
// 扣减计算（纯函数，便于单测）
// ============================================================================

/** 从中间态归集每个 provider 的累计成本与成本可知性。 */
export function aggregateProviderCosts(
  intermediate: UsageStatsIntermediate,
): Map<string, { cost: number; turns: number; costKnown: boolean }> {
  const map = new Map<string, { cost: number; turns: number; costKnown: boolean }>();
  // 全局 costKnown 无法拆到 provider；这里用中间态的总标志兜底（true=全部可知）。
  const allCostKnown = intermediate.costKnown;
  for (const day of intermediate.dayBuckets) {
    for (const slice of day.byProvider) {
      const entry = map.get(slice.provider) ?? { cost: 0, turns: 0, costKnown: allCostKnown };
      entry.cost += slice.cost;
      entry.turns += slice.turns;
      map.set(slice.provider, entry);
    }
  }
  return map;
}

/**
 * 计算所有供应商的余额快照行：usage 中出现的 provider ∪ 已配置余额的 provider。
 * 排序：有配置的在前（按剩余升序，快超支的靠前），其余按累计成本降序。
 */
export function computeBalances(
  intermediate: UsageStatsIntermediate | null,
  filePath = getBalancesFilePath(),
): BalanceSnapshotRow[] {
  const configs = readBalanceConfigs(filePath);
  const usage = intermediate ? aggregateProviderCosts(intermediate) : new Map<string, never>();

  const rows: BalanceSnapshotRow[] = [];
  const seen = new Set<string>();

  const push = (provider: string, hasUsage: boolean) => {
    if (seen.has(provider)) return;
    seen.add(provider);
    const usageInfo = usage.get(provider);
    const config = configs[provider];
    const cost = usageInfo?.cost ?? 0;
    const spent = Math.max(0, cost - (config?.spentBaseline ?? 0));
    rows.push({
      provider,
      balance: config?.balance ?? null,
      spent,
      remaining: config?.balance === null || config?.balance === undefined ? null : config.balance - spent,
      costKnown: usageInfo?.costKnown ?? true,
      hasUsage,
    });
  };

  // 有配置的优先（即使无用量）
  for (const provider of Object.keys(configs).sort()) push(provider, usage.has(provider));
  // usage 中出现的剩余 provider
  for (const provider of [...usage.keys()].sort()) push(provider, true);

  rows.sort((a, b) => {
    const aCfg = a.balance !== null ? 1 : 0;
    const bCfg = b.balance !== null ? 1 : 0;
    if (aCfg !== bCfg) return bCfg - aCfg;
    if (aCfg) {
      // 配置过：剩余最少（最接近超支）的靠前；未配置剩余为 null 排后
      const aRem = a.remaining ?? Number.POSITIVE_INFINITY;
      const bRem = b.remaining ?? Number.POSITIVE_INFINITY;
      if (aRem !== bRem) return aRem - bRem;
    }
    const aCost = usage.get(a.provider)?.cost ?? 0;
    const bCost = usage.get(b.provider)?.cost ?? 0;
    return bCost - aCost;
  });

  return rows;
}

// ============================================================================
// 逐消息余额时间线（余额快照按请求时刻推进）
// ============================================================================

/**
 * 每个 provider 的请求时间线：按 ts 升序的累计已扣金额序列。
 * 对给定的一组消息 timestamp，返回每条的 remaining（balance - 截至该时刻累计已扣）。
 * 时间戳取全局并集（所有会话共享同一余额，跨会话请求也扣减）。
 */
export function computeRemainingSeries(
  records: readonly UsageRecord[],
  timestamps: readonly number[],
  filePath = getBalancesFilePath(),
): {
  providers: Record<string, { balance: number | null; remainingSeries: (number | null)[] }>;
} {
  const configs = readBalanceConfigs(filePath);
  // 只为已配置余额（或 usage 中出现）的 provider 构建时间线
  const interested = new Set<string>([
    ...Object.keys(configs),
    ...new Set(records.map((r) => r.model.split("/")[0] ?? r.model)),
  ]);
  // 记录按 ts 升序
  const sorted = [...records].sort((a, b) => a.ts - b.ts);
  // provider → [{ts, spent}] 累计已扣
  const timelines: Map<string, { ts: number; spent: number; totalCost: number }[]> = new Map();
  for (const provider of interested) timelines.set(provider, []);
  for (const rec of sorted) {
    const provider = rec.model.split("/")[0] ?? rec.model;
    const arr = timelines.get(provider);
    if (!arr) continue;
    const baseline = configs[provider]?.spentBaseline ?? 0;
    const totalCost = (arr.length > 0 ? arr[arr.length - 1].totalCost : 0) + rec.cost;
    // 累计原始成本一次性减基线，下限 0
    arr.push({ ts: rec.ts, spent: Math.max(0, totalCost - baseline), totalCost });
  }
  // 二分查找每个 timestamp 的时刻
  const result: Record<string, { balance: number | null; remainingSeries: (number | null)[] }> = {};
  for (const provider of interested) {
    const arr = timelines.get(provider)!;
    const balance = configs[provider]?.balance ?? null;
    const remainingSeries = timestamps.map((ts) => {
      if (!arr.length) {
        return balance === null ? null : balance;
      }
      // 找到最后一个 spent 且 ts ≤ 给定时刻的条目
      let lo = 0;
      let hi = arr.length - 1;
      let idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].ts <= ts) {
          idx = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      const spent = idx >= 0 ? arr[idx].spent : 0;
      return balance === null ? null : balance - spent;
    });
    result[provider] = { balance, remainingSeries };
  }
  return { providers: result };
}
