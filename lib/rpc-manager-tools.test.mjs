import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { resolveActiveToolNames } = await jiti.import("./rpc-manager.ts");

const TOOLS = [
  { name: "read" },
  { name: "bash" },
  { name: "edit" },
  { name: "write" },
  { name: "codemode", exposure: "deferred" },
  { name: "tool_search", exposure: "deferred" },
  { name: "mcp__srv__get", exposure: "direct" },
  { name: "ask", exposure: "direct" },
  { name: "secret", exposure: "hidden" },
];

const sessionWith = (defaultTools) => ({
  getAllTools: () => TOOLS,
  settingsManager: { getDefaultTools: () => defaultTools },
});

test("an empty request keeps the session tool-free, whatever was active", () => {
  assert.deepEqual(resolveActiveToolNames(sessionWith(), [], ["codemode", "read"]), []);
});

test("coding tools pass through the shell resolution untouched by default", () => {
  assert.deepEqual(
    resolveActiveToolNames(sessionWith(), ["read", "bash", "grep", "find"], []),
    ["read", "bash", "grep", "find"],
  );
});

test("explicitly requested extension tools activate even when inactive", () => {
  assert.deepEqual(
    resolveActiveToolNames(sessionWith(), ["read", "codemode", "mcp__srv__get", "secret", "gone"], []),
    ["read", "codemode", "mcp__srv__get"],
  );
});

test("turning a toggle off drops it even though the carry still holds it", () => {
  assert.deepEqual(resolveActiveToolNames(sessionWith(), ["read"], []), ["read"]);
  // The dropdown switches ride explicit requests only: a carry that still names
  // codemode (it is active) must not revive one the user just turned off.
  assert.deepEqual(resolveActiveToolNames(sessionWith(), ["read"], ["codemode"]), ["read"]);
});

test("extension tools stay active only while registered and not hidden", () => {
  const session = sessionWith();
  // The toggles are excluded from the carry; other extension tools are not.
  assert.deepEqual(
    resolveActiveToolNames(session, ["read"], ["codemode", "tool_search", "mcp__srv__get", "ask", "secret", "gone"]),
    ["read", "mcp__srv__get", "ask"],
  );
});

test("carried tools are deduplicated against the selection", () => {
  assert.deepEqual(
    resolveActiveToolNames(sessionWith(), ["read", "bash"], ["bash", "ask"]),
    ["read", "bash", "ask"],
  );
});

test("defaultTools pick the shell the session runs", () => {
  assert.deepEqual(
    resolveActiveToolNames(sessionWith(["bash"]), ["powershell"], []),
    ["bash"],
  );
});
