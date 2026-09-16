#!/usr/bin/env node
/**
 * analyze-cache-hit.js — 缓存命中率波动分析工具
 *
 * 用途：排查单条请求命中率暴跌的根源。当发现 cacheR 骤降 / input 暴增 / 命中率
 * 跌到 20-55% 时，运行本工具对齐 usage 日志与会话文件的 compress 调用时间戳，
 * 判断是否由 ACP 上下文压缩打破缓存前缀导致。
 *
 * 用法：
 *   node scripts/analyze-cache-hit.js [sessionFile] [--top N] [--threshold=3000]
 *
 *   sessionFile  会话 .jsonl 路径；缺省自动选 ~/.pi/agent/sessions 下最近修改的
 *   --top N      只显示最近 N 条请求（默认全部；配合 --threshold 聚焦异常）
 *   --threshold  input 超过该值标记为「input大」（默认 3000）
 *   --since      ISO 时间，只看该时刻之后（如 2026-09-15T17:00:00Z）
 *   --json       输出 JSON（机器可读）
 *
 * 输出：
 *   - 每个请求：时间 input output cacheR cacheW 命中率，标记 input大 / cacheR暴跌
 *   - 会话内 compress 工具调用的时间戳
 *   - 对齐：compress 后 N 秒内的首次请求标为 [compress后]
 *   - 总结：compress 相关请求的平均命中率 vs 整体，证明/排除压缩是主因
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// ---------- 参数 ----------
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const p = args.find((a) => a.startsWith(`${name}=`));
  return p ? p.slice(name.length + 1) : def;
};
const sessionArg = args.find((a) => !a.startsWith("-") && (a.endsWith(".jsonl") || a.includes(".pi/agent")));
const top = parseInt(arg("--top", "0"), 10) || 0;
const threshold = parseInt(arg("--threshold", "3000"), 10) || 3000;
const since = arg("--since", "");
const asJson = args.includes("--json");
const compressWindowSec = parseInt(arg("--window", "60"), 10) || 60;
const pricePerM = parseFloat(arg("--price", "")) || 0; // USD/1M input tokens

const sessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
const usageFile = path.join(os.homedir(), ".pi", "agent", "analytics", "usage.jsonl");

// ---------- 定位会话文件 ----------
function findSessionFile() {
  if (sessionArg) {
    if (fs.existsSync(sessionArg)) return sessionArg;
    if (fs.existsSync(path.join(sessionsDir, sessionArg))) return path.join(sessionsDir, sessionArg);
    throw new Error(`会话文件不存在: ${sessionArg}`);
  }
  const dirs = fs.readdirSync(sessionsDir).filter((d) => fs.statSync(path.join(sessionsDir, d)).isDirectory());
  let best = null;
  for (const d of dirs) {
    const files = fs.readdirSync(path.join(sessionsDir, d)).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".acp.json"));
    if (!files.length) continue;
    const full = path.join(sessionsDir, d, files[files.length - 1]);
    const st = fs.statSync(full);
    if (!best || st.mtimeMs > best.mtime) best = { path: full, mtime: st.mtimeMs };
  }
  if (!best) throw new Error("找不到任何会话文件");
  return best.path;
}

// ---------- 读取 usage ----------
function readUsage(sessionFile) {
  if (!fs.existsSync(usageFile)) throw new Error(`usage 日志不存在: ${usageFile}`);
  const matcher = sessionFile.replace(/\\/g, "/").toLowerCase().replace(/\.jsonl$/, "");
  const rows = [];
  for (const line of fs.readFileSync(usageFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const [ts, sessionPath] = JSON.parse(line);
      if (String(sessionPath).replace(/\\/g, "/").toLowerCase() !== matcher) continue;
      if (since && ts < Date.parse(since)) continue;
      rows.push(JSON.parse(line));
    } catch { /* 跳过损坏行 */ }
  }
  return rows;
}

// ---------- 提取 compress 调用时间 ----------
function readCompressTimes(sessionFile) {
  const times = [];
  const lines = fs.readFileSync(sessionFile, "utf8").split("\n");
  for (const line of lines) {
    if (!line.includes("compress")) continue;
    try {
      const m = JSON.parse(line);
      if (m.type !== "message") continue;
      const content = m.message?.content;
      if (!Array.isArray(content)) continue;
      if (content.some((p) => p && p.type === "toolCall" && p.name === "compress" && p.status !== "error")) {
        times.push(Date.parse(m.timestamp));
      }
    } catch { /* 跳过非 JSON 行 */ }
  }
  return times.sort((a, b) => a - b);
}

// ---------- 命中率 ----------
function hitRateOf(input, cacheRead, cacheWrite) {
  const denom = input + cacheRead + cacheWrite;
  if (denom <= 0) return null;
  return (cacheRead / denom) * 100;
}
const fmtPct = (v) => (v === null ? "  -" : v.toFixed(1).padStart(5));
const fmtTime = (ts) => new Date(ts).toISOString().slice(11, 19);
const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n));

// 估算每次 compress 后的重算损失：事件首条请求的 cacheR 相比事件前基线跌了多少
function estimateCompressLoss(rows, compressTimes, windowMs) {
  const events = [];
  let lastLinkedTs = -1;
  for (const ct of compressTimes) {
    // 事件窗口内首条非空请求（压缩后恢复通常 2-3 条请求内完成）
    let req = null;
    for (const r of rows) {
      if (r[0] < ct || r[0] > ct + windowMs) continue;
      if (r[4] === 0 && r[6] === 0) continue;
      req = r;
      break;
    }
    if (!req) continue;
    if (req[0] === lastLinkedTs) continue; // 已被更早的 compress 覆盖
    lastLinkedTs = req[0];
    // 基线：该请求前最后一条 cacheR > 0 的请求
    let base = 0;
    for (const r of rows) {
      if (r[0] >= req[0]) break;
      if (r[6] > 0) base = r[6];
    }
    events.push({ ts: ct, firstTs: req[0], baseline: base, firstCacheR: req[6],
      loss: Math.max(0, base - req[6]) });
  }
  return events;
}

// ---------- 主流程 ----------
function main() {
  const sessionFile = findSessionFile();
  const rows = readUsage(sessionFile);
  if (!rows.length) {
    console.log(`[analyze-cache-hit] 会话没有任何 usage 记录\n  ${sessionFile}`);
    process.exit(0);
  }

  const compressTimes = readCompressTimes(sessionFile);
  const stats = { total: 0, inputBig: 0, cacheDrop: 0, compressLinked: 0, hits: [] };

  const lines = [];
  lines.push(`会话: ${sessionFile}`);
  lines.push(`usage 记录: ${rows.length} 条 | compress 调用: ${compressTimes.length} 次 | 窗口: ${compressWindowSec}s`);
  lines.push("");
  lines.push("time      input   output   cacheR   hit%     cacheW  flags");
  lines.push("────────  ──────  ───────  ───────  ─────    ──────  ─────");

  let lastCacheR = null;
  for (const row of rows) {
    const [ts, , , model, input, output, cacheRead, cacheWrite] = row;
    stats.total++;
    const hit = hitRateOf(input, cacheRead, cacheWrite);
    if (hit !== null) stats.hits.push(hit);

    const flags = [];
    if (input > threshold && input > 0) { flags.push("input大"); stats.inputBig++; }
    const prev = lastCacheR ?? 0;
    if (cacheRead > 0 && prev > 0 && cacheRead < prev * 0.5) { flags.push("cacheR暴跌"); stats.cacheDrop++; }

    // compress 对齐：该请求前 compressWindowSec 秒内有 compress 调用 → 标为 compress 后首请求
    let linked = false;
    if (compressTimes.length) {
      const newest = compressTimes[compressTimes.length - 1];
      if (compressTimes.some((ct) => ts - ct >= 0 && ts - ct <= compressWindowSec * 1000)) {
        linked = true;
        flags.push("compress后");
        stats.compressLinked++;
      }
    }
    if (cacheRead > 0 || input > 0) lastCacheR = cacheRead;
    if (cacheRead === 0 && input === 0) flags.push("(空请求)");

    lines.push(
      `${fmtTime(ts)}  ${String(input).padStart(6)}  ${String(output).padStart(6)}  ` +
      `${String(cacheRead).padStart(6)}  ${fmtPct(hit)}%  ${String(cacheWrite).padStart(6)}  ` +
      `${flags.join("、") || ""}`
    );
  }

  const shown = top ? lines.slice(0, top + 4).concat(`… 仅显示前 ${top} 条 (共 ${rows.length} 条，--top 控制)` , "") : lines;
  if (!asJson) console.log(shown.join("\n"));

  // ---------- 总结 ----------
  // ---------- compress 重算损失（无条件计算一次）----------
  const lossEvents = estimateCompressLoss(rows, compressTimes, compressWindowSec * 1000);
  const totalLoss = lossEvents.reduce((a, e) => a + e.loss, 0);
  const perEvent = lossEvents.map((e) => ({ t: fmtTime(e.ts), baseline: e.baseline, firstCacheR: e.firstCacheR, loss: e.loss }));
  const lossJson = { compressCalls: compressTimes.length, lossEvents: lossEvents.length,
    totalLossTokens: totalLoss,
    avgLossPerEvent: lossEvents.length ? Math.round(totalLoss / lossEvents.length) : 0,
    perEvent };
  if (pricePerM) lossJson.estCostUSD = +(totalLoss / 1e6 * pricePerM).toFixed(3);

  if (asJson) {
    const avg = stats.hits.length ? stats.hits.reduce((a, b) => a + b, 0) / stats.hits.length : null;
    console.log(JSON.stringify({ sessionFile, total: stats.total, compressCalls: compressTimes.length,
      inputBig: stats.inputBig, cacheDrop: stats.cacheDrop, compressLinked: stats.compressLinked,
      avgHit: avg ? +avg.toFixed(1) : null, loss: lossJson }, null, 2));
    return;
  }

  const avgHit = stats.hits.length ? stats.hits.reduce((a, b) => a + b, 0) / stats.hits.length : 0;
  // compress 后首请求的平均命中率
  let linkedHits = 0, linkedCount = 0;
  let i = 0;
  for (const row of rows) {
    const [ts, , , , input, , cacheRead, cacheWrite] = row;
    const hit = hitRateOf(input, cacheRead, cacheWrite);
    const isLinked = compressTimes.some((ct) => ts - ct >= 0 && ts - ct <= compressWindowSec * 1000);
    if (isLinked && hit !== null) { linkedHits += hit; linkedCount++; }
    i++;
  }
  console.log("");
  console.log("──────── 总结 ────────");
  console.log(`  整体平均命中率:     ${avgHit.toFixed(1)}%`);
  if (linkedCount) console.log(`  compress 后请求:     ${linkedCount} 条, 平均命中率 ${(linkedHits / linkedCount).toFixed(1)}%`);
  console.log(`  input 暴增 (>${threshold}):  ${stats.inputBig} 条 | cacheR 暴跌: ${stats.cacheDrop} 条`);
  console.log(`  compress 总数:      ${compressTimes.length} 次 (${compressTimes.map(fmtTime).join(", ")})`);
  if (lossEvents.length) {
    console.log("");
    console.log("──────── compress 重算损失 ────────");
    for (const e of lossEvents.slice(0, 12)) {
      console.log(`  ${fmtTime(e.ts)}  基线 ${fmtTokens(e.baseline)} → 首条 ${fmtTokens(e.firstCacheR)}  损失 ~${fmtTokens(e.loss)}`);
    }
    if (lossEvents.length > 12) console.log(`  … 其余 ${lossEvents.length - 12} 个事件略`);
    console.log(`  共 ${lossEvents.length} 个有效事件，重算损失合计 ~${fmtTokens(totalLoss)}` +
      (pricePerM ? ` (≈$${lossJson.estCostUSD})` : "  (--price=<USD/1M> 可估算成本)"));
  }
  if (stats.compressLinked && stats.cacheDrop) {
    const ratio = (stats.cacheDrop / rows.length * 100).toFixed(0);
    if (stats.cacheDrop >= stats.compressLinked * 0.5) {
      console.log(`\n  结论: ${stats.cacheDrop}/${rows.length} 条暴跌请求中至少 ${stats.compressLinked} 条紧邻 compress`);
      console.log(`  → 压缩打破缓存前缀是命中率波动主因 (命中 ${ratio}% 的请求都受影响)`);
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`[analyze-cache-hit] 错误: ${err.message}`);
  process.exit(1);
}