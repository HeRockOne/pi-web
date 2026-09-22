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
    .map((h) => ({ start: h.start.trim(), end: h.end.trim() }))
    .filter((h) => h.start !== "" && h.end !== "")
    .map((h) => ({ start: Number(h.start), end: Number(h.end) }))
    .filter((h) => Number.isInteger(h.start) && Number.isInteger(h.end) && h.start >= 0 && h.start <= 23 && h.end >= 0 && h.end <= 24);
}

/** 峰时价解析结果：时段 + 已填写的峰时价格（未填项由调用方用基础价兜底）。 */
export type PeakPricingRatesPartial = Partial<Record<ModelCostKey, number>>;

/** 完整解析峰谷配置；未启用、无有效峰时段、或一项峰时价都没填时返回 undefined。 */
export function parseCompletePeakPricing(
  draft: PeakPricingDraft,
): ({ hours: { start: number; end: number }[] } & PeakPricingRatesPartial) | undefined {
  if (!draft.enabled) return undefined;
  const hours = parsePeakHours(draft);
  if (hours.length === 0) return undefined;
  const parse = (value: string): number | undefined => {
    if (!value.trim()) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const rates: PeakPricingRatesPartial = {};
  for (const key of MODEL_COST_KEYS) {
    const value = parse(draft[key]);
    if (value !== undefined) rates[key] = value;
  }
  if (Object.keys(rates).length === 0) return undefined;
  return { hours, ...rates };
}

/**
 * 谷时段 = 峰时段的补集（按小时 bitset 求反）。返回不重叠的 [start, end) 区间，
 * end=24 表示到次日 00:00；跨午夜窗口（start>end）先展开归一化。
 * 供弹窗展示「其余时间自动为谷时」。
 */
export function offPeakWindows(hours: PeakHourDraft[]): { start: number; end: number }[] {
  const peak = new Array<boolean>(24).fill(false);
  for (const h of hours) {
    const start = Number(h.start);
    const end = Number(h.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > 23 || end < 0 || end > 24) continue;
    if (start <= end) {
      for (let x = start; x < end; x++) peak[x] = true;
    } else {
      for (let x = start; x < 24; x++) peak[x] = true;
      for (let x = 0; x < end; x++) peak[x] = true;
    }
  }
  const out: { start: number; end: number }[] = [];
  let i = 0;
  while (i < 24) {
    if (!peak[i]) {
      let j = i;
      while (j < 24 && !peak[j]) j++;
      out.push({ start: i, end: j });
      i = j;
    } else {
      i++;
    }
  }
  return out;
}
/** The parts of models.json the rename tracking needs. */
export interface ModelsConfigDraft {
  providers?: Record<string, { models?: { id: string }[] }>;
}

/** Snapshot of the model ids models.json holds, by provider and slot. */
export function savedModelIds(config: ModelsConfigDraft): Map<string, (string | null)[]> {
  return new Map(Object.entries(config.providers ?? {}).map(([name, provider]) => [
    name,
    (provider.models ?? []).map((model) => model.id),
  ]));
}

export function trackAddedModels(slots: Map<string, (string | null)[]>, providerName: string, count: number) {
  if (count <= 0) return;
  const existing = slots.get(providerName) ?? [];
  slots.set(providerName, [...existing, ...Array.from({ length: count }, () => null)]);
}

/**
 * Model ids that changed in place since the last save, as full references.
 *
 * `from` keeps the provider id the settings file still spells, so the server
 * can rewrite the entry before it applies the provider renames.
 */
export function collectModelRenames(
  config: ModelsConfigDraft,
  slots: Map<string, (string | null)[]>,
  providerRenames: Map<string, string>,
): { from: string; to: string }[] {
  const originalProvider = (name: string) => {
    for (const [from, to] of providerRenames) if (to === name) return from;
    return name;
  };

  const renames: { from: string; to: string }[] = [];
  for (const [name, provider] of Object.entries(config.providers ?? {})) {
    const saved = slots.get(name);
    if (!saved) continue;
    (provider.models ?? []).forEach((model, index) => {
      const before = saved[index];
      if (!before || !model.id || before === model.id) return;
      renames.push({ from: `${originalProvider(name)}/${before}`, to: `${name}/${model.id}` });
    });
  }
  return renames;
}
