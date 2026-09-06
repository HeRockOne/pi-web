import assert from "node:assert/strict";
import test from "node:test";

const {
  formatTokens,
  formatCost,
  dayKeyOf,
  formatDayKeyPlusOffset,
  colorForProvider,
  buildBuckets,
} = await import("./usage-stats-format.ts");

test("formatTokens uses K/M/B short suffixes", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1234), "1.2K");
  assert.equal(formatTokens(2_500_000), "2.50M");
  assert.equal(formatTokens(3_100_000_000), "3.10B");
});

test("formatCost keeps small amounts visible", () => {
  assert.equal(formatCost(0.0015), "$0.0015");
  assert.equal(formatCost(2.5), "$2.50");
  assert.equal(formatCost(150), "$150");
});

test("dayKeyOf and formatDayKeyPlusOffset stay in local time", () => {
  const d = new Date(2026, 8, 6);
  assert.equal(dayKeyOf(d), "2026-09-06");
  assert.equal(formatDayKeyPlusOffset("2026-08-31", 6), "2026-09-06");
  assert.equal(formatDayKeyPlusOffset("bad", 1), "bad");
});

test("colorForProvider is stable per name", () => {
  assert.equal(colorForProvider("prov"), colorForProvider("prov"));
  assert.equal(colorForProvider("a"), colorForProvider("a"));
});

const rows = (spec) => spec.map(([day, tokens, providers]) => ({
  day,
  totals: { tokens },
  byProvider: providers.map(([provider, pTokens]) => ({ provider, tokens: pTokens })),
}));

test("buildBuckets day mode keeps only the last 30 days with tokens > 0", () => {
  const now = new Date(2026, 8, 6, 12, 0, 0);
  const dayKey = (offset) => dayKeyOf(new Date(2026, 8, 6 - offset));
  const result = buildBuckets(
    rows([
      [dayKey(40), 999, [["a", 999]]], // out of window
      [dayKey(1), 0, []],
      [dayKey(0), 100, [["a", 60], ["b", 40]]],
    ]),
    "day",
    now,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].label, dayKey(0).slice(5));
  assert.deepEqual(result[0].byProvider, [{ provider: "a", tokens: 60 }, { provider: "b", tokens: 40 }]);
});

test("buildBuckets week mode merges by local Monday in ascending order", () => {
  const now = new Date(2026, 8, 6, 12, 0, 0);
  // 2026-08-31 is Monday, 2026-09-06 its Sunday; 2026-08-24 the previous Monday.
  const result = buildBuckets(
    rows([
      ["2026-06-01", 900, [["a", 900]]],
      ["2026-06-29", 900, [["a", 900]]],
      ["2026-08-24", 500, [["a", 500]]],
      ["2026-08-31", 100, [["a", 100]]],
      ["2026-09-02", 50, [["a", 30], ["b", 20]]],
      ["2026-09-06", 30, [["b", 30]]],
    ]),
    "week",
    now,
  );
  assert.equal(result.length, 4);
  assert.equal(result[0].label, "06-01");
  assert.equal(result[3].label, "08-31");
  assert.equal(result[3].tokens, 180);
  assert.deepEqual(result[3].byProvider, [{ provider: "a", tokens: 130 }, { provider: "b", tokens: 50 }]);
});

test("buildBuckets month mode labels buckets as YYYY-MM", () => {
  const now = new Date(2026, 8, 6, 12, 0, 0);
  const result = buildBuckets(
    rows([
      ["2026-08-05", 100, [["a", 100]]],
      ["2026-08-20", 50, [["b", 50]]],
      ["2026-09-01", 70, [["a", 70]]],
    ]),
    "month",
    now,
  );
  assert.deepEqual(result.map((b) => b.label), ["2026-08", "2026-09"]);
  assert.equal(result[0].tokens, 150);
});
