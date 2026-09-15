/**
 * 用量统计展示层纯函数（移植自 PiDeck 的 format.ts / providerColors.ts /
 * usageDailyChartModel.ts）。与 React 和服务端 SDK 解耦，方便单测与客户端引用。
 */

// ── 格式化 ────────────────────────────────────────────────────────────────

/** 数字格式化：K/M/B 后缀（统计场景短格式）。 */
export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** 成本格式化：大额取整，小额按实际数字显示（6 位有效数字内，去掉尾零与浮点噪点）。 */
export function formatCost(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${Number(n.toPrecision(6)).toString()}`;
}

/** 百分比格式化：四位小数。 */
export function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(4)}%`;
}

/**
 * 缓存命中率：cacheRead 占全部 prompt token（input + cacheRead + cacheWrite）
 * 的比例；没有任何 prompt token 时返回 null（显示为占位符而非 0%）。
 */
export function cacheHitRateOf(totals: { input: number; cacheRead: number; cacheWrite: number }): number | null {
  const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
  if (prompt <= 0) return null;
  return totals.cacheRead / prompt;
}

/** 本地时区日键 "YYYY-MM-DD"。 */
export function dayKeyOf(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 日键（YYYY-MM-DD）+ 天数偏移 → 本地日期字符串（热力图 tooltip 用）。 */
export function formatDayKeyPlusOffset(dayKey: string, offsetDays: number): string {
  const d = new Date(`${dayKey}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dayKey;
  d.setDate(d.getDate() + offsetDays);
  return dayKeyOf(d);
}

// ── Provider 取色（名称哈希保证跨图表稳定；不足时循环取色） ────────────────

const PROVIDER_COLORS = [
  "rgba(74,158,255,0.85)",
  "rgba(74,222,128,0.85)",
  "rgba(251,146,60,0.85)",
  "rgba(232,121,249,0.85)",
  "rgba(250,204,21,0.85)",
  "rgba(52,211,153,0.85)",
  "rgba(167,139,250,0.85)",
  "rgba(248,113,113,0.85)",
];

export function colorForProvider(provider: string): string {
  let hash = 0;
  for (let i = 0; i < provider.length; i++) {
    hash = (hash * 31 + provider.charCodeAt(i)) >>> 0;
  }
  return PROVIDER_COLORS[hash % PROVIDER_COLORS.length];
}

// ── 每日柱状图数据变换 ────────────────────────────────────────────────────

export type RangeMode = "day" | "week" | "month";

export type UsageChartBucket = {
  label: string;
  tokens: number;
  byProvider: Array<{ provider: string; tokens: number }>;
};

const DAY_MS = 24 * 3600 * 1000;

/** 构造日（近 30 天）/ 周（近 12 周起始日）/ 月（近 12 月）桶；tokens===0 的桶丢弃。 */
export function buildBuckets(
  rows: Array<{ day: string; totals: { tokens: number }; byProvider: Array<{ provider: string; tokens: number }> }>,
  mode: RangeMode,
  now: Date,
): UsageChartBucket[] {
  if (rows.length === 0) return [];
  const last = new Date(`${rows[rows.length - 1].day}T00:00:00`);
  if (Number.isNaN(last.getTime())) return [];
  const end = Math.min(now.getTime(), last.getTime() + DAY_MS);

  if (mode === "day") {
    const start = end - 30 * DAY_MS;
    return rows
      .filter((r) => {
        const ts = new Date(`${r.day}T00:00:00`).getTime();
        // 近 30 天窗口内，无用量的天不画柱（含 tokens 为 0 的脏行）
        return ts >= start && r.totals.tokens > 0;
      })
      .map((r) => ({
        label: r.day.slice(5),
        tokens: r.totals.tokens,
        byProvider: r.byProvider
          .filter((p) => p.tokens > 0)
          .map((p) => ({ provider: p.provider, tokens: p.tokens })),
      }));
  }

  // 周 / 月：按本地周一起始 / 自然月聚合成桶（升序），最多近 12 个
  const buckets = new Map<string, UsageChartBucket>();
  for (const r of rows) {
    const d = new Date(`${r.day}T00:00:00`);
    let key: string;
    if (mode === "week") {
      const monday = new Date(d);
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      key = dayKeyOf(monday);
    } else {
      key = r.day.slice(0, 7);
    }
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { label: mode === "week" ? key.slice(5) : key, tokens: 0, byProvider: [] };
      buckets.set(key, bucket);
    }
    bucket.tokens += r.totals.tokens;
    for (const p of r.byProvider) {
      if (p.tokens <= 0) continue;
      const existing = bucket.byProvider.find((b) => b.provider === p.provider);
      if (existing) existing.tokens += p.tokens;
      else bucket.byProvider.push({ provider: p.provider, tokens: p.tokens });
    }
  }
  const sorted = [...buckets.values()].filter((bucket) => bucket.tokens > 0);
  return sorted.slice(Math.max(0, sorted.length - 12));
}
