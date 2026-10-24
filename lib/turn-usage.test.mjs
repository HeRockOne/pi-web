import { test } from "node:test";
import assert from "node:assert/strict";
import { getTurnUsage, promptTokens, totalTokens, usageTotals } from "./turn-usage.ts";

function response(usage, extra = {}) {
  return { role: "assistant", content: [{ type: "text", text: "ok" }], model: "m", provider: "p", usage, ...extra };
}

const usage = (input, output, cacheRead, cacheWrite, total) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

test("a turn's usage is every response in it summed", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    response(usage(1000, 30, 20000, 5, 0.01)),
    { role: "toolResult", toolCallId: "t", content: [], usage: usage(5000, 0, 0, 0, 0.02) },
    response(usage(200, 40, 40000, 0, 0.03)),
    { role: "user", content: [{ type: "text", text: "next" }] },
  ];

  const totals = getTurnUsage(messages, 0, 4);
  assert.deepEqual(totals, { input: 1200, output: 70, cacheRead: 60000, cacheWrite: 5, costTotal: 0.04 });
  assert.equal(promptTokens(totals), 61205);
  assert.equal(totalTokens(totals), 61275);
});

test("tool results carry no response usage into the totals", () => {
  const messages = [
    { role: "user", content: [] },
    { role: "toolResult", toolCallId: "t", content: [], usage: usage(5000, 0, 0, 0, 0.02) },
    response(usage(10, 1, 0, 0, 0.001)),
  ];

  assert.deepEqual(getTurnUsage(messages, 0, 3), { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, costTotal: 0.001 });
});

test("a turn without any reported usage has none, and only its own range counts", () => {
  const messages = [
    { role: "user", content: [] },
    response(usage(10, 1, 0, 0, 0)),
    { role: "user", content: [] },
    response(usage(999, 999, 999, 999, 9)),
  ];

  assert.equal(getTurnUsage(messages, 2, 4).input, 999);
  assert.deepEqual(getTurnUsage(messages, 2, 3), undefined);
  assert.deepEqual(getTurnUsage([{ role: "user", content: [] }], 0, 1), undefined);
});

test("a missing cost object reads as zero rather than NaN", () => {
  const bare = { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 };
  assert.deepEqual(usageTotals(bare), { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, costTotal: 0 });
  assert.equal(getTurnUsage([{ role: "user", content: [] }, response(bare)], 0, 2).costTotal, 0);
});
