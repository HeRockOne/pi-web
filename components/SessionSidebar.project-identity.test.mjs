import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("project folder rows select the project root as the active cwd", () => {
  assert.match(source, /const selectProjectRoot = useCallback/);
  assert.match(source, /onClick=\{\(\) => selectProjectRoot\(row\.project\.key\)\}/);
  assert.match(source, /if \(project\) setSelectedCwd\(project\.root\)/);
});

test("clicking a session moves the effective cwd to that session's worktree", () => {
  assert.match(source, /if \(s\.cwd\) setSelectedCwd\(s\.cwd\)/);
});
