import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { computeRemainingSeries } = await jiti.import("./usage-balances.ts");

function createTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-balance-timeline-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeBalances(t, balances) {
  const root = createTempRoot(t);
  const file = path.join(root, "balances.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, balances }));
  return file;
}

function makeRecords(...rows) {
  return rows.map(([ts, model, cost]) => ({
    ts,
    sid: "s1",
    cwd: "/tmp",
    model,
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost,
    costKnown: cost > 0,
  }));
}

test("remaining series follows per-request cost progression", (t) => {
  const file = writeBalances(t, {
    anthropic: { balance: 100, spentBaseline: 0, updatedAt: Date.now() },
  });
  const records = makeRecords(
    [1000, "anthropic/claude", 1],
    [2000, "anthropic/claude", 1],
    [3000, "anthropic/claude", 1],
  );
  const { providers } = computeRemainingSeries(records, [1000, 2000, 3000], file);
  assert.deepEqual(providers.anthropic.remainingSeries, [99, 98, 97]);
});

test("timestamps before any request report full balance", (t) => {
  const file = writeBalances(t, {
    anthropic: { balance: 100, spentBaseline: 0, updatedAt: Date.now() },
  });
  const records = makeRecords([2000, "anthropic/claude", 5]);
  const { providers } = computeRemainingSeries(records, [1000, 2000, 2500], file);
  assert.deepEqual(providers.anthropic.remainingSeries, [100, 95, 95]);
});

test("spentBaseline offsets the deduction", (t) => {
  const file = writeBalances(t, {
    anthropic: { balance: 100, spentBaseline: 10, updatedAt: Date.now() },
  });
  const records = makeRecords(
    [1000, "anthropic/claude", 5],
    [2000, "anthropic/claude", 10],
  );
  const { providers } = computeRemainingSeries(records, [1000, 2000], file);
  assert.deepEqual(providers.anthropic.remainingSeries, [100, 95]);
});

test("multiple providers tracked independently", (t) => {
  const file = writeBalances(t, {
    anthropic: { balance: 50, spentBaseline: 0, updatedAt: Date.now() },
  });
  const records = makeRecords(
    [1000, "anthropic/claude", 1],
    [1500, "openai/gpt", 2],
    [2000, "anthropic/claude", 3],
  );
  const { providers } = computeRemainingSeries(records, [1000, 1500, 2000], file);
  assert.deepEqual(providers.anthropic.remainingSeries, [49, 49, 46]);
  assert.deepEqual(providers.openai.remainingSeries, [null, null, null]);
});

test("empty records still report balance", (t) => {
  const file = writeBalances(t, {
    anthropic: { balance: 100, spentBaseline: 0, updatedAt: Date.now() },
  });
  const { providers } = computeRemainingSeries([], [1000], file);
  assert.deepEqual(providers.anthropic.remainingSeries, [100]);
});
