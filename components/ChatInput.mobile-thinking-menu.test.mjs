import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

test("anchors the consolidated controls popover above the bar and inside the viewport", () => {
  // Same geometry as the reasoning dropdown next to it: opens upward off the
  // trigger, never wider than the viewport, and clamped in height so a long
  // tool list scrolls instead of leaving the screen.
  assert.match(
    source,
    /controlsMenuOpen && \([\s\S]*?bottom: "calc\(100% \+ 6px\)"[\s\S]*?right: 0,[\s\S]*?width: "min\(276px, calc\(100vw - 24px\)\)"[\s\S]*?maxHeight: "min\(440px, calc\(100vh - 96px\)\)"[\s\S]*?overflowY: "auto"/,
  );
});

test("separates the controls popover into presets, extension tools and actions", () => {
  assert.match(source, /role="group" aria-label=\{t\("chat\.controlsTools"\)\}/);
  assert.match(source, /role="group" aria-label=\{t\("chat\.controlsExtensionTools"\)\} style=\{controlSectionDividerStyle\(\)\}/);
  // Presets are exclusive radio rows; tools are on/off rows with a switch.
  assert.match(source, /role="menuitemradio"[\s\S]*?style=\{controlRowStyle\(isActive\)\}/);
  assert.match(source, /role="menuitemcheckbox"[\s\S]*?style=\{controlToggleRowStyle\(tool\.active\)\}[\s\S]*?<ControlSwitch on=\{tool\.active\} \/>/);
});
