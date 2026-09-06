import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  deriveDarkFromLight,
  generatePalettesFromSeed,
  hexToHsl,
  normalizeHex6,
} = await createJiti(import.meta.url).import("./web-theme-generate.ts");

const LIGHTNESS = (hex) => hexToHsl(hex)?.[2] ?? -1;
const HUE = (hex) => hexToHsl(hex)?.[0] ?? -1;
test("normalizeHex6 expands #rgb and rejects non-hex values", () => {
  assert.equal(normalizeHex6("#ABC"), "#aabbcc");
  assert.equal(normalizeHex6("#AbCdEf"), "#abcdef");
  assert.equal(normalizeHex6("rgba(1,2,3,0.5)"), null);
  assert.equal(normalizeHex6(""), null);
});

test("one seed expands into complete light and dark palettes", () => {
  const { light, dark } = generatePalettesFromSeed("#e07b39");
  for (const palette of [light, dark]) {
    for (const [key, value] of Object.entries(palette)) {
      assert.match(key, /^--/);
      assert.match(value, /^#[0-9a-f]{6}$/);
    }
    assert.equal(Object.keys(palette).length, 14);
  }
});

test("generated light palette is light with dark text; dark palette inverts", () => {
  const { light, dark } = generatePalettesFromSeed("#e07b39");
  assert.ok(LIGHTNESS(light["--bg"]) > 95, `light bg too dark: ${light["--bg"]}`);
  assert.ok(LIGHTNESS(light["--text"]) < 20, `light text too bright: ${light["--text"]}`);
  assert.ok(LIGHTNESS(dark["--bg"]) < 10, `dark bg too light: ${dark["--bg"]}`);
  assert.ok(LIGHTNESS(dark["--text"]) > 85, `dark text too dim: ${dark["--text"]}`);
  // Surfaces stay ordered: bg is the darkest, panel/hover sit above it.
  const darkBg = LIGHTNESS(dark["--bg"]);
  for (const key of ["--bg-panel", "--bg-hover", "--bg-selected", "--border"]) {
    assert.ok(LIGHTNESS(dark[key]) > darkBg, `${key} should be lighter than --bg`);
  }
});

test("the seed hue drives the accent color", () => {
  const { light, dark } = generatePalettesFromSeed("#2e8b57"); // sea green ≈ hue 147
  assert.ok(Math.abs(HUE(light["--accent"]) - HUE(dark["--accent"])) < 1);
  // Same hue family as the seed (allow small rounding drift).
  assert.ok(Math.abs(((HUE(light["--accent"]) - 147 + 540) % 360) - 180) < 181 - 175);
});

test("generation is deterministic and accepts #rgb seeds", () => {
  const a = generatePalettesFromSeed("#0af");
  const b = generatePalettesFromSeed("#00aaff");
  assert.deepEqual(a, b);
});

test("deriveDarkFromLight keeps non-hex values and darkens backgrounds", () => {
  const light = generatePalettesFromSeed("#7c5cff").light;
  const weird = { ...light, "--tool-bg": "rgba(10, 20, 30, 0.5)" };
  const dark = deriveDarkFromLight(weird);
  assert.equal(dark["--tool-bg"], "rgba(10, 20, 30, 0.5)");
  assert.ok(LIGHTNESS(dark["--bg"]) < 20);
});
