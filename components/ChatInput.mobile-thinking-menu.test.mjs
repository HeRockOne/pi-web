import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

test("anchors the consolidated controls popover above the bar and inside the viewport", () => {
  assert.match(
    source,
    /controlsMenuOpen && \([\s\S]*?bottom: "calc\(100% \+ 8px\)"[\s\S]*?right: 0,[\s\S]*?width: "min\(320px, calc\(100vw - 32px\)\)"/,
  );
});
