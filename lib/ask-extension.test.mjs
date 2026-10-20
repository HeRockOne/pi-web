import assert from "node:assert/strict";
import test from "node:test";

/**
 * The extension module imports `@earendil-works/pi-ai` / `-pi-coding-agent` for
 * types only (`import type` is erased, but `defineTool`/`Type` are real values).
 * Node's type stripping cannot resolve those peers here, so the module is loaded
 * through a source transform that swaps them for tiny stand-ins with identical
 * behaviour for the parts this code touches.
 */
const PEER_STUBS = `
const Type = {
  Object: (properties) => ({ kind: "object", properties }),
  Array: (items) => ({ kind: "array", items }),
  String: (options) => ({ kind: "string", options }),
  Boolean: (options) => ({ kind: "boolean", options }),
  Optional: (schema) => ({ ...schema, optional: true }),
};
const defineTool = (tool) => tool;
`;

async function loadSubject() {
  const { readFile, writeFile, unlink } = await import("node:fs/promises");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const path = fileURLToPath(new URL("./ask-extension.ts", import.meta.url));
  const original = await readFile(path, "utf8");
  // Peers are not installed here; only `defineTool`/`Type` are used at runtime.
  const withoutPeers = original
    .replace(/^import\s*[\s\S]*?from\s*"@earendil-works\/[^"]+";\s*$/gm, "")
    // Node's resolver needs the real file extension.
    .replace(/"(\.\/ask-types)"/g, '"$1.ts"');
  // Written next to the source so its relative `./ask-types` import still resolves;
  // node strips the types because the extension is .ts.
  const tempPath = fileURLToPath(new URL("./.ask-extension.harness.ts", import.meta.url));
  await writeFile(tempPath, `${PEER_STUBS}
${withoutPeers}`, "utf8");
  try {
    return await import(pathToFileURL(tempPath).href);
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

function makeCtx(hasUI = true) {
  return { hasUI, mode: "rpc" };
}

/** Registers the inline extension and returns the tool it published. */
function registerTool(extension, runtime) {
  const tools = new Map();
  extension.factory({ registerTool: (tool) => tools.set(tool.name, tool) });
  void runtime;
  return tools.get("ask");
}

test("registers an ask tool with a single questions array parameter", async () => {
  const subject = await loadSubject();
  const answers = [];
  const tool = registerTool(subject.createAskExtension({ ask: async () => answers }), null);

  assert.equal(tool.name, "ask");
  assert.equal(tool.executionMode, "sequential");
  assert.match(tool.description, /ask the user/i);
  assert.equal(tool.parameters.properties.questions.kind, "array");
  assert.deepEqual(
    Object.keys(tool.parameters.properties.questions.items.properties),
    ["id", "prompt", "multiSelect", "allowOther", "context", "options"],
  );
});

test("execute forwards the whole question list in ONE runtime call", async () => {
  const subject = await loadSubject();
  const calls = [];
  const tool = registerTool(subject.createAskExtension({
    ask: async (questions) => {
      calls.push(questions);
      return [
        { id: "a", prompt: "First?", multiSelect: false, labels: ["Yes"], values: ["y"], cancelled: false },
        { id: "b", prompt: "Second?", multiSelect: false, labels: ["No"], values: ["n"], cancelled: false },
      ];
    },
  }), null);

  const result = await tool.execute("tc", {
    questions: [
      { id: "a", prompt: "First?", options: [{ value: "y", label: "Yes" }] },
      { id: "b", prompt: "Second?", options: [{ value: "n", label: "No" }] },
    ],
  }, undefined, undefined, makeCtx());

  assert.equal(calls.length, 1, "paging is only possible when every question arrives at once");
  assert.equal(calls[0].length, 2);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /User answered:/);
  assert.match(result.content[0].text, /- a: Yes/);
  assert.equal(result.details.cancelled, false);
});

test("execute reports the user's dismiss as a cancelled result", async () => {
  const subject = await loadSubject();
  const tool = registerTool(subject.createAskExtension({ ask: async () => undefined }), null);

  const result = await tool.execute("tc", {
    questions: [{ id: "a", prompt: "First?", options: [{ value: "y", label: "Yes" }] }],
  }, undefined, undefined, makeCtx());

  assert.equal(result.content[0].text, "User cancelled the question.");
  assert.equal(result.details.cancelled, true);
});

test("execute refuses to run without an interactive UI", async () => {
  const subject = await loadSubject();
  let called = false;
  const tool = registerTool(subject.createAskExtension({
    ask: async () => {
      called = true;
      return [];
    },
  }), null);

  const result = await tool.execute("tc", {
    questions: [{ id: "a", prompt: "First?", options: [{ value: "y", label: "Yes" }] }],
  }, undefined, undefined, makeCtx(false));

  assert.equal(result.isError, true);
  assert.equal(called, false);
});

test("execute rejects a call whose questions all fail normalization", async () => {
  const subject = await loadSubject();
  const tool = registerTool(subject.createAskExtension({ ask: async () => [] }), null);

  const result = await tool.execute("tc", { questions: [{ id: "empty" }] }, undefined, undefined, makeCtx());

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no questions/i);
});

test("preferPiWebAskExtension drops a standalone pi-ask tool only when the host tool exists", async () => {
  const subject = await loadSubject();
  const host = {
    path: "<inline:pi-web-ask>",
    sourceInfo: { source: "inline:pi-web-ask" },
    tools: new Map([["ask", {}]]),
  };
  const legacy = {
    path: "C:/Users/x/.pi/agent/npm/node_modules/@wwyxin/pi-ask/index.ts",
    sourceInfo: { source: "npm:@wwyxin/pi-ask" },
    tools: new Map([["ask", {}]]),
  };
  const unrelated = {
    path: "C:/Users/x/.pi/agent/npm/node_modules/other/index.ts",
    sourceInfo: { source: "npm:other" },
    tools: new Map([["ask", {}]]),
  };
  const base = { extensions: [host, legacy, unrelated], errors: [{ path: legacy.path, message: "boom" }] };

  const result = subject.preferPiWebAskExtension(base);
  assert.deepEqual(result.extensions.map((extension) => extension.path), [host.path, unrelated.path]);
  assert.deepEqual(result.errors, []);

  const withoutHost = subject.preferPiWebAskExtension({ extensions: [legacy], errors: [] });
  assert.deepEqual(withoutHost.extensions.map((extension) => extension.path), [legacy.path]);
});

test("preferPiWebAskExtension leaves a pi-ask copy that registered no ask tool alone", async () => {
  const subject = await loadSubject();
  const host = {
    path: "<inline:pi-web-ask>",
    sourceInfo: { source: "inline:pi-web-ask" },
    tools: new Map([["ask", {}]]),
  };
  const legacyOtherTool = {
    path: "C:/Users/x/.pi/agent/npm/node_modules/@wwyxin/pi-ask/index.ts",
    sourceInfo: { source: "npm:@wwyxin/pi-ask" },
    tools: new Map([["somethingElse", {}]]),
  };

  const result = subject.preferPiWebAskExtension({ extensions: [host, legacyOtherTool], errors: [] });
  assert.equal(result.extensions.length, 2);
});
