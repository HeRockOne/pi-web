import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  parseCompletePeakPricing,
  offPeakWindows,
  peakPricingToDraft,
} = await jiti.import("./models-config-helpers.ts");

const draft = (overrides = {}) => ({
  enabled: true,
  hours: [{ start: "9", end: "12" }],
  input: "2",
  output: "1",
  cacheRead: "",
  cacheWrite: "",
  ...overrides,
});

test("offPeakWindows: 峰 9-12、14-18 → 谷 0-9、12-14、18-24", () => {
  const off = offPeakWindows([{ start: "9", end: "12" }, { start: "14", end: "18" }]);
  assert.deepEqual(off, [
    { start: 0, end: 9 },
    { start: 12, end: 14 },
    { start: 18, end: 24 },
  ]);
});

test("offPeakWindows: 跨午夜窗口 22-02 → 谷 2-22", () => {
  const off = offPeakWindows([{ start: "22", end: "2" }]);
  assert.deepEqual(off, [{ start: 2, end: 22 }]);
});

test("offPeakWindows: 全天窗口 0-24 → 无谷时段", () => {
  assert.deepEqual(offPeakWindows([{ start: "0", end: "24" }]), []);
});

test("offPeakWindows: 非法输入被忽略", () => {
  assert.deepEqual(
    offPeakWindows([
      { start: "abc", end: "12" },
      { start: "9", end: "99" },
      { start: "7", end: "8" },
    ]),
    [{ start: 0, end: 7 }, { start: 8, end: 24 }],
  );
});

test("parseCompletePeakPricing: 部分峰时价即可返回（缺省项留给调用方兜底）", () => {
  const parsed = parseCompletePeakPricing(draft());
  assert.deepEqual(parsed, { hours: [{ start: 9, end: 12 }], input: 2, output: 1 });
});

test("parseCompletePeakPricing: 一项峰时价都没填 → undefined", () => {
  assert.equal(
    parseCompletePeakPricing(draft({ input: "", output: "", cacheRead: "", cacheWrite: "" })),
    undefined,
  );
});

test("parseCompletePeakPricing: 无有效峰时段 → undefined", () => {
  assert.equal(parseCompletePeakPricing(draft({ hours: [{ start: "", end: "" }] })), undefined);
});

test("parseCompletePeakPricing: 未启用 → undefined", () => {
  assert.equal(parseCompletePeakPricing(draft({ enabled: false })), undefined);
});

test("parseCompletePeakPricing: 负价格项被忽略，其余合法项保留", () => {
  const parsed = parseCompletePeakPricing(draft({ input: "-1", output: "2" }));
  assert.deepEqual(parsed, { hours: [{ start: 9, end: 12 }], output: 2 });
});

test("parseCompletePeakPricing: 全部价格无效 → undefined", () => {
  assert.equal(
    parseCompletePeakPricing(draft({ input: "-1", output: "-2", cacheRead: "", cacheWrite: "" })),
    undefined,
  );
});

test("peakPricingToDraft round-trip: 已存配置（含继承补齐的 4 项价）能完整回读", () => {
  const s = { hours: [{ start: 9, end: 12 }, { start: 14, end: 18 }], input: 2.5, output: 1.2, cacheRead: 0, cacheWrite: 0 };
  assert.deepEqual(peakPricingToDraft(s), {
    enabled: true,
    hours: [{ start: "9", end: "12" }, { start: "14", end: "18" }],
    input: "2.5",
    output: "1.2",
    cacheRead: "0",
    cacheWrite: "0",
  });
});