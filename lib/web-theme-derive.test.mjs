import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  contrastRatio,
  contrastVerdict,
  deriveRelated,
  mixHex,
  restoreDerived,
  swatchHex,
} = await jiti.import("./web-theme-generate.ts");
const { THEME_VARIABLE_KEYS } = await jiti.import("./web-theme-types.ts");

const light = {
  "--bg": "#ffffff",
  "--bg-panel": "#f7f6f4",
  "--bg-hover": "#f0efec",
  "--bg-selected": "#e9e7e3",
  "--border": "#e4e2de",
  "--text": "#1f1e1c",
  "--text-muted": "#6b6762",
  "--text-dim": "#a39e97",
  "--accent": "#3f6a8f",
  "--accent-hover": "#325777",
  "--user-bg": "#f3f5f7",
  "--assistant-bg": "#ffffff",
  "--tool-bg": "#faf9f7",
  "--bg-subtle": "rgba(0, 0, 0, 0.028)",
};

const dark = {
  ...light,
  "--bg": "#1a1a1a",
  "--text": "#e8e8e8",
};

test("mixHex blends toward the second color and keeps the first hue", () => {
  assert.equal(mixHex("#ffffff", "#000000", 0), "#ffffff");
  assert.equal(mixHex("#ffffff", "#000000", 1), "#000000");
  // 50% of the lightness delta, hue of the first argument.
  assert.equal(mixHex("#ffffff", "#000000", 0.5), "#808080");
  // Same lightness at both ends: a hue-preserving mix returns the first color.
  assert.equal(mixHex("#ff0000", "#00ff00", 0.5), "#ff0000");
  // Non-hex inputs (rgba overlay tokens) are refused instead of corrupted.
  assert.equal(mixHex("rgba(0,0,0,0.03)", "#ffffff", 0.5), null);
});

test("contrastRatio follows WCAG for the extremes", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  assert.equal(contrastRatio("#ffffff", "#ffffff"), 1);
  const ratio = contrastRatio("#6b6762", "#ffffff");
  assert.ok(ratio > 5 && ratio < 6, `muted text on white should be ~5.4, got ${ratio}`);
  assert.equal(contrastRatio("nonsense", "#ffffff"), null);
});

test("contrastRatio composites translucent foregrounds over the background", () => {
  // A near-transparent black over white is nearly invisible, not 21:1.
  const ratio = contrastRatio("rgba(0, 0, 0, 0.028)", "#ffffff");
  assert.ok(ratio !== null && ratio < 1.2, `expected a near-1 ratio, got ${ratio}`);
});

test("contrastVerdict tiers at 4.5 and 3", () => {
  assert.equal(contrastVerdict(21), "good");
  assert.equal(contrastVerdict(4.5), "good");
  assert.equal(contrastVerdict(3), "low");
  assert.equal(contrastVerdict(2.9), "bad");
  assert.equal(contrastVerdict(null), "bad");
});

test("deriveRelated keeps a light palette readable from just bg and text", () => {
  const palette = { ...light, "--bg": "#ffffff", "--text": "#1f1e1c" };
  const derived = deriveRelated(palette, "--bg", "light");
  // Surfaces step away from the background toward the text color, in order.
  // --bg-subtle is left out: it stays translucent on purpose (see its own test).
  const order = ["--tool-bg", "--bg-panel", "--bg-hover", "--bg-selected"];
  const lightness = order.map((key) => Number.parseInt(derived[key].slice(1, 3), 16));
  for (let i = 1; i < lightness.length; i += 1) {
    assert.ok(lightness[i] <= lightness[i - 1], `${order[i]} must not be lighter than ${order[i - 1]}`);
  }
  assert.equal(derived["--assistant-bg"], "#ffffff");
  assert.ok(contrastRatio(derived["--border"], "#ffffff") > 1.1);
  // Text tokens stay readable: the derived border is visible but not a hairline
  // of pure text color.
  assert.ok(contrastRatio(derived["--border"], "#ffffff") < 2);
});

test("deriveRelated derives quiet text and accent steps", () => {
  const palette = { ...light, "--bg": "#ffffff", "--text": "#1f1e1c", "--accent": "#3f6a8f" };
  const text = deriveRelated(palette, "--text", "light");
  const muted = contrastRatio(text["--text-muted"], "#ffffff");
  const dim = contrastRatio(text["--text-dim"], "#ffffff");
  assert.ok(muted > dim, "muted text must stay more readable than dim text");
  assert.ok(muted > 4.5, `muted should pass AA on white, got ${muted}`);

  const accent = deriveRelated(palette, "--accent", "light");
  assert.ok(accent["--accent-hover"] && accent["--accent-hover"] !== "#3f6a8f");
  // The user bubble is a barely-there accent tint over the page background.
  const tinted = contrastRatio(accent["--user-bg"], "#ffffff");
  assert.ok(tinted > 1 && tinted < 1.4, `bubble tint should be subtle, got ${tinted}`);
});

test("deriveRelated darkens the other way and every key stays a valid color", () => {
  const palette = { ...dark, "--bg": "#1a1a1a", "--text": "#e8e8e8", "--accent": "#60a5fa" };
  const surface = deriveRelated(palette, "--bg", "dark");
  const panel = Number.parseInt(surface["--bg-panel"].slice(1, 3), 16);
  const bg = Number.parseInt(palette["--bg"].slice(1, 3), 16);
  assert.ok(panel > bg, "dark panels lift above the page background");
  const accent = deriveRelated(palette, "--accent", "dark");
  const hover = Number.parseInt(accent["--accent-hover"].slice(1, 3), 16);
  assert.ok(hover > Number.parseInt(palette["--accent"].slice(1, 3), 16), "dark accent hover brightens");
});

test("every advanced token can be restored to its derived value", () => {
  const palette = { ...light, "--bg": "#ffffff", "--text": "#1f1e1c", "--accent": "#3f6a8f" };
  const derivedKeys = THEME_VARIABLE_KEYS.filter((key) => !["--bg", "--bg-panel", "--text", "--accent"].includes(key));
  for (const key of derivedKeys) {
    const value = restoreDerived(palette, key, "light");
    assert.ok(typeof value === "string" && /^#|^rgba?\(/.test(value), `${key} should restore to a color, got ${value}`);
  }
});

test("--bg-subtle stays translucent so it can stack over other surfaces", () => {
  const palette = { ...light, "--bg": "#ffffff", "--text": "#1f1e1c" };
  const darkPalette = { ...dark, "--bg": "#1a1a1a", "--text": "#e8e8e8" };
  assert.match(deriveRelated(palette, "--bg", "light")["--bg-subtle"], /^rgba\(31, 30, 28, 0\.028\)$/);
  assert.match(deriveRelated(darkPalette, "--bg", "dark")["--bg-subtle"], /^rgba\(232, 232, 232, 0\.05\)$/);
});

test("swatchHex composites translucent tokens over the surface", () => {
  assert.equal(swatchHex("#ffffff", "#000000"), "#ffffff");
  assert.equal(swatchHex("rgba(0, 0, 0, 0.5)", "#ffffff"), "#808080");
  assert.equal(swatchHex("#3f6a8f", "#ffffff"), "#3f6a8f");
  assert.equal(swatchHex("not-a-color", "#ffffff"), "#888888");
});
