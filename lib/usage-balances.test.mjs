import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { computeBalances, readBalanceConfigs, saveProviderBalance } = await jiti.import("./usage-balances.ts");

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

  assert.deepEqual(openai, { provider: "openai", balance: 20, spent: 3.5, remaining: 16.5, costKnown: true, hasUsage: true });
  assert.deepEqual(anthropic, { provider: "anthropic", balance: null, spent: 2, remaining: null, costKnown: true, hasUsage: true });
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
  assert.deepEqual(rows, [{ provider: "custom", balance: 10, spent: 0, remaining: 10, costKnown: true, hasUsage: false }]);
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
