import assert from "node:assert/strict";
import test from "node:test";

const {
  parseUsageLogLine,
  intermediateFromRecords,
  mergeIntermediates,
  buildAggregatedView,
} = await import("./usage-stats.ts");

const row = (overrides = [], costKnown) => {
  const base = [1720000000000, "sid-1", "C:\\proj", "prov/model-a", 100, 50, 10, 5, 165, 0.02];
  if (costKnown !== undefined) base.push(costKnown);
  for (const [i, v] of Object.entries(overrides)) base[Number(i)] = v;
  return JSON.stringify(base);
};

test("parseUsageLogLine accepts 10-field rows and infers costKnown from cost", () => {
  const record = parseUsageLogLine(row());
  assert.ok(record);
  assert.equal(record.totalTokens, 165);
  assert.equal(record.costKnown, true); // cost > 0
  const free = parseUsageLogLine(row({ 9: 0 }));
  assert.equal(free.costKnown, false); // cost = 0 on a 10-field row
});

test("parseUsageLogLine accepts 11-field rows with explicit costKnown", () => {
  const known = parseUsageLogLine(row({ 9: 0 }, 1));
  assert.equal(known.costKnown, true);
  const unknown = parseUsageLogLine(row({ 9: 0.5 }, 0));
  assert.equal(unknown.costKnown, false);
});

test("parseUsageLogLine rejects malformed lines", () => {
  assert.equal(parseUsageLogLine(""), null);
  assert.equal(parseUsageLogLine("   "), null);
  assert.equal(parseUsageLogLine("not json"), null);
  assert.equal(parseUsageLogLine('{"a":1}'), null); // not an array
  assert.equal(parseUsageLogLine("[1,2,3]"), null); // wrong field count
  assert.equal(parseUsageLogLine(row({ 0: -5 })), null); // bad ts
  assert.equal(parseUsageLogLine(row({ 1: "" })), null); // empty sid
  assert.equal(parseUsageLogLine(row({ 4: "x" })), null); // non-numeric input
});

test("intermediateFromRecords buckets by day, model, provider and project", () => {
  const records = [
    parseUsageLogLine(row()),
    parseUsageLogLine(row({ 3: "other/model-b", 2: "C:\\proj", 8: 500 })),
    parseUsageLogLine(row({ 3: "prov/model-a", 2: "C:\\other", 0: 1720000000000 + 86_400_000, 8: 10 })),
  ].filter(Boolean);
  const state = intermediateFromRecords(records);
  assert.equal(state.recordCount, 3);
  assert.equal(state.dayBuckets.length, 2); // second record is the next day
  const day1 = state.dayBuckets[0];
  assert.equal(day1.totals.turns, 2);
  assert.equal(day1.totals.tokens, 665);
  assert.deepEqual(day1.byProvider.map((p) => p.provider), ["other", "prov"]); // tokens desc
  assert.deepEqual(day1.byModel.map((m) => m.model), ["other/model-b", "prov/model-a"]);
  assert.deepEqual(state.totals.sessions, ["sid-1"]);
  assert.equal(state.costKnown, true);
  assert.equal(state.window.since, 1720000000000);
  assert.equal(state.window.to, 1720000000000 + 86_400_000);
});

test("mergeIntermediates: empty delta is a no-op, empty base takes delta", () => {
  const state = intermediateFromRecords([parseUsageLogLine(row())]);
  const empty = intermediateFromRecords([]);
  assert.equal(mergeIntermediates(state, empty), state);
  assert.equal(mergeIntermediates(empty, state), state);
});

test("mergeIntermediates accumulates without double counting", () => {
  const base = intermediateFromRecords([parseUsageLogLine(row())]);
  const delta = intermediateFromRecords([parseUsageLogLine(row({ 8: 999, 9: 0.1 }))]);
  const merged = mergeIntermediates(base, delta);
  assert.equal(merged.recordCount, 2);
  assert.equal(merged.totals.turns, 2);
  const day = merged.dayBuckets.find((b) => b.day === base.dayBuckets[0].day);
  assert.equal(day.totals.tokens, 165 + 999);
  assert.equal(merged.costKnown, true);
});

test("mergeIntermediates propagates unknown-cost flag", () => {
  const base = intermediateFromRecords([parseUsageLogLine(row({ 9: 0.5 }, 0))]);
  const delta = intermediateFromRecords([parseUsageLogLine(row({ 8: 1, 9: 0.1 }))]);
  const merged = mergeIntermediates(base, delta);
  assert.equal(merged.costKnown, false);
});

test("buildAggregatedView derives heatmap, today, week and month views", () => {
  const now = new Date(2026, 8, 6, 12, 0, 0); // 2026-09-06 local, a Sunday
  const todayTs = new Date(2026, 8, 6, 10, 0, 0).getTime();
  const records = [
    parseUsageLogLine(row({ 0: todayTs, 8: 1000 })),
    parseUsageLogLine(row({ 0: todayTs, 8: 2000, 3: "prov/model-b", 2: "C:\\other" })),
    parseUsageLogLine(row({ 0: new Date(2020, 0, 2, 8, 0, 0).getTime(), 8: 100 })), // far past
  ].filter(Boolean);
  const view = buildAggregatedView(intermediateFromRecords(records), now);

  assert.equal(view.heatmap.length, 53 * 7);
  assert.equal(view.heatmapStart, "2025-09-01"); // Monday of the week 53 weeks back
  const todayCell = view.heatmap[view.heatmap.length - 1]; // last cell = today's week, Sunday
  assert.equal(todayCell.tokens, 3000);
  assert.equal(todayCell.level, 3); // 1000..99999 → level 3

  assert.equal(view.today.tokens, 3000);
  assert.equal(view.thisWeek.tokens, 3000);
  assert.equal(view.thisMonth.tokens, 3000);
  assert.equal(view.totals.tokens, 3100);
  assert.equal(view.activeDays, 2);
  assert.deepEqual(view.byModel.map((m) => m.model), ["prov/model-b", "prov/model-a"]);
  assert.deepEqual(view.byProject.map((p) => p.project), ["C:\\other", "C:\\proj"]);
  assert.ok(view.daily[0].byProvider.length > 0);
});
