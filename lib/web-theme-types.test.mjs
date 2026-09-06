import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  THEME_VARIABLE_KEYS,
  allThemes,
  findTheme,
  isValidPalette,
  isValidThemeId,
  sanitizeCustomTheme,
  sanitizeThemesFile,
  themeToCss,
} = await jiti.import("./web-theme-types.ts");

function validPalette(overrides = {}) {
  const palette = {};
  for (const key of THEME_VARIABLE_KEYS) palette[key] = "#123456";
  return { ...palette, ...overrides };
}

test("builtin themes cover every variable key in both palettes", () => {
  assert.ok(BUILTIN_THEMES.length >= 2);
  for (const theme of BUILTIN_THEMES) {
    assert.equal(theme.builtin, true);
    for (const key of THEME_VARIABLE_KEYS) {
      assert.equal(typeof theme.light[key], "string", `${theme.id} light ${key}`);
      assert.equal(typeof theme.dark[key], "string", `${theme.id} dark ${key}`);
    }
  }
});

test("themeToCss overrides both :root and html.dark with all keys", () => {
  const theme = BUILTIN_THEMES[1];
  const css = themeToCss(theme);
  assert.ok(css.includes(":root:root {"));
  assert.ok(css.includes("html.dark:root {"));
  for (const key of THEME_VARIABLE_KEYS) assert.ok(css.includes(key));
  assert.ok(css.includes(theme.light["--accent"]));
  assert.ok(css.includes(theme.dark["--accent"]));
});

test("sanitizeCustomTheme accepts a valid theme and rejects bad ids", () => {
  const theme = sanitizeCustomTheme({
    id: "my-theme",
    name: "My Theme",
    description: "test",
    light: validPalette(),
    dark: validPalette(),
  });
  assert.ok(theme);
  assert.equal(theme.builtin, false);
  assert.equal(sanitizeCustomTheme({ ...{ id: "pi-x" }, name: "x", light: validPalette(), dark: validPalette() }), null);
  assert.equal(sanitizeCustomTheme({ id: "Bad Id", name: "x", light: validPalette(), dark: validPalette() }), null);
  assert.equal(sanitizeCustomTheme({ id: "ok", name: "", light: validPalette(), dark: validPalette() }), null);
  assert.equal(sanitizeCustomTheme({ id: "ok", name: "x", light: validPalette({ "--bg": "" }), dark: validPalette() }), null);
  assert.equal(sanitizeCustomTheme({ id: "ok", name: "x", light: validPalette({ "--bg": "a{b" }), dark: validPalette() }), null);
  assert.equal(sanitizeCustomTheme(null), null);
});

test("isValidPalette enforces length and character guards", () => {
  assert.equal(isValidPalette(validPalette()), true);
  assert.equal(isValidPalette(validPalette({ "--text": "x".repeat(121) })), false);
  assert.equal(isValidPalette(validPalette({ "--border": "<script>" })), false);
  assert.equal(isValidPalette(null), false);
});

test("isValidThemeId", () => {
  assert.equal(isValidThemeId("warm-orange"), true);
  assert.equal(isValidThemeId("a".repeat(64)), true);
  assert.equal(isValidThemeId(""), false);
  assert.equal(isValidThemeId("-lead"), false);
  assert.equal(isValidThemeId(42), false);
});

test("sanitizeThemesFile fails closed on malformed input", () => {
  assert.deepEqual(sanitizeThemesFile(null), { active: DEFAULT_THEME_ID, custom: [] });
  const file = sanitizeThemesFile({
    active: "warm-orange",
    custom: [
      { id: "good", name: "Good", light: validPalette(), dark: validPalette() },
      { id: "bad id", name: "Bad", light: validPalette(), dark: validPalette() },
      { id: "good", name: "Dup", light: validPalette(), dark: validPalette() },
    ],
  });
  assert.equal(file.active, "warm-orange");
  assert.equal(file.custom.length, 1);
  assert.equal(file.custom[0].name, "Good");
});

test("allThemes merges builtin first and findTheme resolves", () => {
  const custom = [{ id: "zz", name: "Z", builtin: false, light: validPalette(), dark: validPalette() }];
  const themes = allThemes(custom);
  assert.equal(themes[0].id, DEFAULT_THEME_ID);
  assert.equal(themes[themes.length - 1].id, "zz");
  assert.equal(findTheme(themes, "zz").name, "Z");
  assert.equal(findTheme(themes, "missing"), undefined);
});
