import type { PeakPricingConfig } from "@/lib/usage-peak-pricing";

export interface CompatEntry {
  compat?: Record<string, unknown>;
}

export interface HeaderRow {
  id: number;
  name: string;
  value: string;
}

export const MODEL_COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

export type ModelCostKey = (typeof MODEL_COST_KEYS)[number];

export type ModelCostRates = Record<ModelCostKey, number>;

export type ModelCostDraft = Record<ModelCostKey, string>;

export function modelCostToDraft(cost?: Partial<ModelCostRates>): ModelCostDraft {
  return {
    input: cost?.input === undefined ? "" : String(cost.input),
    output: cost?.output === undefined ? "" : String(cost.output),
    cacheRead: cost?.cacheRead === undefined ? "" : String(cost.cacheRead),
    cacheWrite: cost?.cacheWrite === undefined ? "" : String(cost.cacheWrite),
  };
}

export function parseCompleteModelCost(draft: ModelCostDraft): ModelCostRates | undefined {
  if (!hasModelCostDraftValue(draft)) return undefined;

  const parse = (value: string): number | undefined => {
    if (!value.trim()) return 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const input = parse(draft.input);
  const output = parse(draft.output);
  const cacheRead = parse(draft.cacheRead);
  const cacheWrite = parse(draft.cacheWrite);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite };
}

export function hasModelCostDraftValue(draft: ModelCostDraft): boolean {
  return MODEL_COST_KEYS.some((key) => draft[key].trim() !== "");
}

export function setCompatBool<T extends CompatEntry>(entry: T, key: string, value: boolean): T {
  return {
    ...entry,
    compat: { ...(entry.compat ?? {}), [key]: value },
  };
}

export function updateHeaderRow(
  rows: readonly HeaderRow[],
  id: number,
  changes: Partial<Pick<HeaderRow, "name" | "value">>,
): HeaderRow[] {
  return rows.map((row) => row.id === id ? { ...row, ...changes } : row);
}

export function serializeHeaderRows(rows: readonly HeaderRow[]): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name) headers[name] = row.value;
  }
  return Object.keys(headers).length ? headers : undefined;
}

// ============================================================================
// 峰谷定价 draft（与 cost 编辑区共用同一交互模式）
// ============================================================================

export type PeakHourDraft = { start: string; end: string };

export type PeakPricingDraft = {
  enabled: boolean;
  hours: PeakHourDraft[];
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
};

export function peakPricingToDraft(peak?: PeakPricingConfig): PeakPricingDraft {
  return {
    enabled: Boolean(peak),
    hours: (peak?.hours ?? []).map((h) => ({
      start: Number.isFinite(h.start) ? String(h.start) : "",
      end: Number.isFinite(h.end) ? String(h.end) : "",
    })),
    input: peak?.input === undefined ? "" : String(peak.input),
    output: peak?.output === undefined ? "" : String(peak.output),
    cacheRead: peak?.cacheRead === undefined ? "" : String(peak.cacheRead),
    cacheWrite: peak?.cacheWrite === undefined ? "" : String(peak.cacheWrite),
  };
}

/** 峰时段 0-23 小时制整数，可跨午夜（start > end）。非法时段被过滤。 */
function parsePeakHours(draft: PeakPricingDraft): { start: number; end: number }[] {
  return draft.hours
    .map((h) => ({ start: Number(h.start), end: Number(h.end) }))
    .filter((h) => Number.isInteger(h.start) && Number.isInteger(h.end) && h.start >= 0 && h.start <= 23 && h.end >= 0 && h.end <= 24);
}

/** 完整解析峰谷配置；未启用或数据不完整返回 undefined。 */
export function parseCompletePeakPricing(draft: PeakPricingDraft): PeakPricingConfig | undefined {
  if (!draft.enabled) return undefined;
  const hours = parsePeakHours(draft);
  if (hours.length === 0) return undefined;
  const parse = (value: string): number | undefined => {
    if (!value.trim()) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const input = parse(draft.input);
  const output = parse(draft.output);
  const cacheRead = parse(draft.cacheRead);
  const cacheWrite = parse(draft.cacheWrite);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) {
    return undefined;
  }
  return { hours, input, output, cacheRead, cacheWrite };
}
