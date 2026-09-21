/**
 * 峰谷定价（Peak/Off-Peak pricing）。
 *
 * 模型可在 models.json 的 `cost.peak` 配置峰谷定价：
 *   cost: { input, output, cacheRead, cacheWrite,        // 谷时价（基础价）
 *           peak: { hours: [{start,end}],                 // 峰时段（本地时区 24h，start <= end；start>end 视为跨午夜）
 *                   input, output, cacheRead, cacheWrite } }  // 峰时价
 *
 * usage 统计聚合前，对配置了 peak 的模型按记录时间戳（本地时区）判断峰/谷，
 * 用对应单价重算 cost = (input×pIn + output×pOut + cacheRead×pCr + cacheWrite×pCw) / 1e6。
 * 未配置 peak 的模型不重算（保持 pi-tracker 写入的 cost）。
 */

import { readModelsConfig } from "./models-config-store";

export type PeakHours = { start: number; end: number };

export type PeakPricingRates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type PeakPricingConfig = {
  hours: PeakHours[];
} & PeakPricingRates;

/** 记录级单价（与 cost 字段同构，含基础价与可选峰时价）。 */
export type ModelCostWithPeak = PeakPricingRates & { peak?: PeakPricingConfig };

export type UsageRecordLike = {
  ts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** ts 是否落在任一峰时段（本地时区，跨午夜窗口支持 start > end）。 */
export function isPeakHour(ts: number, hours: PeakHours[]): boolean {
  if (!Array.isArray(hours) || hours.length === 0) return false;
  const h = new Date(ts).getHours();
  for (const window of hours) {
    const { start, end } = window;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start < 0 || start > 23 || end < 0 || end > 24) continue;
    // start ∈ [0,23]，end ∈ [0,24]（24 = 次日 00:00，用于全天窗口）
    if (start <= end) {
      if (h >= start && h < end) return true;
    } else if (h >= start || h < end) {
      // 跨午夜：22:00-02:00 → 22:00 起至 24:00，再加 00:00 至 02:00
      return true;
    }
  }
  return false;
}

/** 按峰谷单价重算一条记录的 cost；返回 null = 不应重算（未配置 peak）。 */
export function repricedCost(
  record: UsageRecordLike,
  cost: ModelCostWithPeak | undefined,
): number | null {
  if (!cost || !cost.peak) return null;
  const rates = isPeakHour(record.ts, cost.peak.hours) ? cost.peak : cost;
  return (
    record.input * rates.input
    + record.output * rates.output
    + record.cacheRead * rates.cacheRead
    + record.cacheWrite * rates.cacheWrite
  ) / 1_000_000;
}

/**
 * 构建 "provider/model" → ModelCostWithPeak 的映射（读 models.json）。
 * 与 usage-stats 的 `providerOf` 拼接规则保持一致：model 记录形如 "provider/model"。
 */
export function buildModelCostMap(): Map<string, ModelCostWithPeak> {
  const map = new Map<string, ModelCostWithPeak>();
  const config = readModelsConfig();
  const providers = config.providers;
  if (!providers || typeof providers !== "object") return map;
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== "object") continue;
    const models = (provider as { models?: unknown }).models;
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      if (!model || typeof model !== "object") continue;
      const { id, cost } = model as { id?: unknown; cost?: unknown };
      if (typeof id !== "string" || !id) continue;
      if (!cost || typeof cost !== "object") continue;
      const costObj = cost as ModelCostWithPeak;
      if (typeof costObj.input !== "number" || typeof costObj.output !== "number") continue;
      map.set(`${providerId}/${id}`, costObj);
    }
  }
  return map;
}