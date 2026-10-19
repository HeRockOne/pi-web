"use client";

/**
 * 用量统计（Usage Stats）设置面板 section。
 *
 * 数据源为 pi-tracker 扩展的 analytics/usage.jsonl（服务端增量解析聚合，
 * 见 lib/usage-stats.ts）；面板只保留「余额 → 成本周期 → 成本构成 → 趋势 →
 * 模型明细」这一条主线，其余图表默认收起或已删除，避免图表淹没结论。
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton, ConfigPanelShell } from "./SettingsUi";
import { UsageCostTrendChart } from "./UsageStatsCharts";
import type { DayTotals, UsageAggregated, UsageDayRow, UsageHourRow, UsageModelRow } from "@/lib/usage-stats";
import type { BalanceSnapshotRow } from "@/lib/usage-balances";
import {
  cacheHitRateOf,
  colorForProvider,
  dayKeyOf,
  formatCost,
  formatCostCompact,
  formatPercent,
  formatTokens,
  formatTokensExact,
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

/**
 * KPI 行金额：¥/$ 只到分（低于 1 分显示 <$0.01，0 显示 $0）。
 * 明细表仍用 formatCost 保留有效数字，避免小额成本被抹平。
 */
function costKpi(cost: number): string {
  return formatCostCompact(cost) ?? formatCost(0);
}

function CostValue({ cost, costKnown }: { cost: number; costKnown: boolean }) {
  const { t } = useI18n();
  return (
    <span title={costKnown ? undefined : t("usageStats.cards.costUnknown")}>
      {costKpi(cost)}
      {!costKnown && <span className="usage-stats-unknown"> *</span>}
    </span>
  );
}

function SummaryCard({ label, value, sub, hero = false }: { label: string; value: ReactNode; sub?: ReactNode; hero?: boolean }) {
  return (
    <div className={`usage-stats-card${hero ? " is-hero" : ""}`}>
      <div className="usage-stats-card-label">{label}</div>
      <div className="usage-stats-card-value">{value}</div>
      {sub && <div className="usage-stats-card-sub">{sub}</div>}
    </div>
  );
}

/**
 * Token 构成：一行堆叠条 + 图例（输入 / 输出 / 缓存读 / 缓存写）。
 * 计费 API 的成本几乎全由输入与缓存命中决定，所以这里给出占比而非再画一张图。
 */
/** 「今天 / 本周 / 本月 / 今年」四段成本：一眼看出钱花在什么区间。 */
function CostPeriods({ data }: { data: UsageAggregated }) {
  const { t, locale } = useI18n();
  const cells = [
    { key: "today", label: t("usageStats.periods.today"), bucket: data.today },
    { key: "week", label: t("usageStats.periods.week"), bucket: data.thisWeek },
    { key: "month", label: t("usageStats.periods.month"), bucket: data.thisMonth },
    { key: "year", label: t("usageStats.periods.year"), bucket: data.thisYear },
    { key: "all", label: t("usageStats.periods.all"), bucket: data.totals },
  ];
  return (
    <div className="usage-stats-periods">
      {cells.map((cell) => (
        <div key={cell.key} className="usage-stats-period">
          <span className="usage-stats-period-label">{cell.label}</span>
          <span className="usage-stats-period-cost">{costKpi(cell.bucket.cost)}</span>
          <span className="usage-stats-period-tokens">
            {formatTokens(cell.bucket.tokens, locale)} · {cell.bucket.turns} {t("usageStats.periods.turns")}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 成本构成：按输入 / 输出 / 缓存读 / 缓存写拆分金额，并给出主导项结论。 */
function CostComposition({ totals }: { totals: DayTotals }) {
  const { t } = useI18n();
  const kinds = [
    { key: "input", label: t("usageStats.composition.input"), value: totals.costByKind.input, color: "var(--chart-1)" },
    { key: "output", label: t("usageStats.composition.output"), value: totals.costByKind.output, color: "var(--chart-2)" },
    { key: "cacheRead", label: t("usageStats.composition.cacheRead"), value: totals.costByKind.cacheRead, color: "var(--chart-3)" },
    { key: "cacheWrite", label: t("usageStats.composition.cacheWrite"), value: totals.costByKind.cacheWrite, color: "var(--chart-4)" },
  ];
  const sum = kinds.reduce((acc, k) => acc + k.value, 0);
  if (!(sum > 0)) return <div className="usage-stats-hint">{t("usageStats.table.empty")}</div>;
  const ranked = [...kinds].sort((a, b) => b.value - a.value);
  const top = ranked[0];
  return (
    <div className="usage-stats-composition">
      <div className="usage-stats-composition-bar" role="img" aria-label={t("usageStats.costComposition.title")}>
        {kinds.filter((k) => k.value > 0).map((k) => (
          <span
            key={k.key}
            className="usage-stats-composition-seg"
            style={{ width: `${(k.value / sum) * 100}%`, background: k.color }}
            title={`${k.label} ${formatCost(k.value)}`}
          />
        ))}
      </div>
      <p className="usage-stats-insight">
        {t("usageStats.costComposition.insight", {
          kind: top.label,
          pct: formatPercent(top.value / sum, 0),
          cost: costKpi(top.value),
        })}
      </p>
      <ul className="usage-stats-composition-legend">
        {kinds.map((k) => (
          <li key={k.key}>
            <span className="usage-stats-legend-dot" style={{ background: k.color }} />
            <span className="usage-stats-composition-name">{k.label}</span>
            <span className="usage-stats-composition-value">{costKpi(k.value)}</span>
            <span className="usage-stats-composition-pct">{formatPercent(sum > 0 ? k.value / sum : 0, 1)}</span>
          </li>
        ))}
      </ul>
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

/** 按小时分布：24 格柱状（红=命中峰价，绿=命中谷价，灰=普通），下方列出峰谷命中明细。 */
/** 按天用量明细：日期选择 + 当日卡片 + provider 堆叠条 + 当日模型/项目表。 */
function UsageDayDetail({ rows, costKnown }: { rows: UsageDayRow[]; costKnown: boolean }) {
  const { t, locale } = useI18n();
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
            <SummaryCard label={t("usageStats.dayDetail.cards.tokens")} value={formatTokens(row.totals.tokens, locale)} />
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
                read: formatTokens(row.totals.cacheRead, locale),
                write: formatTokens(row.totals.cacheWrite, locale),
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
                    title={`${p.provider} · ${formatTokens(p.tokens, locale)} · ${formatCost(p.cost)} · ${(() => { const hit = cacheHitRateOf(p); return hit === null ? "—" : `hit ${formatPercent(hit)}`; })()}`}
                  />
                ))}
              </div>
              <ul className="usage-stats-provider-legend">
                {visibleProviders.map((p) => (
                  <li key={p.provider}>
                    <span className="usage-stats-legend-dot" style={{ background: colorForProvider(p.provider) }} />
                    <span className="usage-stats-legend-name">{p.provider}</span>
                    <span>{formatTokens(p.tokens, locale)}</span>
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
                  return [m.model, formatTokens(m.tokens, locale), hit === null ? "—" : formatPercent(hit), formatCost(m.cost), String(m.turns)];
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
                rows={row.byProject.map((p) => [p.project, formatTokens(p.tokens, locale), formatCost(p.cost), String(p.turns)])}
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

/** 余额编辑区：每供应商一行（余额 / 已扣 / 剩余 / 操作），充值走叠加（POST add），重置余额直接覆盖（POST balance），重置已扣走基线重置。 */
function BalanceSection({ rows, onChanged }: { rows: BalanceSnapshotRow[]; onChanged: () => void }) {
  const { t } = useI18n();
  const [rechargeDrafts, setRechargeDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [showZero, setShowZero] = useState(false);

  /** 叠加充值：新余额 = 现有余额 + 金额，已扣/基线不动。成功后收起行内编辑。 */
  const recharge = async (row: BalanceSnapshotRow) => {
    const raw = rechargeDrafts[row.provider] ?? "";
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value) || value < 0) {
      setError(t("usageStats.balance.invalid"));
      return;
    }
    setBusy(row.provider);
    setError("");
    try {
      const response = await fetch("/api/usage-stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: row.provider, add: value }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok || result.error) throw new Error(result.error ?? `HTTP ${response.status}`);
      setSaved(row.provider);
      window.setTimeout(() => setSaved(null), 1600);
      setRechargeDrafts((prev) => ({ ...prev, [row.provider]: "" }));
      setEditing(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /** 重置已扣：把扣减基线设为当前累计成本（已扣从 0 重新累计），余额不动。 */
  const resetSpent = async (row: BalanceSnapshotRow) => {
    if (!window.confirm(t("usageStats.balance.resetSpentConfirm", { provider: row.provider }))) return;
    setBusy(row.provider);
    setError("");
    try {
      const response = await fetch("/api/usage-stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: row.provider, balance: row.balance, resetSpent: true }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok || result.error) throw new Error(result.error ?? `HTTP ${response.status}`);
      setSaved(row.provider);
      window.setTimeout(() => setSaved(null), 1600);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /** 重置余额：把余额清零（balance = 0），已扣/基线不动。 */
  const resetBalance = async (row: BalanceSnapshotRow) => {
    if (!window.confirm(t("usageStats.balance.resetBalanceConfirm", { provider: row.provider }))) return;
    setBusy(row.provider);
    setError("");
    try {
      const response = await fetch("/api/usage-stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: row.provider, balance: 0 }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok || result.error) throw new Error(result.error ?? `HTTP ${response.status}`);
      setSaved(row.provider);
      window.setTimeout(() => setSaved(null), 1600);
      setRechargeDrafts((prev) => ({ ...prev, [row.provider]: "" }));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const visibleRows = rows.filter((row) => {
    // 零余额且从未扣费的账户默认折叠，避免一堆 $0 占满整屏。
    const dormant = row.balance === null && row.spent === 0;
    const zero = row.balance === 0 && row.spent === 0;
    return !(dormant || zero) || showZero;
  });
  const hiddenCount = rows.length - visibleRows.length;

  return (
    <div>
      <div className="usage-stats-table-wrap">
        <table className="usage-stats-table usage-stats-balance-table">
          <thead>
            <tr>
              <th>{t("usageStats.balance.col.provider")}</th>
              <th>{t("usageStats.balance.col.remaining")}</th>
              <th>{t("usageStats.balance.col.spent")}</th>
              <th>{t("usageStats.balance.col.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => {
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
                    {remaining === null ? (
                      <span className="usage-stats-balance-total">—</span>
                    ) : (
                      <>
                        <span className={negative ? "usage-stats-balance-negative usage-stats-balance-total" : "usage-stats-balance-total"}>
                          {formatCost(remaining)}
                        </span>
                        <BalanceBar balance={row.balance ?? 0} remaining={remaining} />
                      </>
                    )}
                  </td>
                  <td>{formatCost(row.spent)}</td>
                  <td>
                    {editing === row.provider ? (
                      <div className="usage-stats-balance-actions is-open">
                        <input
                          autoFocus
                          type="number"
                          min={0}
                          step="0.01"
                          className="usage-stats-balance-input"
                          value={rechargeDrafts[row.provider] ?? ""}
                          placeholder={t("usageStats.balance.rechargePlaceholder")}
                          aria-label={`${row.provider} ${t("usageStats.balance.recharge")}`}
                          onChange={(event) => setRechargeDrafts((prev) => ({ ...prev, [row.provider]: event.target.value }))}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void recharge(row);
                            else if (event.key === "Escape") setEditing(null);
                          }}
                        />
                        <button
                          type="button"
                          className="usage-stats-balance-btn is-primary"
                          onClick={() => void recharge(row)}
                          disabled={busy === row.provider}
                        >
                          {saved === row.provider ? t("usageStats.balance.saved") : t("usageStats.balance.recharge")}
                        </button>
                        <button type="button" className="usage-stats-balance-btn" onClick={() => setEditing(null)}>
                          {t("i18n.cancel")}
                        </button>
                      </div>
                    ) : (
                      <div className="usage-stats-balance-actions">
                        {saved === row.provider && <span className="usage-stats-balance-saved">{t("usageStats.balance.saved")}</span>}
                        <button type="button" className="usage-stats-balance-btn is-primary" onClick={() => setEditing(row.provider)}>
                          {t("usageStats.balance.recharge")}
                        </button>
                        {row.balance !== null && row.spent > 0 && (
                          <button type="button" className="usage-stats-balance-btn" onClick={() => void resetSpent(row)} disabled={busy === row.provider}>
                            {t("usageStats.balance.reset")}
                          </button>
                        )}
                        {row.balance !== null && (
                          <button type="button" className="usage-stats-balance-btn" onClick={() => void resetBalance(row)} disabled={busy === row.provider}>
                            {t("usageStats.balance.resetBalance")}
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hiddenCount > 0 && (
        <button type="button" className="usage-stats-show-zero" onClick={() => setShowZero(true)}>
          {t("usageStats.balance.showZero", { count: String(hiddenCount) })}
        </button>
      )}
      {showZero && hiddenCount === 0 && rows.length > 0 && (
        <button type="button" className="usage-stats-show-zero" onClick={() => setShowZero(false)}>
          {t("usageStats.balance.hideZero")}
        </button>
      )}
      {rows.length === 0 && <div className="usage-stats-hint">{t("usageStats.balance.empty")}</div>}
      {error && <div className="usage-stats-hint">{t("usageStats.errorHint", { message: error })}</div>}
    </div>
  );
}


/** 模型明细：一张平铺表，按花费降序；供应商用圆点配色区分（与余额表一致）。 */
function ModelCostTable({ rows }: { rows: UsageModelRow[] }) {
  const { t, locale } = useI18n();
  const sorted = [...rows].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  const totalCost = sorted.reduce((acc, row) => acc + row.cost, 0);
  if (sorted.length === 0) return <div className="usage-stats-hint">{t("usageStats.table.empty")}</div>;
  return (
    <div className="usage-stats-table-wrap">
      <table className="usage-stats-table usage-stats-model-table">
        <thead>
          <tr>
            <th>{t("usageStats.models.col.model")}</th>
            <th>{t("usageStats.models.col.cost")}</th>
            <th>{t("usageStats.models.col.share")}</th>
            <th>{t("usageStats.models.col.tokens")}</th>
            <th>{t("usageStats.models.col.turns")}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const share = totalCost > 0 ? row.cost / totalCost : 0;
            // row.model 自带 provider/ 前缀，展示时去掉避免 opencode-go/opencode-go/xxx
            const modelId = row.model.startsWith(row.provider + "/") ? row.model.slice(row.provider.length + 1) : row.model;
            return (
              <tr key={row.provider + "/" + row.model}>
                <td className="usage-stats-model-name">
                  <span className="usage-stats-legend-dot" style={{ background: colorForProvider(row.provider) }} />
                  <span className="usage-stats-model-provider">{row.provider}</span>
                  <span className="usage-stats-model-sep">/</span>
                  <span className="usage-stats-model-id">{modelId}</span>
                </td>
                <td className="usage-stats-num">{costKpi(row.cost)}</td>
                <td className="usage-stats-num usage-stats-share">{formatPercent(share, 1)}</td>
                <td className="usage-stats-num">{formatTokens(row.tokens, locale)}</td>
                <td className="usage-stats-num">{formatTokensExact(row.turns, locale)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 峰谷定价：最近 7 天的逐小时柱子（红=峰价、绿=谷价）+ 命中明细表。 */
function UsagePeakSection({ data }: { data: UsageAggregated }) {
  const { t, locale } = useI18n();
  // 按「当天」而非最近 7 天聚合：这张图就是今天各小时的峰/谷/普通分布，
  // 用历史平均会冲淡今天真实在跑的模型。
  const todayKey = dayKeyOf(new Date());
  const todayRow = data.daily.find((d) => d.day === todayKey);
  const byHour: UsageHourRow[] = todayRow ? todayRow.byHour : [];
  const peakCost = byHour.flatMap((h) => h.peakHits).filter((hit) => hit.state === "peak").reduce((acc, hit) => acc + hit.cost, 0);
  const offCost = byHour.flatMap((h) => h.peakHits).filter((hit) => hit.state === "off").reduce((acc, hit) => acc + hit.cost, 0);
  const plainCost = byHour.flatMap((h) => h.peakHits).filter((hit) => hit.state === "plain").reduce((acc, hit) => acc + hit.cost, 0);
  const hasPricing = peakCost + offCost > 0;
  const maxTokens = Math.max(1, ...byHour.map((h) => h.totals.tokens));
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, row: new Map(byHour.map((h) => [h.hour, h])).get(hour) }));
  return (
    <div className="usage-stats-hour-section">
      <p className="usage-stats-hour-summary">
        <span>{t("usageStats.hour.peakCost")} <b>{costKpi(peakCost)}</b></span>
        <span>{t("usageStats.hour.offCost")} <b>{costKpi(offCost)}</b></span>
        <span>{t("usageStats.hour.plainCost")} <b>{costKpi(plainCost)}</b></span>
        <span className="usage-stats-hour-window">{t("usageStats.hour.todayWindow")}</span>
        {!hasPricing && <span className="usage-stats-hour-window">{t("usageStats.hour.noPricing")}</span>}
      </p>
      <div className="usage-stats-hour-bars">
        {hours.map(({ hour, row }) => {
          const tokens = row ? row.totals.tokens : 0;
          const hits = row ? row.peakHits : [];
          // 堆积柱：一根柱子按 token 量切成「普通 / 谷价 / 峰价」三段。
          // 同一小时常常既有谷价模型又有普通模型，整根染单色会掩盖构成。
          const byTone = { peak: 0, off: 0, plain: 0 };
          for (const hit of hits) byTone[hit.state] += hit.tokens;
          const label = `${String(hour).padStart(2, "0")}:00`;
          const detail = tokens > 0 && row ? `${formatTokens(tokens, locale)} · ${formatCost(row.totals.cost)}` : t("usageStats.hour.noUsage");
          const tip = [
            label,
            detail,
            ...hits.map((hit) =>
              `${hit.state === "peak" ? t("usageStats.hour.hitPeak") : hit.state === "off" ? t("usageStats.hour.hitOff") : t("usageStats.hour.legendPlain")} · ${hit.model} · ${formatCost(hit.cost)}`
            ),
          ].join("\n");
          return (
            <div key={hour} className="usage-stats-hour-cell" title={tip}>
              <div
                className="usage-stats-hour-col"
                style={{ height: tokens > 0 ? `${Math.max(3, Math.round((tokens / maxTokens) * 60))}px` : "2px" }}
              >
                {byTone.peak > 0 && <span className="usage-stats-hour-seg is-peak" style={{ flexGrow: byTone.peak }} />}
                {byTone.off > 0 && <span className="usage-stats-hour-seg is-off" style={{ flexGrow: byTone.off }} />}
                {byTone.plain > 0 && <span className="usage-stats-hour-seg is-plain" style={{ flexGrow: byTone.plain }} />}
              </div>
              <span className="usage-stats-hour-label">{hour}</span>
            </div>
          );
        })}
      </div>
      <div className="usage-stats-hour-legend">
        <span>
          <span className="usage-stats-legend-dot is-peak" />
          {t("usageStats.hour.legendPeak")}
        </span>
        <span>
          <span className="usage-stats-legend-dot is-off" />
          {t("usageStats.hour.legendOff")}
        </span>
        <span>
          <span className="usage-stats-legend-dot is-plain" />
          {t("usageStats.hour.legendPlain")}
        </span>
      </div>
    </div>
  );
}

export function UsageStats({ onClose, embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const { t, locale } = useI18n();
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
            {/* 计费 API 的第一关注点是钱：余额 → 成本周期 → 成本构成 → 趋势 → 明细。 */}
            <SectionTitle>{t("usageStats.balance.title")}</SectionTitle>
            <BalanceSection rows={balances} onChanged={load} />

            <div className="usage-stats-divider" />
            <SectionTitle>{t("usageStats.periods.title")}</SectionTitle>
            <CostPeriods data={data} />

            <div className="usage-stats-divider" />
            <SectionTitle>{t("usageStats.costComposition.title")}</SectionTitle>
            <CostComposition totals={data.totals} />

            <div className="usage-stats-divider" />
            <SectionTitle>{t("usageStats.peak.title")}</SectionTitle>
            <UsagePeakSection data={data} />

            <div className="usage-stats-divider" />
            <SectionTitle>{t("usageStats.costTrend.title")}</SectionTitle>
            <UsageCostTrendChart data={data} />

            <div className="usage-stats-divider" />
            <SectionTitle>{t("usageStats.models.title")}</SectionTitle>
            <ModelCostTable rows={data.byModel} />

            <div className="usage-stats-divider" />
            <details className="usage-stats-details">
              <summary className="usage-stats-details-summary">{t("usageStats.more.title")}</summary>

              <div className="usage-stats-facts">
                <span>{t("usageStats.cards.totalTokens")} {formatTokens(data.totals.tokens, locale)}</span>
                <span>{t("usageStats.cards.cacheHit")} <CacheRateValue totals={data.totals} /></span>
                <span>{t("usageStats.cards.turns")} {formatTokensExact(data.totals.turns, locale)}</span>
                <span>{t("usageStats.cards.activeDays")} {formatTokensExact(data.activeDays, locale)}</span>
              </div>

              <div className="usage-stats-divider" />
              <SectionTitle>{t("usageStats.projects.title")}</SectionTitle>
              <UsageTable
                headers={[
                  t("usageStats.projects.col.project"),
                  t("usageStats.models.col.tokens"),
                  t("usageStats.models.col.cost"),
                  t("usageStats.models.col.turns"),
                ]}
                rows={[...data.byProject]
                  .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens)
                  .map((p) => [
                    p.project,
                    formatTokens(p.tokens, locale),
                    formatCost(p.cost),
                    String(p.turns),
                  ])}
              />

              <div className="usage-stats-divider" />
              <UsageDayDetail rows={data.daily} costKnown={data.costKnown} />
            </details>
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
