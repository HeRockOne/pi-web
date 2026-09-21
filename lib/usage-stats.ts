/**
 * 用量统计（Usage Stats）服务端模块。
 *
 * 移植自 PiDeck（github.com/ayuayue/PiDeck）的 usageStats 模块，数据源为
 * pi-tracker 扩展写入的 <agentDir>/analytics/usage.jsonl（append-only，位置
 * 数组行 10/11 字段）。pi-web 只读数据做展示，不承担采集职责。
 *
 * 与 PiDeck 的差异：
 *  - 只保留 pi 一路数据源（DSH 的 dsh-bill 不适用）；
 *  - 增量游标只存内存（globalThis，跨热更新存活）；服务重启退化为一次全量
 *    重扫，日志有 256MB 截读上限兜底；
 *  - 聚合三段式（扫描 → 中间态 → 派生视图）与 PiDeck 保持一致。
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { buildModelCostMap, repricedCost, type ModelCostWithPeak } from "./usage-peak-pricing";

// ============================================================================
// 类型（对应 PiDeck shared/types/usageStats.ts）
// ============================================================================

/** 单条用量记录（对应 usage.jsonl 一行，位置数组 10/11 字段）。 */
export type UsageRecord = {
  /** Unix ms */
  ts: number;
  /** 会话 id（pi-tracker 记录的是会话文件路径） */
  sid: string;
  /** pi 进程 cwd */
  cwd: string;
  /** "provider/model" */
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  /** true=provider 实际返回了定价；false=成本未知（显示 n/a 而非 0） */
  costKnown: boolean;
};

/** 单日（或区间）合计。 */
export type DayTotals = {
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  /** 有记录的会话 id 列表（去重） */
  sessions: string[];
};

export type ProviderSlice = {
  provider: string;
  tokens: number;
  cost: number;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type UsageDayModelSlice = {
  model: string;
  provider: string;
  tokens: number;
  cost: number;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
export type UsageDayProjectSlice = { project: string; tokens: number; cost: number; turns: number };

/** 某天用量行（含 provider 分解与模型/项目明细）。 */
export type UsageDayRow = {
  /** "YYYY-MM-DD" 本地时区 */
  day: string;
  totals: DayTotals;
  byProvider: ProviderSlice[];
  byModel: UsageDayModelSlice[];
  byProject: UsageDayProjectSlice[];
};

/** 热力图格子（53 周 × 7 天，周一起始）。 */
export type HeatmapCell = {
  tokens: number;
  turns: number;
  /** 0-4 档色阶（固定阈值，跨天可比） */
  level: 0 | 1 | 2 | 3 | 4;
};

export type UsageModelRow = {
  model: string;
  provider: string;
  tokens: number;
  cost: number;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  sessions: number;
};

export type UsageProjectRow = {
  project: string;
  tokens: number;
  cost: number;
  turns: number;
};

/** 聚合视图（服务端聚合后整体下发，前端不接触原始日志）。 */
export type UsageAggregated = {
  window: { since: number; to: number };
  totals: DayTotals;
  activeDays: number;
  today: DayTotals;
  thisWeek: DayTotals;
  thisMonth: DayTotals;
  daily: UsageDayRow[];
  heatmap: HeatmapCell[];
  heatmapStart: string;
  byModel: UsageModelRow[];
  byProject: UsageProjectRow[];
  costKnown: boolean;
  recordCount: number;
};

// ============================================================================
// 行解析（防御式纯函数，与 pi-tracker 0.3.x 格式兼容）
// ============================================================================

const ACCEPTED_FIELD_COUNTS = new Set([10, 11]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 11 字段直接读 costKnown；10 字段按 cost > 0 推断（与 pi-tracker 一致）。 */
function parseCostKnown(row: unknown[], cost: number): boolean {
  if (row.length > 10) return row[10] === 1;
  return cost > 0;
}

/** 解析一行；非法行返回 null（调用方计数跳过，不中断）。 */
export function parseUsageLogLine(line: string): UsageRecord | null {
  if (!line.trim()) return null;

  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (!Array.isArray(row)) return null;
  if (!ACCEPTED_FIELD_COUNTS.has(row.length)) return null;

  const ts = row[0];
  const sid = row[1];
  const cwd = row[2];
  const model = row[3];
  const input = row[4];
  const output = row[5];
  const cacheRead = row[6];
  const cacheWrite = row[7];
  const totalTokens = row[8];
  const cost = row[9];

  if (!isFiniteNumber(ts) || ts <= 0) return null;
  if (typeof sid !== "string" || sid.length === 0) return null;
  if (typeof cwd !== "string") return null;
  if (typeof model !== "string" || model.length === 0) return null;
  for (const value of [input, output, cacheRead, cacheWrite, totalTokens, cost]) {
    if (!isFiniteNumber(value)) return null;
  }

  return {
    ts,
    sid,
    cwd,
    model,
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost,
    costKnown: parseCostKnown(row, cost),
  };
}

// ============================================================================
// 聚合（纯函数）：记录 → 中间态 → 派生视图
// ============================================================================

const DAY_MS = 24 * 3600 * 1000;
const HEATMAP_WEEKS = 53;
const HEATMAP_CELLS = HEATMAP_WEEKS * 7;

/** 可序列化中间态（增量合并用；sessions 用数组）。 */
export type UsageStatsIntermediate = {
  dayBuckets: Array<{
    day: string;
    totals: DayTotals;
    sessions: string[];
    byProvider: ProviderSlice[];
    byModel: UsageDayModelSlice[];
    byProject: UsageDayProjectSlice[];
  }>;
  modelBuckets: Array<{ model: string; provider: string; tokens: number; cost: number; turns: number; input: number; output: number; cacheRead: number; cacheWrite: number; sessions: string[] }>;
  projectBuckets: Array<{ project: string; tokens: number; cost: number; turns: number; sessions: string[] }>;
  totals: DayTotals;
  window: { since: number; to: number };
  costKnown: boolean;
  recordCount: number;
};

/** 本地时区日键 "YYYY-MM-DD"。 */
function dayKeyOf(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function localWeekStart(d: Date): Date {
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}

function emptyTotals(): DayTotals {
  return { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, sessions: [] };
}

/** 固定阈值分档（跨天可比）。 */
function levelFor(tokens: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0) return 0;
  if (tokens < 100) return 1;
  if (tokens < 1000) return 2;
  if (tokens < 100000) return 3;
  return 4;
}

/** "provider/model" → provider（第一个 "/" 前部分）。 */
function providerOf(model: string): string {
  const idx = model.indexOf("/");
  return idx === -1 ? model : model.slice(0, idx);
}

type DayBucket = {
  totals: DayTotals;
  sessions: Set<string>;
  byProvider: Map<string, ProviderSlice>;
  byModel: Map<string, UsageDayModelSlice>;
  byProject: Map<string, UsageDayProjectSlice>;
};

function addToProvider(map: Map<string, ProviderSlice>, provider: string, r: UsageRecord): void {
  let slice = map.get(provider);
  if (!slice) {
    slice = { provider, tokens: 0, cost: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    map.set(provider, slice);
  }
  slice.tokens += r.totalTokens;
  slice.cost += r.cost;
  slice.turns += 1;
  slice.input += r.input;
  slice.output += r.output;
  slice.cacheRead += r.cacheRead;
  slice.cacheWrite += r.cacheWrite;
}

/** 扫描记录 → 中间态。 */
export function intermediateFromRecords(records: UsageRecord[]): UsageStatsIntermediate {
  const dayBuckets = new Map<string, DayBucket>();
  const totals = emptyTotals();
  const totalSessions = new Set<string>();
  const byModel = new Map<string, { provider: string; tokens: number; cost: number; turns: number; sessions: Set<string>; input: number; output: number; cacheRead: number; cacheWrite: number }>();
  const byProject = new Map<string, { tokens: number; cost: number; turns: number; sessions: Set<string> }>();
  let firstTs = Number.POSITIVE_INFINITY;
  let lastTs = Number.NEGATIVE_INFINITY;
  let allCostKnown = true;

  for (const r of records) {
    const dayKey = dayKeyOf(new Date(r.ts));
    let bucket = dayBuckets.get(dayKey);
    if (!bucket) {
      bucket = {
        totals: emptyTotals(),
        sessions: new Set(),
        byProvider: new Map(),
        byModel: new Map(),
        byProject: new Map(),
      };
      dayBuckets.set(dayKey, bucket);
    }
    bucket.totals.tokens += r.totalTokens;
    bucket.totals.input += r.input;
    bucket.totals.output += r.output;
    bucket.totals.cacheRead += r.cacheRead;
    bucket.totals.cacheWrite += r.cacheWrite;
    bucket.totals.cost += r.cost;
    bucket.totals.turns += 1;
    bucket.sessions.add(r.sid);
    addToProvider(bucket.byProvider, providerOf(r.model), r);

    let dayModel = bucket.byModel.get(r.model);
    if (!dayModel) {
      dayModel = { model: r.model, provider: providerOf(r.model), tokens: 0, cost: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      bucket.byModel.set(r.model, dayModel);
    }
    dayModel.tokens += r.totalTokens;
    dayModel.cost += r.cost;
    dayModel.turns += 1;
    dayModel.input += r.input;
    dayModel.output += r.output;
    dayModel.cacheRead += r.cacheRead;
    dayModel.cacheWrite += r.cacheWrite;

    let dayProject = bucket.byProject.get(r.cwd);
    if (!dayProject) {
      dayProject = { project: r.cwd, tokens: 0, cost: 0, turns: 0 };
      bucket.byProject.set(r.cwd, dayProject);
    }
    dayProject.tokens += r.totalTokens;
    dayProject.cost += r.cost;
    dayProject.turns += 1;

    totals.tokens += r.totalTokens;
    totals.input += r.input;
    totals.output += r.output;
    totals.cacheRead += r.cacheRead;
    totals.cacheWrite += r.cacheWrite;
    totals.cost += r.cost;
    totals.turns += 1;
    totalSessions.add(r.sid);

    let modelRow = byModel.get(r.model);
    if (!modelRow) {
      modelRow = { provider: providerOf(r.model), tokens: 0, cost: 0, turns: 0, sessions: new Set(), input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      byModel.set(r.model, modelRow);
    }
    modelRow.tokens += r.totalTokens;
    modelRow.cost += r.cost;
    modelRow.turns += 1;
    modelRow.input += r.input;
    modelRow.output += r.output;
    modelRow.cacheRead += r.cacheRead;
    modelRow.cacheWrite += r.cacheWrite;
    modelRow.sessions.add(r.sid);

    let projectRow = byProject.get(r.cwd);
    if (!projectRow) {
      projectRow = { tokens: 0, cost: 0, turns: 0, sessions: new Set() };
      byProject.set(r.cwd, projectRow);
    }
    projectRow.tokens += r.totalTokens;
    projectRow.cost += r.cost;
    projectRow.turns += 1;
    projectRow.sessions.add(r.sid);

    if (r.ts < firstTs) firstTs = r.ts;
    if (r.ts > lastTs) lastTs = r.ts;
    if (!r.costKnown) allCostKnown = false;
  }

  return {
    dayBuckets: [...dayBuckets.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([day, bucket]) => ({
        day,
        totals: { ...bucket.totals, sessions: [...bucket.sessions] },
        sessions: [...bucket.sessions],
        byProvider: [...bucket.byProvider.values()].sort((a, b) => b.tokens - a.tokens),
        byModel: [...bucket.byModel.values()].sort((a, b) => b.tokens - a.tokens),
        byProject: [...bucket.byProject.values()].sort((a, b) => b.tokens - a.tokens),
      })),
    modelBuckets: [...byModel.entries()]
      .sort(([, a], [, b]) => b.tokens - a.tokens)
      .map(([model, row]) => ({
        model,
        provider: row.provider,
        tokens: row.tokens,
        cost: row.cost,
        turns: row.turns,
        input: row.input,
        output: row.output,
        cacheRead: row.cacheRead,
        cacheWrite: row.cacheWrite,
        sessions: [...row.sessions],
      })),
    projectBuckets: [...byProject.entries()]
      .sort(([, a], [, b]) => b.tokens - a.tokens)
      .map(([project, row]) => ({
        project,
        tokens: row.tokens,
        cost: row.cost,
        turns: row.turns,
        sessions: [...row.sessions],
      })),
    totals: { ...totals, sessions: [...totalSessions] },
    window: {
      since: Number.isFinite(firstTs) ? firstTs : 0,
      to: Number.isFinite(lastTs) ? lastTs : -1,
    },
    costKnown: allCostKnown,
    recordCount: records.length,
  };
}

function mergeTotals(a: DayTotals, b: DayTotals): DayTotals {
  return {
    tokens: a.tokens + b.tokens,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost + b.cost,
    turns: a.turns + b.turns,
    sessions: [...new Set([...a.sessions, ...b.sessions])],
  };
}

function mergeDaySlices<T extends { tokens: number; cost: number; turns: number }>(
  keyOf: (slice: T) => string,
  base: T[],
  delta: T[],
): T[] {
  const merged = new Map(base.map((slice) => [keyOf(slice), slice]));
  for (const slice of delta) {
    const existing = merged.get(keyOf(slice));
    if (existing) {
      existing.tokens += slice.tokens;
      existing.cost += slice.cost;
      existing.turns += slice.turns;
    } else {
      merged.set(keyOf(slice), slice);
    }
  }
  return [...merged.values()].sort((a, b) => b.tokens - a.tokens);
}

/** 合并两个中间态（增量刷新：新段 + 旧缓存）。纯合并，不重新扫描记录。 */
export function mergeIntermediates(
  base: UsageStatsIntermediate,
  delta: UsageStatsIntermediate,
): UsageStatsIntermediate {
  // 空增量 = no-op（避免空态的 window {0,-1} 污染 base）
  if (delta.recordCount === 0) return base;
  // 空 base = 直接取增量（避免空态 window.since=0 被 min 污染）
  if (base.recordCount === 0) return delta;

  const dayMap = new Map(base.dayBuckets.map((b) => [b.day, b]));
  for (const d of delta.dayBuckets) {
    const existing = dayMap.get(d.day);
    if (!existing) {
      dayMap.set(d.day, d);
      continue;
    }
    const byProvider = new Map(existing.byProvider.map((p) => [p.provider, p]));
    for (const p of d.byProvider) {
      const ep = byProvider.get(p.provider);
      if (ep) {
        ep.tokens += p.tokens;
        ep.cost += p.cost;
        ep.turns += p.turns;
      } else {
        byProvider.set(p.provider, p);
      }
    }
    dayMap.set(d.day, {
      day: d.day,
      totals: mergeTotals(existing.totals, d.totals),
      sessions: [...new Set([...existing.sessions, ...d.sessions])],
      byProvider: [...byProvider.values()].sort((a, b) => b.tokens - a.tokens),
      byModel: mergeDaySlices((m) => m.model, existing.byModel, d.byModel),
      byProject: mergeDaySlices((p) => p.project, existing.byProject, d.byProject),
    });
  }

  const mergeBuckets = <T extends { sessions: string[]; tokens: number; cost: number; turns: number }>(
    keyOf: (row: T) => string,
    baseRows: T[],
    deltaRows: T[],
  ): T[] => {
    const map = new Map(baseRows.map((row) => [keyOf(row), row]));
    for (const row of deltaRows) {
      const existing = map.get(keyOf(row));
      if (!existing) {
        map.set(keyOf(row), row);
        continue;
      }
      existing.tokens += row.tokens;
      existing.cost += row.cost;
      existing.turns += row.turns;
      existing.sessions = [...new Set([...existing.sessions, ...row.sessions])];
    }
    return [...map.values()].sort((a, b) => b.tokens - a.tokens);
  };

  return {
    dayBuckets: [...dayMap.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
    modelBuckets: mergeBuckets((m) => m.model, base.modelBuckets, delta.modelBuckets),
    projectBuckets: mergeBuckets((p) => p.project, base.projectBuckets, delta.projectBuckets),
    totals: mergeTotals(base.totals, delta.totals),
    window: {
      since: Math.min(base.window.since, delta.window.since),
      to: Math.max(base.window.to, delta.window.to),
    },
    costKnown: base.costKnown && delta.costKnown,
    recordCount: base.recordCount + delta.recordCount,
  };
}

/** 从中间态派生完整视图（today/周/月/热力图按 now 重建，跨刷新时间漂移安全）。 */
export function buildAggregatedView(
  state: UsageStatsIntermediate,
  now: Date = new Date(),
): UsageAggregated {
  const dayMap = new Map(state.dayBuckets.map((b) => [b.day, b]));

  const daily: UsageDayRow[] = state.dayBuckets.map((b) => ({
    day: b.day,
    totals: b.totals,
    byProvider: b.byProvider,
    byModel: b.byModel,
    byProject: b.byProject,
  }));

  // 热力图：以 now 所在周为最后一周，往前 52 周（共 53 列）。
  // 日历步进（setDate +1）而非固定 24h 毫秒步进：跨 DST 切换时毫秒步进会逐日漂移。
  const lastWeekStart = localWeekStart(now);
  const firstWeekStart = new Date(lastWeekStart.getTime() - (HEATMAP_WEEKS - 1) * 7 * DAY_MS);
  const heatmap: HeatmapCell[] = new Array(HEATMAP_CELLS);
  const cursor = new Date(firstWeekStart);
  for (let i = 0; i < HEATMAP_CELLS; i++) {
    const bucket = dayMap.get(dayKeyOf(cursor));
    const tokens = bucket ? bucket.totals.tokens : 0;
    heatmap[i] = {
      tokens,
      turns: bucket ? bucket.totals.turns : 0,
      level: levelFor(tokens),
    };
    cursor.setDate(cursor.getDate() + 1);
  }
  const heatmapStart = dayKeyOf(firstWeekStart);

  const todayKey = dayKeyOf(now);
  const weekStartKey = dayKeyOf(localWeekStart(now));
  const monthStartKey = dayKeyOf(new Date(now.getFullYear(), now.getMonth(), 1));
  const today = dayMap.get(todayKey);
  const thisWeek = state.dayBuckets
    .filter((b) => b.day >= weekStartKey)
    .reduce<DayTotals>((acc, b) => mergeTotals(acc, b.totals), emptyTotals());
  const thisMonth = state.dayBuckets
    .filter((b) => b.day >= monthStartKey)
    .reduce<DayTotals>((acc, b) => mergeTotals(acc, b.totals), emptyTotals());

  return {
    window: state.window,
    totals: state.totals,
    activeDays: daily.filter((d) => d.totals.tokens > 0).length,
    today: today ? today.totals : emptyTotals(),
    thisWeek,
    thisMonth,
    daily,
    heatmap,
    heatmapStart,
    byModel: state.modelBuckets.map((row) => ({
      model: row.model,
      provider: row.provider,
      tokens: row.tokens,
      cost: row.cost,
      turns: row.turns,
      input: row.input,
      output: row.output,
      cacheRead: row.cacheRead,
      cacheWrite: row.cacheWrite,
      sessions: row.sessions.length,
    })),
    byProject: state.projectBuckets.map((row) => ({
      project: row.project,
      tokens: row.tokens,
      cost: row.cost,
      turns: row.turns,
    })),
    costKnown: state.costKnown,
    recordCount: state.recordCount,
  };
}

// ============================================================================
// 增量读取 + 服务（游标存 globalThis，跨 Next.js 热更新存活）
// ============================================================================

/** 日志失控防御上限：单次读取超过即截断。 */
const DEFAULT_MAX_LOG_BYTES = 256 * 1024 * 1024;

/** 游标：上次读取结束时的文件状态。 */
type LogFileState = {
  size: number;
  mtimeMs: number;
  ino?: number;
};

function decodeLine(buffer: Buffer): string {
  const content =
    buffer.length > 0 && buffer[buffer.length - 1] === 0x0d
      ? buffer.subarray(0, buffer.length - 1)
      : buffer;
  return content.toString("utf8");
}

/** 严格 LF 行切分：跨 chunk 片段缓冲（U+2028/2029 在 JSON 字符串内合法，不得拆行）。 */
async function* physicalLines(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  let fragments: Buffer[] = [];
  let fragmentsBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    let newline = buffer.indexOf(0x0a);
    while (newline !== -1) {
      const fragment = buffer.subarray(start, newline);
      const lineBuffer =
        fragments.length === 0
          ? fragment
          : Buffer.concat([...fragments, fragment], fragmentsBytes + fragment.length);
      fragments = [];
      fragmentsBytes = 0;
      yield decodeLine(lineBuffer);
      start = newline + 1;
      newline = buffer.indexOf(0x0a, start);
    }
    if (start < buffer.length) {
      fragments.push(Buffer.from(buffer.subarray(start)));
      fragmentsBytes += buffer.length - start;
    }
  }
  if (fragmentsBytes > 0) {
    yield decodeLine(Buffer.concat(fragments, fragmentsBytes));
  }
}

type IncrementalReadResult = {
  newRecords: UsageRecord[];
  fullRescan: boolean;
  fileState: LogFileState | null;
  skippedLines: number;
  truncated: boolean;
};

async function readIncremental(
  logPath: string,
  prev: LogFileState | null,
): Promise<IncrementalReadResult> {
  let fileStat;
  try {
    fileStat = await stat(logPath);
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") {
      return { newRecords: [], fullRescan: false, fileState: null, skippedLines: 0, truncated: false };
    }
    throw error;
  }

  const current: LogFileState = { size: fileStat.size, mtimeMs: fileStat.mtimeMs, ino: fileStat.ino };
  const inodeChanged = prev !== null && prev.ino !== undefined && prev.ino !== fileStat.ino;
  const fullRescan =
    !prev
    || fileStat.size < prev.size
    || inodeChanged
    || (fileStat.size === prev.size && fileStat.mtimeMs !== prev.mtimeMs);
  if (prev && !fullRescan && fileStat.size === prev.size && fileStat.mtimeMs === prev.mtimeMs) {
    return { newRecords: [], fullRescan: false, fileState: prev, skippedLines: 0, truncated: false };
  }

  // 超限截读：防御日志失控（正常增量只读新增段，超限只出现在全量重扫）
  const truncated = fileStat.size > DEFAULT_MAX_LOG_BYTES;
  const endOffset = truncated ? DEFAULT_MAX_LOG_BYTES - 1 : undefined;
  const startOffset = fullRescan || !prev ? 0 : prev.size;
  const stream = createReadStream(logPath, {
    start: startOffset,
    end: endOffset,
    highWaterMark: 64 * 1024,
  });

  const newRecords: UsageRecord[] = [];
  const seenKeys = new Set<string>();
  let skippedLines = 0;

  for await (const line of physicalLines(stream)) {
    if (!line.trim()) continue;
    const record = parseUsageLogLine(line);
    if (!record) {
      skippedLines++;
      continue;
    }
    // 本次读取范围内去重（防御：文件被非 append 方式改写造成段内重复）
    const key = `${record.ts}|${record.sid}|${record.model}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    newRecords.push(record);
  }

  return {
    newRecords,
    fullRescan,
    truncated,
    fileState: current,
    skippedLines,
  };
}

type CachedUsageStats = {
  fileState: LogFileState | null;
  intermediate: UsageStatsIntermediate;
};

declare global {
  var __piUsageStats: {
    cached: CachedUsageStats | null;
    refreshPromise: Promise<void> | null;
  } | undefined;
}

// ============================================================================
// 记录级时间线缓存（独立于聚合中间态）
// 供余额时间线查询：全局所有请求按 ts 排序的原始记录。
// ============================================================================

type CachedUsageTimeline = {
  fileState: LogFileState | null;
  records: UsageRecord[];
};

declare global {
  var __piUsageTimeline: {
    cached: CachedUsageTimeline | null;
    refreshPromise: Promise<void> | null;
  } | undefined;
}

/** 增量刷新记录级缓存（单飞）。返回 null = 日志未安装。 */
async function refreshUsageTimeline(): Promise<void> {
  const state = (globalThis.__piUsageTimeline ??= { cached: null, refreshPromise: null });
  const { map: costMap, changed: pricingChanged } = modelCostMapIfChanged();
  const result = await readIncremental(
    usageLogPath(),
    pricingChanged ? null : (state.cached?.fileState ?? null),
  );
  if (!result.fileState) {
    state.cached = null;
    return;
  }
  const cached = state.cached;
  const newRecords = applyPeakPricing(result.newRecords, costMap);
  if (result.fullRescan) {
    state.cached = { fileState: result.fileState, records: newRecords };
  } else if (newRecords.length > 0) {
    state.cached = {
      fileState: result.fileState,
      records: cached ? [...cached.records, ...newRecords] : newRecords,
    };
  } else if (cached) {
    state.cached = { ...cached, fileState: result.fileState };
  }
}

/**
 * 查询全部原始用量记录（按日志追加顺序，未排序）；日志未安装时返回 null。
 * 与聚合中间态共用同一日志路径与游标逻辑，互不影响。
 */
export async function getUsageRecords(): Promise<UsageRecord[] | null> {
  const state = (globalThis.__piUsageTimeline ??= { cached: null, refreshPromise: null });
  if (!state.refreshPromise) {
    state.refreshPromise = refreshUsageTimeline().finally(() => {
      if (globalThis.__piUsageTimeline) globalThis.__piUsageTimeline.refreshPromise = null;
    });
  }
  await state.refreshPromise;
  return globalThis.__piUsageTimeline?.cached?.records ?? null;
}

function usageLogPath(): string {
  return join(getAgentDir(), "analytics", "usage.jsonl");
}

let pricingCache: { mtimeMs: number; map: Map<string, ModelCostWithPeak> } | null = null;

/** 探测 models.json 的 mtime；变化时重建峰谷价格映射（mtime=0 = 文件不存在）。 */
function modelCostMapIfChanged(): { map: Map<string, ModelCostWithPeak>; changed: boolean } {
  const modelsPath = join(getAgentDir(), "models.json");
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(modelsPath).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  if (pricingCache && pricingCache.mtimeMs === mtimeMs) {
    return { map: pricingCache.map, changed: false };
  }
  const map = mtimeMs === 0 ? new Map<string, ModelCostWithPeak>() : buildModelCostMap();
  pricingCache = { mtimeMs, map };
  return { map, changed: true };
}

/** 按峰谷定价重算记录 cost；未配置 peak 的模型保持 pi-tracker 原值。 */
function applyPeakPricing(
  records: UsageRecord[],
  map: Map<string, ModelCostWithPeak>,
): UsageRecord[] {
  if (map.size === 0) return records;
  let changed = false;
  const out = records.map((r) => {
    const cost = map.get(r.model);
    const c = cost ? repricedCost(r, cost) : null;
    if (c === null) return r;
    changed = true;
    return { ...r, cost: c, costKnown: true };
  });
  return changed ? out : records;
}

/** 增量刷新（单飞：并发请求共享同一次执行，防止同一批记录被合并两次）。 */
async function refreshUsageStats(): Promise<void> {
  const state = (globalThis.__piUsageStats ??= { cached: null, refreshPromise: null });
  const { map: costMap, changed: pricingChanged } = modelCostMapIfChanged();
  const result = await readIncremental(
    usageLogPath(),
    pricingChanged ? null : (state.cached?.fileState ?? null),
  );
  if (!result.fileState) {
    state.cached = null;
    return;
  }
  const newRecords = applyPeakPricing(result.newRecords, costMap);

  const cached = state.cached;
  if (result.fullRescan) {
    // 全量重扫：整体替换（0 条 = 文件被清空，必须提交空态，防止旧中间态复活双计）
    state.cached = { fileState: result.fileState, intermediate: intermediateFromRecords(newRecords) };
  } else if (result.newRecords.length > 0) {
    const delta = intermediateFromRecords(newRecords);
    state.cached = {
      fileState: result.fileState,
      intermediate: cached ? mergeIntermediates(cached.intermediate, delta) : delta,
    };
  } else if (cached) {
    // 文件变了但没有新记录（如 mtime 抖动）：仅更新游标
    state.cached = { ...cached, fileState: result.fileState };
  }
}

export type UsageStatsSnapshot = {
  installed: boolean;
  logPath: string;
  aggregated: UsageAggregated | null;
};

/** 查询聚合视图；文件不存在 = 未安装（installed=false）。 */
/** 触发一次增量刷新并返回当前中间态；日志未安装时返回 null。单飞，并发共享。 */
export async function getUsageStatsIntermediate(): Promise<UsageStatsIntermediate | null> {
  const state = (globalThis.__piUsageStats ??= { cached: null, refreshPromise: null });
  if (!state.refreshPromise) {
    state.refreshPromise = refreshUsageStats().finally(() => {
      if (globalThis.__piUsageStats) globalThis.__piUsageStats.refreshPromise = null;
    });
  }
  await state.refreshPromise;
  return globalThis.__piUsageStats?.cached?.intermediate ?? null;
}

/** 查询聚合视图；文件不存在 = 未安装（installed=false）。 */
export async function getUsageStatsSnapshot(): Promise<UsageStatsSnapshot> {
  const intermediate = await getUsageStatsIntermediate();
  return {
    installed: intermediate !== null,
    logPath: usageLogPath(),
    aggregated: intermediate ? buildAggregatedView(intermediate) : null,
  };
}
