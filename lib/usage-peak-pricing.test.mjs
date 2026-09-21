import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isPeakHour, repricedCost, buildModelCostMap } = await jiti.import("./usage-peak-pricing.ts");

const ts = (hour) => new Date(2024, 0, 15, hour, 30).getTime();

const baseCost = {
  input: 0.5, output: 1, cacheRead: 0.1, cacheWrite: 0.2,
  peak: { hours: [{ start: 9, end: 12 }], input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0.4 },
};

const rec = { ts: ts(10), input: 1_000_000, output: 500_000, cacheRead: 200_000, cacheWrite: 100_000 };

test("isPeakHour: normal window is half-open [start, end)", () => {
  assert.equal(isPeakHour(ts(9), [{ start: 9, end: 12 }]), true);
  assert.equal(isPeakHour(ts(10), [{ start: 9, end: 12 }]), true);
  assert.equal(isPeakHour(ts(11), [{ start: 9, end: 12 }]), true);
  assert.equal(isPeakHour(ts(12), [{ start: 9, end: 12 }]), false);
  assert.equal(isPeakHour(ts(8), [{ start: 9, end: 12 }]), false);
});

test("isPeakHour: cross-midnight window (22:00-02:00)", () => {
  const hours = [{ start: 22, end: 2 }];
  assert.equal(isPeakHour(ts(22), hours), true);
  assert.equal(isPeakHour(ts(23), hours), true);
  assert.equal(isPeakHour(ts(1), hours), true);
  assert.equal(isPeakHour(ts(2), hours), false);
  assert.equal(isPeakHour(ts(12), hours), false);
});

test("isPeakHour: empty or invalid windows are never peak", () => {
  assert.equal(isPeakHour(ts(10), []), false);
  assert.equal(isPeakHour(ts(10), [{ start: 99, end: 12 }]), false);
  assert.equal(isPeakHour(ts(10), [{ start: 0, end: 24 }]), true);
});

test("repricedCost: peak hours use peak rates, off-peak uses base rates", () => {
  // 峰时 10am: 1*1 + 0.5*2 + 0.2*0.2 + 0.1*0.4 = 2.08
  assert.equal(repricedCost(rec, baseCost), 2.08);
  // 谷时 3pm: 1*0.5 + 0.5*1 + 0.2*0.1 + 0.1*0.2 = 1.04
  assert.equal(repricedCost({ ...rec, ts: ts(15) }, baseCost), 1.04);
});

test("repricedCost: returns null when no peak config", () => {
  assert.equal(repricedCost(rec, { input: 0.5, output: 1, cacheRead: 0.1, cacheWrite: 0.2 }), null);
  assert.equal(repricedCost(rec, undefined), null);
});

test("repricedCost: zero-cost records reprice to their computed cost", () => {
  const zeroRec = { ts: ts(10), input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.equal(repricedCost(zeroRec, baseCost), 0);
});

test("buildModelCostMap: defensively returns a Map even without models.json", () => {
  const map = buildModelCostMap();
  assert.ok(map instanceof Map);
});