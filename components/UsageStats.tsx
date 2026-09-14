"use client";

/**
 * 用量统计（Usage Stats）设置面板 section。
 *
 * 移植自 PiDeck 的 UsageStatsTab + usageStats 组件族：
 *  - 数据源为 pi-tracker 扩展的 analytics/usage.jsonl（服务端增量解析聚合，
 *    见 lib/usage-stats.ts）；未安装时给引导文案。
 *  - 热力图为自绘 SVG；每日柱状图用 recharts 堆叠柱（PiDeck 同款依赖）。
 *  - 明细表/卡片走 usage-stats-* 语义 class（app/settings.css）。
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton, ConfigPanelShell } from "./SettingsUi";
import type { UsageAggregated, UsageDayRow } from "@/lib/usage-stats";
import type { BalanceSnapshotRow } from "@/lib/usage-balances";
import {
  buildBuckets,
  cacheHitRateOf,
  colorForProvider,
  dayKeyOf,
  formatCost,
  formatDayKeyPlusOffset,
  formatPercent,
  formatTokens,
  type RangeMode,
} from "@/lib/usage-stats-format";

type Phase = "loading" | "missing" | "ready" | "error";

type UsageStatsResponse = {
  installed?: boolean;
  logPath?: string;
  aggregated?: UsageAggregated | null;
  balances?: BalanceSnapshotRow[];
  error?: string;
};

// ── 小组件 ────────────────────────────────────────────────────────────────

function CostValue({ cost, costKnown }: { cost: number; costKnown: boolean }) {
  const { t } = useI18n();
  return (
    <span title={costKnown ? undefined : t("usageStats.cards.costUnknown")}>
      {formatCost(cost)}
      {!costKnown && <span className="usage-stats-unknown"> *</span>}
    </span>
  );
}

function SummaryCard({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="usage-stats-card">
      <div className="usage-stats-card-label">{label}</div>
      <div className="usage-stats-card-value">{value}</div>
      {sub && <div className="usage-stats-card-sub">{sub}</div>}
    </div>
  );
}

/** 缓存命中率展示：无 prompt token 时显示占位符。 */
function CacheRateValue({ totals }: { totals: { input: number; cacheRead: number; cacheWrite: number } }) {
  const rate = cacheHitRateOf(totals);
  return <>{rate === null ? "—" : formatPercent(rate)}</>;
}

function UsageTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  const { t } = useI18n();
  if (rows.length === 0) {
    return <div className="usage-stats-hint">{t("usageStats.table.empty")}</div>;
  }
  return (
    <div className="usage-stats-table-wrap">
      <table className="usage-stats-table">
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 12).map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci} title={ci === 0 ? cell : undefined}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="usage-stats-section-title">{children}</h3>;
}

/** GitHub 风格活跃热力图（自绘 SVG，无图表库依赖）。 */
function UsageHeatmap({ data }: { data: UsageAggregated }) {
  const { t } = useI18n();
  const { heatmap, heatmapStart } = data;
  const todayKey = dayKeyOf(new Date());

  const CELL = 10;
  const GAP = 2;
  const WEEKS = 53;
  const DAYS = 7;
  const width = WEEKS * (CELL + GAP) - GAP;
  const height = DAYS * (CELL + GAP) - GAP;
  const LEVEL_CLASSES = [
    "usage-heatmap-l0",
    "usage-heatmap-l1",
    "usage-heatmap-l2",
    "usage-heatmap-l3",
    "usage-heatmap-l4",
  ];

  return (
    <div className="usage-stats-heatmap-scroll">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={t("usageStats.heatmap.title")}
      >
        {heatmap.map((cell, index) => {
          const week = Math.floor(index / DAYS);
          const day = index % DAYS;
          const date = formatDayKeyPlusOffset(heatmapStart, index);
          const isFuture = date > todayKey;
          const colorClass = isFuture ? LEVEL_CLASSES[0] : LEVEL_CLASSES[cell.level];
          return (
            <rect
              key={index}
              x={week * (CELL + GAP)}
              y={day * (CELL + GAP)}
              width={CELL}
              height={CELL}
              rx={2}
              className={colorClass}
            >
              <title>
                {t("usageStats.heatmap.tooltip", {
                  date,
                  tokens: formatTokens(cell.tokens),
                  turns: String(cell.turns),
                })}
              </title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}

type ChartTooltipProps = {
  active?: boolean;
  label?: string | number;
  payload?: Array<{
    value?: number | string;
    dataKey?: string | number;
    name?: string;
    color?: string;
  }>;
};

/** 堆叠列 tooltip：只列出实际有用量的 provider。 */
function UsageChartTooltip({ active, payload, label }: ChartTooltipProps) {
  const { t } = useI18n();
  if (!active || !payload || payload.length === 0) return null;
  const visible = payload.filter((item) => Number(item.value) > 0);
  if (visible.length === 0) return null;
  return (
    <div className="usage-stats-chart-tooltip">
      <div className="usage-stats-chart-tooltip-label">
        {t("usageStats.daily.tooltip", {
          label: String(label ?? ""),
          tokens: formatTokens(visible.reduce((acc, item) => acc + Number(item.value ?? 0), 0)),
        })}
      </div>
      {visible.map((item) => (
        <div key={String(item.dataKey)} className="usage-stats-chart-tooltip-row">
          <span className="usage-stats-chart-tooltip-dot" style={{ background: item.color }} />
          <span className="usage-stats-chart-tooltip-name">{item.name}</span>
          <span className="usage-stats-chart-tooltip-value">{formatTokens(Number(item.value))}</span>
        </div>
      ))}
    </div>
  );
}

function UsageDailyChart({ data }: { data: UsageAggregated }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<RangeMode>("day");

  const buckets = useMemo(
    () => buildBuckets(data.daily, mode, new Date()),
    [data.daily, mode],
  );
  const providers = useMemo(
    () => [...new Set(buckets.flatMap((bucket) => bucket.byProvider.map((item) => item.provider)))],
    [buckets],
  );
  const providerKeys = providers.map((provider, index) => ({ provider, key: `provider_${index}` }));
  const chartData = buckets.map((bucket) => ({
    label: bucket.label,
    ...Object.fromEntries(providerKeys.map(({ provider, key }) => [
      key,
      bucket.byProvider.find((item) => item.provider === provider)?.tokens ?? 0,
    ])),
  }));

  const rangeLabels: Record<RangeMode, string> = {
    day: t("usageStats.daily.rangeDay"),
    week: t("usageStats.daily.rangeWeek"),
    month: t("usageStats.daily.rangeMonth"),
  };

  return (
    <div className="usage-stats-chart">
      <div className="usage-stats-chart-toolbar">
        {(["day", "week", "month"] as RangeMode[]).map((m) => (
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
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={chartData} margin={{ top: 12, right: 16, left: 12, bottom: 4 }} barCategoryGap="28%">
            <CartesianGrid vertical={false} stroke="var(--border-soft, var(--border))" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} tick={{ fontSize: 11, fill: "var(--text-dim)" }} interval="preserveStartEnd" />
            <YAxis tickLine={false} axisLine={false} width={58} tick={{ fontSize: 11, fill: "var(--text-dim)" }} tickFormatter={(value: number) => formatTokens(Number(value))} />
            <Tooltip cursor={{ fill: "var(--bg-subtle)" }} content={<UsageChartTooltip />} />
            {providerKeys.map(({ provider, key }) => (
              <Bar key={provider} dataKey={key} name={provider} stackId="usage" fill={colorForProvider(provider)} radius={2} minPointSize={3} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

/** 按天用量明细：日期选择 + 当日卡片 + provider 堆叠条 + 当日模型/项目表。 */
function UsageDayDetail({ rows, costKnown }: { rows: UsageDayRow[]; costKnown: boolean }) {
  const { t } = useI18n();
  const today = dayKeyOf(new Date());
  const [selected, setSelected] = useState<string>(today);
  const isToday = selected === today;

  const row = rows.find((r) => r.day === selected);
  const visibleProviders = row?.byProvider.filter((p) => p.tokens > 0) ?? [];
  const total = visibleProviders.reduce((acc, p) => acc + p.tokens, 0);

  return (
    <div>
      <SectionTitle>
        {isToday ? t("usageStats.dayDetail.titleToday") : t("usageStats.dayDetail.titleDay", { date: selected })}
      </SectionTitle>
      <div className="usage-stats-day-toolbar">
        <input
          type="date"
          value={selected}
          max={today}
          onChange={(event) => {
            if (event.target.value) setSelected(event.target.value);
          }}
          className="usage-stats-date-input"
          aria-label={t("usageStats.dayDetail.titleToday")}
        />
        {!isToday && (
          <ConfigButton onClick={() => setSelected(today)}>{t("usageStats.dayDetail.backToday")}</ConfigButton>
        )}
      </div>

      {!row ? (
        <div className="usage-stats-hint">{t("usageStats.dayDetail.empty")}</div>
      ) : (
        <>
          <div className="usage-stats-cards">
            <SummaryCard label={t("usageStats.dayDetail.cards.tokens")} value={formatTokens(row.totals.tokens)} />
            <SummaryCard
              label={t("usageStats.dayDetail.cards.cost")}
              value={<CostValue cost={row.totals.cost} costKnown={costKnown} />}
            />
            <SummaryCard label={t("usageStats.dayDetail.cards.turns")} value={String(row.totals.turns)} />
            <SummaryCard label={t("usageStats.dayDetail.cards.sessions")} value={String(row.totals.sessions.length)} />
            <SummaryCard
              label={t("usageStats.dayDetail.cards.cacheHit")}
              value={<CacheRateValue totals={row.totals} />}
              sub={t("usageStats.dayDetail.cards.cacheSub", {
                read: formatTokens(row.totals.cacheRead),
                write: formatTokens(row.totals.cacheWrite),
              })}
            />
          </div>

          {total > 0 && (
            <>
              <div className="usage-stats-provider-bar" role="img" aria-label={t("usageStats.dayDetail.providers")}>
                {visibleProviders.map((p) => (
                  <div
                    key={p.provider}
                    style={{ width: `${(p.tokens / total) * 100}%`, backgroundColor: colorForProvider(p.provider) }}
                    title={`${p.provider} · ${formatTokens(p.tokens)} · ${formatCost(p.cost)} · ${(() => { const hit = cacheHitRateOf(p); return hit === null ? "—" : `hit ${formatPercent(hit)}`; })()}`}
                  />
                ))}
              </div>
              <ul className="usage-stats-provider-legend">
                {visibleProviders.map((p) => (
                  <li key={p.provider}>
                    <span className="usage-stats-legend-dot" style={{ background: colorForProvider(p.provider) }} />
                    <span className="usage-stats-legend-name">{p.provider}</span>
                    <span>{formatTokens(p.tokens)}</span>
                    <span>
                      {formatCost(p.cost)}
                      {!costKnown && <span className="usage-stats-unknown"> *</span>}
                    </span>
                    <span className="usage-stats-hit">{(() => { const hit = cacheHitRateOf(p); return hit === null ? "—" : `hit ${formatPercent(hit)}`; })()}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="usage-stats-day-tables">
            <div>
              <h4>{t("usageStats.dayDetail.modelsTitle")}</h4>
              <UsageTable
                headers={[
                  t("usageStats.models.col.model"),
                  t("usageStats.models.col.tokens"),
                  t("usageStats.models.col.cacheHit"),
                  t("usageStats.models.col.cost"),
                  t("usageStats.models.col.turns"),
                ]}
                rows={row.byModel.map((m) => {
                  const hit = cacheHitRateOf(m);
                  return [m.model, formatTokens(m.tokens), hit === null ? "—" : formatPercent(hit), formatCost(m.cost), String(m.turns)];
                })}
              />
            </div>
            <div>
              <h4>{t("usageStats.dayDetail.projectsTitle")}</h4>
              <UsageTable
                headers={[
                  t("usageStats.projects.col.project"),
                  t("usageStats.models.col.tokens"),
                  t("usageStats.models.col.cost"),
                  t("usageStats.models.col.turns"),
                ]}
                rows={row.byProject.map((p) => [p.project, formatTokens(p.tokens), formatCost(p.cost), String(p.turns)])}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── 供应商余额（Balance）──────────────────────────────────────────────────────

/** 剩余比例进度条：绿色→黄→红随剩余占比下降。 */
function BalanceBar({ balance, remaining }: { balance: number; remaining: number }) {
  if (balance <= 0) return null;
  const pct = Math.max(0, Math.min(100, (remaining / balance) * 100));
  const tone = pct > 50 ? "ok" : pct > 25 ? "warn" : "low";
  return (
    <div className="usage-stats-balance-bar" role="img" aria-label={`${pct.toFixed(0)}%`}>
      <div className={`usage-stats-balance-bar-fill is-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** 余额编辑区：每供应商一行（余额输入 / 已扣 / 剩余 / 保存+重置），保存走 POST /api/usage-stats。 */
function BalanceSection({ rows, onChanged }: { rows: BalanceSnapshotRow[]; onChanged: () => void }) {
  const { t } = useI18n();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState("");

  const save = async (row: BalanceSnapshotRow, resetSpent: boolean) => {
    const raw = drafts[row.provider] ?? (row.balance !== null ? String(row.balance) : "");
    const value = raw.trim() === "" ? null : Number(raw);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      setError(t("usageStats.balance.invalid"));
      return;
    }
    setBusy(row.provider);
    setError("");
    try {
      const response = await fetch("/api/usage-stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: row.provider, balance: value, resetSpent }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok || result.error) throw new Error(result.error ?? `HTTP ${response.status}`);
      setSaved(row.provider);
      window.setTimeout(() => setSaved(null), 1600);
      setDrafts((prev) => ({ ...prev, [row.provider]: value === null ? "" : String(value) }));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="usage-stats-table-wrap">
        <table className="usage-stats-table usage-stats-balance-table">
          <thead>
            <tr>
              <th>{t("usageStats.balance.col.provider")}</th>
              <th>{t("usageStats.balance.col.balance")}</th>
              <th>{t("usageStats.balance.col.spent")}</th>
              <th>{t("usageStats.balance.col.remaining")}</th>
              <th>{t("usageStats.balance.col.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const remaining = row.remaining;
              const negative = remaining !== null && remaining < 0;
              return (
                <tr key={row.provider}>
                  <td>
                    <span className="usage-stats-legend-dot" style={{ background: colorForProvider(row.provider) }} />
                    <span className="usage-stats-legend-name">{row.provider}</span>
                    {!row.costKnown && <span className="usage-stats-unknown"> *</span>}
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      className="usage-stats-balance-input"
                      value={drafts[row.provider] ?? (row.balance !== null ? String(row.balance) : "")}
                      placeholder={t("usageStats.balance.placeholder")}
                      aria-label={`${row.provider} ${t("usageStats.balance.col.balance")}`}
                      onChange={(event) => setDrafts((prev) => ({ ...prev, [row.provider]: event.target.value }))}
                    />
                  </td>
                  <td>{formatCost(row.spent)}</td>
                  <td>
                    {remaining === null ? (
                      "—"
                    ) : (
                      <>
                        <span className={negative ? "usage-stats-balance-negative" : undefined}>
                          {formatCost(remaining)}
                        </span>
                        <BalanceBar balance={row.balance ?? 0} remaining={remaining} />
                      </>
                    )}
                  </td>
                  <td>
                    <div className="usage-stats-balance-actions">
                      <ConfigButton onClick={() => void save(row, false)} disabled={busy === row.provider}>
                        {saved === row.provider ? t("usageStats.balance.saved") : t("usageStats.balance.save")}
                      </ConfigButton>
                      {row.balance !== null && (
                        <ConfigButton onClick={() => void save(row, true)} disabled={busy === row.provider}>
                          {t("usageStats.balance.reset")}
                        </ConfigButton>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <div className="usage-stats-hint">{t("usageStats.balance.empty")}</div>}
      {error && <div className="usage-stats-hint">{t("usageStats.errorHint", { message: error })}</div>}
    </div>
  );
}


export function UsageStats({ onClose, embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("loading");
  const [data, setData] = useState<UsageAggregated | null>(null);
  const [logPath, setLogPath] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [balances, setBalances] = useState<BalanceSnapshotRow[]>([]);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/usage-stats");
      const result = await response.json() as UsageStatsResponse;
      if (!response.ok || result.error) throw new Error(result.error ?? `HTTP ${response.status}`);
      setLogPath(result.logPath ?? null);
      setData(result.aggregated ?? null);
      setBalances(result.balances ?? []);
      setPhase(result.installed ? "ready" : "missing");
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ConfigPanelShell embedded={embedded} title={t("usageStats.title")} subtitle={logPath ?? undefined} closeLabel={t("i18n.close")} onClose={onClose}>
      <div className="usage-stats-body">
        <div className="usage-stats-toolbar">
          {(phase === "ready" || phase === "missing") && (
            <button type="button" className="usage-stats-range-button" onClick={() => void load()} disabled={refreshing}>
              {refreshing ? t("usageStats.refreshing") : t("usageStats.refresh")}
            </button>
          )}
        </div>

        {phase === "loading" && <div className="usage-stats-hint">{t("usageStats.loading")}</div>}

        {phase === "missing" && (
          <div className="usage-stats-not-installed">
            <p>{t("usageStats.notInstalled.desc")}</p>
            <div className="usage-stats-install-row">
              <code className="usage-stats-code">pi install npm:pi-tracker</code>
            </div>
            <p className="usage-stats-hint">{t("usageStats.notInstalled.restartHint")}</p>
            <p className="usage-stats-hint">{t("usageStats.notInstalled.backfill")}</p>
          </div>
        )}

        {phase === "error" && (
          <div className="usage-stats-hint">
            {t("usageStats.error")}
            <br />
            <small>{t("usageStats.errorHint", { message: error })}</small>
          </div>
        )}

        {phase === "ready" && data && data.recordCount > 0 && (
          <>
            <SectionTitle>{t("usageStats.balance.title")}</SectionTitle>
            <BalanceSection rows={balances} onChanged={load} />

            <div className="usage-stats-divider" />
            <UsageDayDetail rows={data.daily} costKnown={data.costKnown} />

            <div className="usage-stats-divider" />
            <SectionTitle>{t("usageStats.cards.title")}</SectionTitle>
            <div className="usage-stats-cards">
              <SummaryCard
                label={t("usageStats.cards.totalTokens")}
                value={formatTokens(data.totals.tokens)}
                sub={`${t("usageStats.cards.today")} ${formatTokens(data.today.tokens)}`}
              />
              <SummaryCard
                label={t("usageStats.cards.totalCost")}
                value={<CostValue cost={data.totals.cost} costKnown={data.costKnown} />}
                sub={`${t("usageStats.cards.month")} ${formatCost(data.thisMonth.cost)}`}
              />
              <SummaryCard
                label={t("usageStats.cards.turns")}
                value={String(data.totals.turns)}
                sub={`${t("usageStats.cards.week")} ${data.thisWeek.turns}`}
              />
              <SummaryCard
                label={t("usageStats.cards.activeDays")}
                value={String(data.activeDays)}
                sub={t("usageStats.window", {
                  since: dayKeyOf(new Date(data.window.since)),
                  days: String(Math.max(1, Math.round((data.window.to - data.window.since) / 86400000) + 1)),
                })}
              />
              <SummaryCard
                label={t("usageStats.cards.cacheHit")}
                value={<CacheRateValue totals={data.totals} />}
                sub={
                  <>
                    {t("usageStats.cards.today")} <CacheRateValue totals={data.today} />
                  </>
                }
              />
            </div>

            <div className="usage-stats-divider" />
            <SectionTitle>{t("usageStats.heatmap.title")}</SectionTitle>
            <UsageHeatmap data={data} />

            <div className="usage-stats-divider" />
            <SectionTitle>{t("usageStats.daily.title")}</SectionTitle>
            <UsageDailyChart data={data} />

            <div className="usage-stats-divider" />
            <SectionTitle>{t("usageStats.models.title")}</SectionTitle>
            <UsageTable
              headers={[
                t("usageStats.models.col.model"),
                t("usageStats.models.col.tokens"),
                t("usageStats.models.col.cost"),
                t("usageStats.models.col.turns"),
                t("usageStats.models.col.sessions"),
              ]}
              rows={data.byModel.map((m) => [
                m.model,
                formatTokens(m.tokens),
                formatCost(m.cost),
                String(m.turns),
                String(m.sessions),
              ])}
            />

            <div className="usage-stats-divider" />
            <SectionTitle>{t("usageStats.projects.title")}</SectionTitle>
            <UsageTable
              headers={[
                t("usageStats.projects.col.project"),
                t("usageStats.models.col.tokens"),
                t("usageStats.models.col.cost"),
                t("usageStats.models.col.turns"),
              ]}
              rows={data.byProject.map((p) => [
                p.project,
                formatTokens(p.tokens),
                formatCost(p.cost),
                String(p.turns),
              ])}
            />
          </>
        )}

        {phase === "ready" && (!data || data.recordCount === 0) && balances.length > 0 && (
          <>
            <SectionTitle>{t("usageStats.balance.title")}</SectionTitle>
            <BalanceSection rows={balances} onChanged={load} />
          </>
        )}

        {phase === "ready" && (!data || data.recordCount === 0) && (
          <div className="usage-stats-hint">
            {t("usageStats.empty.title")}
            <br />
            <small>{t("usageStats.empty.desc")}</small>
            <br />
            <small>{t("usageStats.empty.backfill")}</small>
          </div>
        )}
      </div>
    </ConfigPanelShell>
  );
}
