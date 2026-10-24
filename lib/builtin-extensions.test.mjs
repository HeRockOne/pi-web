import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createBuiltinExtensionFactories, isMcpDisabledByEnvironment, loadGlobalMcpConfig } = await jiti.import("./builtin-extensions.ts");

const readFileOf = (content) => () => content;
const missing = () => {
  const error = new Error("ENOENT");
  error.code = "ENOENT";
  throw error;
};
const failing = () => {
  throw new Error("disk on fire");
};

test("a missing global mcp.json loads as an empty server list", () => {
  assert.deepEqual(loadGlobalMcpConfig("/agent", missing), { servers: [], errors: [] });
});

test("an unreadable or malformed mcp.json is reported instead of thrown", () => {
  assert.match(loadGlobalMcpConfig("/agent", failing).errors[0], /could not be read/);
  assert.match(loadGlobalMcpConfig("/agent", readFileOf("{oops")).errors[0], /could not be read/);
  assert.deepEqual(loadGlobalMcpConfig("/agent", readFileOf("[1]")), {
    servers: [],
    errors: ["mcp.json must hold a JSON object"],
  });
  assert.deepEqual(loadGlobalMcpConfig("/agent", readFileOf("null")), {
    servers: [],
    errors: ["mcp.json must hold a JSON object"],
  });
});

test("reads global servers with their scope and passes autoEnableCodemode through", () => {
  const config = JSON.stringify({
    mcpServers: {
      local: { command: "npx", args: ["-y", "srv"] },
      remote: { url: "https://example.test/mcp" },
    },
    autoEnableCodemode: false,
  });
  const loaded = loadGlobalMcpConfig("/agent", readFileOf(config));
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(
    loaded.servers.map((entry) => [entry.name, entry.scope]),
    [["local", "global"], ["remote", "global"]],
  );
  assert.equal(loaded.servers[0].config.command, "npx");
  assert.equal(loaded.servers[1].config.url, "https://example.test/mcp");
  assert.equal(loaded.autoEnableCodemode, false);
});

test("servers the SDK would reject are reported, one error each", () => {
  const loaded = loadGlobalMcpConfig("/agent", readFileOf(JSON.stringify({
    mcpServers: {
      broken: "not an object",
      empty: {},
      ok: { command: "srv" },
    },
  })));
  assert.deepEqual(
    loaded.errors,
    [
      'mcp.json server "broken" must hold a JSON object',
      'mcp.json server "empty" needs a "command" or a "url"',
    ],
  );
  assert.deepEqual(loaded.servers.map((entry) => entry.name), ["ok"]);
});

test("a non-object mcpServers section is one error", () => {
  const loaded = loadGlobalMcpConfig("/agent", readFileOf(JSON.stringify({ mcpServers: ["x"] })));
  assert.deepEqual(loaded.errors, ['mcp.json "mcpServers" must hold a JSON object']);
  assert.deepEqual(loaded.servers, []);
});

test("an absent autoEnableCodemode stays absent", () => {
  const loaded = loadGlobalMcpConfig("/agent", readFileOf(JSON.stringify({ mcpServers: {} })));
  assert.equal("autoEnableCodemode" in loaded, false);
});

test("PI_WEB_DISABLE_MCP follows the operator's setting", () => {
  const disabled = (value, platform) => isMcpDisabledByEnvironment({ PI_WEB_DISABLE_MCP: value }, platform);
  assert.equal(disabled("1"), true);
  assert.equal(disabled("true"), true);
  assert.equal(disabled("0"), false);
  assert.equal(disabled("false"), false);
  assert.equal(disabled(""), false);
  // Windows resolves names case-insensitively, so the value compares the same way.
  assert.equal(isMcpDisabledByEnvironment({ PI_WEB_DISABLE_MCP: "FALSE" }, "win32"), false);
  assert.equal(isMcpDisabledByEnvironment({ PI_WEB_DISABLE_MCP: "FALSE" }, "linux"), true);
});

test("the built-in extensions register under their CLI names and stay replaceable", () => {
  const extensions = createBuiltinExtensionFactories({ agentDir: "/agent" });
  assert.deepEqual(extensions.map((extension) => extension.name), ["codemode", "tool-search", "mcp"]);
  for (const extension of extensions) {
    assert.equal(extension.replaceable, true);
    assert.equal(extension.builtin, true);
    assert.equal(typeof extension.factory, "function");
  }
});

test("PI_WEB_DISABLE_MCP=1 keeps the MCP extension out of new sessions", () => {
  const previous = process.env.PI_WEB_DISABLE_MCP;
  process.env.PI_WEB_DISABLE_MCP = "1";
  try {
    const extensions = createBuiltinExtensionFactories({ agentDir: "/agent" });
    assert.deepEqual(extensions.map((extension) => extension.name), ["codemode", "tool-search"]);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DISABLE_MCP;
    else process.env.PI_WEB_DISABLE_MCP = previous;
  }
});
