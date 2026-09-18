import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { computeBalances, readBalanceConfigs, saveProviderBalance, undoProviderBalance } = await jiti.import("./usage-balances.ts");

function createTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-usage-balances-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** 最小 UsageStatsIntermediate fixture：provider -> [cost, turns]。 */
function makeIntermediate(providers, costKnown = true) {
  return {
    costKnown,
    firstTs: 0,
    lastTs: 0,
    dayBuckets: [
      {
        day: "2025-01-01",
        totals: {},
        sessions: [],
        byProvider: providers.map(([provider, cost, turns]) => ({ provider, tokens: 0, cost, turns })),
        byModel: [],
        byProject: [],
      },
    ],
  };
}

test("computes spent/remaining from usage when a balance is configured", (t) => {
  const root = createTempRoot(t);
  const file = path.join(root, "balances.json");
  saveProviderBalance("openai", 20, {}, file);

  const rows = computeBalances(makeIntermediate([["openai", 3.5, 4], ["anthropic", 2, 1]]), file);
  const openai = rows.find((r) => r.provider === "openai");
  const anthropic = rows.find((r) => r.provider === "anthropic");

  assert.deepEqual(openai, { provider: "openai", balance: 20, spent: 3.5, remaining: 16.5, costKnown: true, hasUsage: true, canUndo: true });
  assert.deepEqual(anthropic, { provider: "anthropic", balance: null, spent: 2, remaining: null, costKnown: true, hasUsage: true, canUndo: false });
});

test("resetSpent baselines the current cost so spent restarts from zero", (t) => {
  const root = createTempRoot(t);
  const file = path.join(root, "balances.json");
  saveProviderBalance("openai", 20, {}, file);
  saveProviderBalance("openai", 20, { resetSpent: true, currentCost: 3.5 }, file);

  const rows = computeBalances(makeIntermediate([["openai", 3.5, 4]]), file);
  const openai = rows.find((r) => r.provider === "openai");
  assert.equal(openai.spent, 0);
  assert.equal(openai.remaining, 20);
});

test("add tops up on top of the existing balance without touching spent baseline", (t) => {
  const root = createTempRoot(t);
  const file = path.join(root, "balances.json");
  // 首次充值 10（无配置时从 0 起）
  saveProviderBalance("openai", null, { add: 10 }, file);
  let rows = computeBalances(makeIntermediate([["openai", 3, 4]]), file);
  let openai = rows.find((r) => r.provider === "openai");
  assert.equal(openai.balance, 10);
  assert.equal(openai.spent, 3);
  assert.equal(openai.remaining, 7);
  // 再充 5：余额叠到 15，已扣基线不变（仍 3）
  saveProviderBalance("openai", null, { add: 5 }, file);
  rows = computeBalances(makeIntermediate([["openai", 3, 4]]), file);
  openai = rows.find((r) => r.provider === "openai");
  assert.equal(openai.balance, 15);
  assert.equal(openai.spent, 3);
  assert.equal(openai.remaining, 12);
});

test("clearing a balance with null removes the configured row", (t) => {
  const root = createTempRoot(t);
  const file = path.join(root, "balances.json");
  saveProviderBalance("openai", 20, {}, file);
  saveProviderBalance("openai", null, {}, file);

  const rows = computeBalances(makeIntermediate([["openai", 3.5, 4]]), file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].balance, null);
  assert.equal(rows[0].spent, 3.5);
});

test("shows configured providers even without usage records", (t) => {
  const root = createTempRoot(t);
  const file = path.join(root, "balances.json");
  saveProviderBalance("custom", 10, {}, file);

  const rows = computeBalances(null, file);
  assert.deepEqual(rows, [{ provider: "custom", balance: 10, spent: 0, remaining: 10, costKnown: true, hasUsage: false, canUndo: true }]);
});

test("negative remaining when over the budget", (t) => {
  const root = createTempRoot(t);
  const file = path.join(root, "balances.json");
  saveProviderBalance("openai", 5, {}, file);

  const rows = computeBalances(makeIntermediate([["openai", 6, 1]]), file);
  assert.equal(rows[0].remaining, -1);
});

test("tolerates a corrupt balances file", (t) => {
  const root = createTempRoot(t);
  const file = path.join(root, "balances.json");
  fs.writeFileSync(file, "{ not json !!!");
  assert.deepEqual(readBalanceConfigs(file), {});
  assert.deepEqual(computeBalances(null, file), []);
});

test("ignores malformed entries but keeps valid ones", (t) => {
  const root = createTempRoot(t);
  const file = path.join(root, "balances.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      balances: {
        openai: { balance: 20, spentBaseline: 1, updatedAt: 123 },
        broken: { balance: "nope", spentBaseline: 0, updatedAt: 1 },
      },
    }),
  );
  assert.deepEqual(Object.keys(readBalanceConfigs(file)), ["openai"]);
});

test("undo restores the previous balance after an add", (t) => {
  const root = createTempRoot(t);
  const file = path.join(root, "balances.json");
  saveProviderBalance("custom", 10, {}, file);
  saveProviderBalance("custom", null, { add: 5 }, file);

  assert.equal(readBalanceConfigs(file).custom.balance, 15);
  const restored = undoProviderBalance("custom", file);
  assert.equal(restored.balance, 10);
  assert.equal(readBalanceConfigs(file).custom.balance, 10);
});

test("undo walks back multiple steps", (t) => {
  const root = createTempRoot(t);
  const file = path.join(root, "balances.json");
  saveProviderBalance("custom", null, { add: 5 }, file);
  saveProviderBalance("custom", null, { add: 3 }, file);
  saveProviderBalance("custom", null, { add: 2 }, file);
  assert.equal(readBalanceConfigs(file).custom.balance, 10);

  undoProviderBalance("custom", file);
  assert.equal(readBalanceConfigs(file).custom.balance, 8);
  undoProviderBalance("custom", file);
  assert.equal(readBalanceConfigs(file).custom.balance, 5);
  undoProviderBalance("custom", file);
  assert.equal(readBalanceConfigs(file).custom, undefined);
  assert.equal(undoProviderBalance("custom", file), undefined);
});

test("undo removes a config created from nothing (lastOp null)", (t) => {
  const root = createTempRoot(t);
  const file = path.join(root, "balances.json");
  saveProviderBalance("custom", 10, {}, file);
  assert.equal(readBalanceConfigs(file).custom.balance, 10);

  undoProviderBalance("custom", file);
  assert.equal(readBalanceConfigs(file).custom, undefined);
});

test("canUndo reflects undo availability", (t) => {
  const root = createTempRoot(t);
  const file = path.join(root, "balances.json");
  assert.equal(computeBalances(null, file).find((r) => r.provider === "custom"), undefined);

  saveProviderBalance("custom", null, { add: 5 }, file);
  assert.equal(computeBalances(null, file).find((r) => r.provider === "custom")?.canUndo, true);

  undoProviderBalance("custom", file);
  assert.equal(computeBalances(null, file).find((r) => r.provider === "custom"), undefined);
});
