import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { PRISM_DARK_THEME, PRISM_LIGHT_THEME } = await jiti.import("./prism-themes.ts");

const PRE_SELECTOR = 'pre[class*="language-"]';
const CODE_SELECTOR = 'code[class*="language-"]';

for (const [name, theme] of [["light", PRISM_LIGHT_THEME], ["dark", PRISM_DARK_THEME]]) {
  test(`the ${name} theme paints the code block with a longhand background only`, () => {
    const pre = theme[PRE_SELECTOR];
    assert.ok(pre, "the theme keeps its pre style");
    assert.equal(pre.background, undefined, "no shorthand survives, so a theme switch cannot remove a conflicting property");
    assert.equal(pre.backgroundColor, "transparent", "the block paints its own colour on top");
  });
}

test("normalizing the background leaves the rest of the theme alone", () => {
  assert.equal(PRISM_LIGHT_THEME[PRE_SELECTOR].color, "#393A34");
  assert.equal(PRISM_DARK_THEME[PRE_SELECTOR].color, "#d4d4d4");
  assert.equal(PRISM_LIGHT_THEME[PRE_SELECTOR].padding, "1em");
  assert.equal(PRISM_DARK_THEME[PRE_SELECTOR].padding, "1em");
  assert.equal(PRISM_LIGHT_THEME[PRE_SELECTOR].border, "1px solid #dddddd");
  assert.notEqual(PRISM_LIGHT_THEME[CODE_SELECTOR].color, PRISM_DARK_THEME[CODE_SELECTOR].color);
});
