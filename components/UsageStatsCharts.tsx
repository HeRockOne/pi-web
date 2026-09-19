"use client";

/**
 * 用量统计的四张补充图表（费用趋势 / 模型排行 / 项目排行 / 余额走势）。
 * 数据全部来自已有聚合（lib/usage-stats.ts）与余额时间线接口
 * （POST /api/usage-balances/timeline，逐日 23:59:59 采样）。
 */

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useI18n } from "@/hooks/useI18n";
import {
  buildBuckets,
  colorForProvider,
  formatCost,
  formatTokens,
  type RangeMode,
} from "@/lib/usage-stats-format";
import type { UsageAggregated, UsageDayRow } from "@/lib/usage-stats";
import type { BalanceSnapshotRow } from "@/lib/usage-balances";

type TooltipEntry = {
  dataKey?: string | number;
  name?: string | number;
  value?: number | string;
  color?: string;
  payload?: unknown;
};

type ChartTooltipProps = {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: unknown;
};

// ── 费用趋势（面积图，日/周/月切换，与每日用量柱状图同款分桶） ──────────────

function UsageCostTooltip({ active, payload, label }: ChartTooltipProps) {
  const { t } = useI18n();
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="usage-stats-chart-tooltip">
      <div className="usage-stats-chart-tooltip-label">{String(label ?? "")}</div>
      {payload.map((item) => (
        <div key={String(item.dataKey)} className="usage-stats-chart-tooltip-row">
          <span className="usage-stats-chart-tooltip-dot" style={{ background: "var(--accent)" }} />
          <span className="usage-stats-chart-tooltip-name">{t("usageStats.rank.cost")}</span>
          <span className="usage-stats-chart-tooltip-value">{formatCost(Number(item.value ?? 0))}</span>
        </div>
      ))}
    </div>
  );
}

export function UsageCostTrendChart({ data }: { data: UsageAggregated }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<RangeMode>("month");
  const buckets = useMemo(() => buildBuckets(data.daily, mode, new Date()), [data, mode]);
  const rangeLabels: Record<RangeMode, string> = {
    day: t("usageStats.daily.rangeDay"),
    week: t("usageStats.daily.rangeWeek"),
    month: t("usageStats.daily.rangeMonth"),
  };
  return (
    <>
      <div className="usage-stats-range">
        {(Object.keys(rangeLabels) as RangeMode[]).map((m) => (
          <button
            key={m}
            type="button"
            className={`usage-stats-range-button${mode === m ? " is-active" : ""}`}
            onClick={() => setMode(m)}
          >
            {rangeLabels[m]}
          </button>
        ))}
      </div>
      {buckets.length === 0 ? (
        <div className="usage-stats-hint">{t("usageStats.table.empty")}</div>
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <AreaChart data={buckets} margin={{ top: 12, right: 16, left: 12, bottom: 4 }}>
            <defs>
              <linearGradient id="usage-cost-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.26} />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--border-soft, var(--border))" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} tick={{ fontSize: 11, fill: "var(--text-dim)" }} interval="preserveStartEnd" />
            <YAxis tickLine={false} axisLine={false} width={58} tick={{ fontSize: 11, fill: "var(--text-dim)" }} tickFormatter={(value: number) => formatCost(value)} />
            <Tooltip cursor={{ stroke: "var(--border)" }} content={<UsageCostTooltip />} />
            <Area type="monotone" dataKey="cost" name={t("usageStats.rank.cost")} stroke="var(--accent)" strokeWidth={2} fill="url(#usage-cost-fill)" />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </>
  );
}

// ── 排行条形图（模型 / 项目共用，横向条、按费用降序、最多前 10） ────────────

type UsageRankRow = {
  label: string;
  full: string;
  cost: number;
  tokens: number;
  turns: number;
  color: string;
};

function shortModelName(model: string): string {
  return model.length > 24 ? "\u2026" + model.slice(-23) : model;
}

function shortProjectName(project: string): string {
  if (!project) return "(\u2014)";
  const parts = project.split(/[\\/]+/).filter(Boolean);
  return parts.pop() ?? project;
}

function UsageRankTooltip({ active, payload }: ChartTooltipProps) {
  const { t } = useI18n();
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload as UsageRankRow;
  return (
    <div className="usage-stats-chart-tooltip">
      <div className="usage-stats-chart-tooltip-label">{row.full || row.label}</div>
      <div className="usage-stats-chart-tooltip-row">
        <span className="usage-stats-chart-tooltip-dot" style={{ background: row.color }} />
        <span className="usage-stats-chart-tooltip-name">{t("usageStats.rank.cost")}</span>
        <span className="usage-stats-chart-tooltip-value">{formatCost(row.cost)}</span>
      </div>
      <div className="usage-stats-chart-tooltip-row">
        <span className="usage-stats-chart-tooltip-name">{t("usageStats.models.col.tokens")}</span>
        <span className="usage-stats-chart-tooltip-value">{formatTokens(row.tokens)}</span>
      </div>
      <div className="usage-stats-chart-tooltip-row">
        <span className="usage-stats-chart-tooltip-name">{t("usageStats.models.col.turns")}</span>
        <span className="usage-stats-chart-tooltip-value">{String(row.turns)}</span>
      </div>
    </div>
  );
}

function UsageRankChart({ rows, emptyHint }: { rows: UsageRankRow[]; emptyHint: string }) {
  const sorted = useMemo(() => [...rows].sort((a, b) => b.cost - a.cost).slice(0, 10), [rows]);
  if (sorted.length === 0) return <div className="usage-stats-hint">{emptyHint}</div>;
  return (
    <ResponsiveContainer width="100%" height={Math.max(120, sorted.length * 34)}>
      <BarChart data={sorted} layout="vertical" margin={{ top: 4, right: 28, left: 8, bottom: 4 }}>
        <CartesianGrid horizontal={false} stroke="var(--border-soft, var(--border))" />
        <XAxis type="number" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--text-dim)" }} tickFormatter={(value: number) => formatCost(value)} />
        <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={150} tick={{ fontSize: 11, fill: "var(--text-dim)" }} />
        <Tooltip cursor={{ fill: "var(--bg-subtle)" }} content={<UsageRankTooltip />} />
        <Bar dataKey="cost" radius={[0, 4, 4, 0]} maxBarSize={14}>
          {sorted.map((row) => (
            <Cell key={row.label} fill={row.color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function UsageModelRankChart({ data }: { data: UsageAggregated }) {
  const { t } = useI18n();
  return (
    <UsageRankChart
      emptyHint={t("usageStats.table.empty")}
      rows={data.byModel.map((m) => ({
        label: shortModelName(m.model),
        full: m.model,
        cost: m.cost,
        tokens: m.tokens,
        turns: m.turns,
        color: colorForProvider(m.provider),
      }))}
    />
  );
}

export function UsageProjectRankChart({ data }: { data: UsageAggregated }) {
  const { t } = useI18n();
  return (
    <UsageRankChart
      emptyHint={t("usageStats.table.empty")}
      rows={data.byProject.map((p) => ({
        label: shortProjectName(p.project),
        full: p.project,
        cost: p.cost,
        tokens: p.tokens,
        turns: p.turns,
        color: "var(--accent)",
      }))}
    />
  );
}

// ── 余额走势（多 provider 折线：从当前余额按每日费用回推整条曲线） ────────────

function UsageBalanceTrendTooltip({ active, payload, label }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="usage-stats-chart-tooltip">
      <div className="usage-stats-chart-tooltip-label">{String(label ?? "")}</div>
      {payload.map((item) => (
        <div key={String(item.dataKey)} className="usage-stats-chart-tooltip-row">
          <span className="usage-stats-chart-tooltip-dot" style={{ background: item.color }} />
          <span className="usage-stats-chart-tooltip-name">{String(item.name)}</span>
          <span className="usage-stats-chart-tooltip-value">{formatCost(Number(item.value ?? 0))}</span>
        </div>
      ))}
    </div>
  );
}

export function UsageBalanceTrendChart({ daily, balances }: { daily: UsageDayRow[]; balances: BalanceSnapshotRow[] }) {
  const { t } = useI18n();
  // Balance configs are baseline-relative ("remaining = balance - spent since
  // the last reset"), so replaying past timestamps yields flat lines — the
  // config knows nothing about pre-reset spending. Reconstruct instead: walk
  // the window backwards from the current remaining, undoing each day's
  // per-provider cost, so the slope reflects real burn rate.
  const providers = useMemo(() => {
    const rows: Array<{ name: string; cap: number | null; series: number[] }> = [];
    for (const snap of balances) {
      if (snap.remaining === null) continue;
      const costPerDay = daily.map((r) => r.byProvider.find((bp) => bp.provider === snap.provider)?.cost ?? 0);
      const series = new Array<number>(daily.length);
      let remaining = snap.remaining;
      for (let i = daily.length - 1; i >= 0; i--) {
        series[i] = remaining;
        remaining += costPerDay[i];
      }
      rows.push({ name: snap.provider, cap: snap.balance, series });
    }
    return rows;
  }, [daily, balances]);

  if (providers.length === 0) return <div className="usage-stats-hint">{t("usageStats.balanceTrend.empty")}</div>;

  const rows = daily.map((r, i) => {
    const row: Record<string, string | number | null> = { label: r.day.slice(5) };
    for (const p of providers) row[p.name] = p.series[i];
    return row;
  });

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={rows} margin={{ top: 12, right: 16, left: 12, bottom: 4 }}>
        <CartesianGrid vertical={false} stroke="var(--border-soft, var(--border))" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} tick={{ fontSize: 11, fill: "var(--text-dim)" }} interval="preserveStartEnd" />
        <YAxis tickLine={false} axisLine={false} width={58} domain={["auto", "auto"]} tick={{ fontSize: 11, fill: "var(--text-dim)" }} tickFormatter={(value: number) => formatCost(value)} />
        <Tooltip cursor={{ stroke: "var(--border)" }} content={<UsageBalanceTrendTooltip />} />
        {providers.map((p) => (
          <Line key={p.name} dataKey={p.name} name={p.name} type="monotone" stroke={colorForProvider(p.name)} strokeWidth={2} dot={false} connectNulls={false} />
        ))}
        {providers.filter((p) => p.cap !== null).map((p) => (
          <ReferenceLine
            key={`${p.name}-cap`}
            y={p.cap as number}
            strokeDasharray="4 3"
            stroke="color-mix(in srgb, var(--text-dim) 55%, transparent)"
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
