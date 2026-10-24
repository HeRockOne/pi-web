import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  PRESET_DEFAULT,
  PRESET_FULL,
  PRESET_NONE,
  PRESET_READ_ONLY,
  getPresetFromTools,
  getSystemToolToggles,
  getToolNamesForPreset,
  mergeToolSelection,
} = await jiti.import("./tool-presets.ts");

const BUILTIN_NAMES = ["bash", "powershell", "read", "edit", "write", "grep", "find", "ls"];

function toolEntries(activeNames, customNames = []) {
  const active = new Set(activeNames);
  return [...BUILTIN_NAMES, ...customNames].map((name) => ({
    name,
    description: name,
    active: active.has(name),
  }));
}

test("maps every tool preset to its built-in tools", () => {
  assert.deepEqual(getToolNamesForPreset("none"), PRESET_NONE);
  assert.deepEqual(getToolNamesForPreset("read-only"), PRESET_READ_ONLY);
  assert.deepEqual(getToolNamesForPreset("default"), PRESET_DEFAULT);
  assert.deepEqual(getToolNamesForPreset("full"), PRESET_FULL);
  assert.deepEqual(PRESET_READ_ONLY, ["read", "grep", "find", "ls"]);
});

test("recognizes presets while ignoring active custom tools", () => {
  const customNames = ["web_search", "delegate"];

  assert.equal(getPresetFromTools(toolEntries([], customNames)), "none");
  assert.equal(
    getPresetFromTools(toolEntries([...PRESET_READ_ONLY, ...customNames], customNames)),
    "read-only",
  );
  assert.equal(
    getPresetFromTools(toolEntries([...PRESET_DEFAULT, ...customNames], customNames)),
    "default",
  );
  assert.equal(
    getPresetFromTools(toolEntries([...PRESET_FULL, ...customNames], customNames)),
    "full",
  );
});

test("returns fresh tool arrays that callers can safely modify", () => {
  const names = getToolNamesForPreset("read-only");
  names.push("custom");
  assert.deepEqual(getToolNamesForPreset("read-only"), PRESET_READ_ONLY);
});

test("recognizes PowerShell as the shell in standard presets", () => {
  assert.equal(
    getPresetFromTools(toolEntries(["read", "powershell", "edit", "write"])),
    "default",
  );
  assert.equal(
    getPresetFromTools(toolEntries(["powershell", "read", "edit", "write", "grep", "find", "ls"])),
    "full",
  );
});

test('system tool toggles: pick codemode/tool_search entries in registration order', () => {
  const tools = [
    { name: 'read', description: '', active: true },
    { name: 'tool_search', description: '', active: false },
    { name: 'mcp__srv__get', description: '', active: false },
    { name: 'codemode', description: '', active: true },
  ];
  assert.deepEqual(
    getSystemToolToggles(tools).map((tool) => tool.name),
    ['tool_search', 'codemode'],
  );
});

test('mergeToolSelection unions preset tools with enabled toggles and dedupes', () => {
  assert.deepEqual(
    mergeToolSelection(['read', 'bash'], [
      { name: 'codemode', description: '', active: true },
      { name: 'tool_search', description: '', active: false },
    ]),
    ['read', 'bash', 'codemode'],
  );
  assert.deepEqual(
    mergeToolSelection([], [
      { name: 'codemode', description: '', active: false },
      { name: 'tool_search', description: '', active: true },
    ]),
    ['tool_search'],
  );
});
