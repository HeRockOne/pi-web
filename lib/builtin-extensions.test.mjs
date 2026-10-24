import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const mod = await jiti.import("./builtin-extensions.ts");
const {
  createBuiltinExtensionFactories,
  isMcpDisabledByEnvironment,
  isMcpDisabledByOperator,
  isMcpAuthRequiredError,
  runCodemodeSelfTest,
  peekCodemodeSandbox,
  readBuiltinExtensionSwitches,
  untrustedProjectServerEntries,
  projectEntryConfigKey,
  wrapTransportFactoryForSession,
  loadGlobalMcpConfig,
} = mod;
const { clearMcpStatuses, readMcpStatus } = await jiti.import("./mcp-status.ts");
const { mcpConfigKey, mcpEntryConfigKey } = await jiti.import("./mcp-config-key.ts");
const { loadPiSdkInternals } = await jiti.import("./pi-sdk-internals.ts");
const { McpAuthRequiredError } = await import("@earendil-works/pi-mcp");
const { McpOAuthAuthorizationRequiredError } = await import("@earendil-works/pi-mcp/oauth");

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
  const extensions = createBuiltinExtensionFactories({ agentDir: "/agent", cwd: "/work" });
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
    const extensions = createBuiltinExtensionFactories({ agentDir: "/agent", cwd: "/work" });
    assert.deepEqual(extensions.map((extension) => extension.name), ["codemode", "tool-search"]);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DISABLE_MCP;
    else process.env.PI_WEB_DISABLE_MCP = previous;
  }
});

const fakeCodemodeTool = (text) => ({
  execute: async () => ({ content: [{ type: "text", text }] }),
});

test("isMcpDisabledByOperator treats any non-empty non-false value as off", () => {
  const disabled = (value) => isMcpDisabledByOperator({ PI_WEB_DISABLE_MCP: value });
  assert.equal(disabled(undefined), false);
  assert.equal(disabled(""), false);
  assert.equal(disabled("0"), false);
  assert.equal(disabled("false"), false);
  assert.equal(disabled(" FALSE "), false);
  assert.equal(disabled("1"), true);
  assert.equal(disabled("yes"), true);
});

test("the sandbox self-test passes when the codemode tool answers correctly", async () => {
  assert.deepEqual(await runCodemodeSelfTest({ createDefinition: async () => fakeCodemodeTool("42") }), {
    available: true,
  });
});

test("a wrong or failing self-test marks the sandbox unavailable", async () => {
  assert.equal((await runCodemodeSelfTest({ createDefinition: async () => fakeCodemodeTool("41") })).available, false);
  const failed = await runCodemodeSelfTest({
    createDefinition: async () => {
      throw new Error("no sandbox here");
    },
  });
  assert.equal(failed.available, false);
  assert.match(failed.reason, /no sandbox here/);
});

test("a self-test that never answers times out", async () => {
  const status = await runCodemodeSelfTest({ timeoutMs: 50, createDefinition: () => new Promise(() => {}) });
  assert.equal(status.available, false);
  assert.match(status.reason, /did not answer/);
});

test("peekCodemodeSandbox reports a settled self-test and skips an unsettled one", async () => {
  const store = globalThis;
  const key = Symbol.for("pi-web.codemodeSandbox");
  const previous = store[key];
  try {
    delete store[key];
    assert.deepEqual(await peekCodemodeSandbox(), { checked: false });
    store[key] = Promise.resolve({ available: true });
    assert.deepEqual(await peekCodemodeSandbox(), { checked: true, available: true });
    store[key] = new Promise(() => {});
    assert.deepEqual(await peekCodemodeSandbox(), { checked: false });
  } finally {
    if (previous === undefined) delete store[key];
    else store[key] = previous;
  }
});

test("auth-required errors are pinned to the 1.4.0 class names the matcher uses", () => {
  const required = new McpAuthRequiredError(new Response(), "unauthorized");
  const oauth = new McpOAuthAuthorizationRequiredError();
  assert.equal(required.name, "McpAuthRequiredError");
  assert.equal(oauth.name, "McpOAuthAuthorizationRequiredError");
  assert.equal(isMcpAuthRequiredError(required), true);
  assert.equal(isMcpAuthRequiredError(oauth), true);
  // The name fallback keeps a duplicate module instance or a subclass working.
  const twin = new Error("401");
  twin.name = "McpAuthRequiredError";
  assert.equal(isMcpAuthRequiredError(twin), true);
  assert.equal(isMcpAuthRequiredError(new Error("boom")), false);
  assert.equal(isMcpAuthRequiredError("nope"), false);
});

test("untrustedProjectServerEntries reads the project file defensively", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-untrusted-"));
  try {
    assert.deepEqual(untrustedProjectServerEntries(root), []);
    mkdirSync(join(root, ".pi"));
    writeFileSync(
      join(root, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { a: { command: "srv" }, b: { enabled: false } } }),
    );
    assert.deepEqual(untrustedProjectServerEntries(root), [
      ["a", { command: "srv" }],
      ["b", { enabled: false }],
    ]);
    writeFileSync(join(root, ".pi", "mcp.json"), "{oops");
    assert.deepEqual(untrustedProjectServerEntries(root), []);
    writeFileSync(join(root, ".pi", "mcp.json"), JSON.stringify({ mcpServers: [1] }));
    assert.deepEqual(untrustedProjectServerEntries(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("projectEntryConfigKey keys a valid override by its merged entry and a refusal by the raw value", async () => {
  const internals = await loadPiSdkInternals();
  assert.ok(internals.ok);
  const globalEntry = { name: "shared", config: { command: "srv", args: ["-x"] }, source: "/agent/mcp.json", scope: "global" };
  const merged = { command: "srv", args: ["-x"], enabled: false };
  const overrideKey = projectEntryConfigKey(internals, "shared", { enabled: false }, globalEntry);
  const validated = internals.validateMcpServerConfig("shared", merged);
  assert.equal(overrideKey, mcpEntryConfigKey(merged, validated));
  // An override with nothing to override is refused, so it keys as written.
  assert.equal(
    projectEntryConfigKey(internals, "shared", { enabled: false }, undefined),
    mcpEntryConfigKey({ enabled: false }, undefined),
  );
});

const fakeTransport = (overrides = {}) => ({
  start: async () => {},
  send: () => {},
  close: async () => {},
  onMessage: () => () => {},
  onError: () => () => {},
  onClose: () => () => {},
  ...overrides,
});

test("the session transport wrapper records connecting, connected and disconnected", async () => {
  clearMcpStatuses();
  const session = { cwd: "/work", sessionId: "s1" };
  const entry = { name: "local", config: { command: "srv" }, source: "/agent/mcp.json", scope: "global" };
  const configKey = mcpConfigKey(entry.config);
  const statusEntry = { scope: "global", sourcePath: "/agent/mcp.json", name: "local" };
  let created = 0;
  const factory = wrapTransportFactoryForSession(
    (seenEntry) => {
      created += 1;
      assert.equal(seenEntry, entry);
      return fakeTransport({ stderr: "stderr tail here" });
    },
    session,
  );

  const transport = factory(entry, "/work", undefined);
  assert.equal(created, 1);
  assert.equal(readMcpStatus(statusEntry, configKey)?.state, "connecting");
  await transport.start();
  assert.equal(readMcpStatus(statusEntry, configKey)?.state, "connected");
  let closed = false;
  transport.onClose(() => {
    closed = true;
  });
  await transport.close();
  assert.equal(closed, true);
  assert.equal(readMcpStatus(statusEntry, configKey)?.state, "disconnected");
});

test("a failing transport start reports failed with the error and the stderr tail", async () => {
  clearMcpStatuses();
  const entry = { name: "local", config: { command: "srv" }, source: "/agent/mcp.json", scope: "global" };
  const statusEntry = { scope: "global", sourcePath: "/agent/mcp.json", name: "local" };
  const factory = wrapTransportFactoryForSession(
    () =>
      fakeTransport({
        start: async () => {
          throw new Error("boom");
        },
        stderr: "stderr tail here",
      }),
    { cwd: "/work", sessionId: "s1" },
  );
  const transport = factory(entry, "/work", undefined);
  await assert.rejects(transport.start(), /boom/);
  const status = readMcpStatus(statusEntry, mcpConfigKey(entry.config));
  assert.equal(status.state, "failed");
  assert.match(status.error, /boom/);
  assert.equal(status.stderr, "stderr tail here");
});

test("a transport start refused for auth reports needs-auth", async () => {
  clearMcpStatuses();
  const entry = { name: "remote", config: { url: "https://example.com/mcp" }, source: "/agent/mcp.json", scope: "global" };
  const statusEntry = { scope: "global", sourcePath: "/agent/mcp.json", name: "remote" };
  const factory = wrapTransportFactoryForSession(
    () =>
      fakeTransport({
        start: async () => {
          throw new McpAuthRequiredError(new Response(), "auth");
        },
      }),
    { cwd: "/work", sessionId: "s1" },
  );
  const transport = factory(entry, "/work", undefined);
  await assert.rejects(transport.start());
  assert.equal(readMcpStatus(statusEntry, mcpConfigKey(entry.config))?.state, "needs-auth");
});

test("an error arriving mid-session reports failed through the wrapped listener", async () => {
  clearMcpStatuses();
  const entry = { name: "local", config: { command: "srv" }, source: "/agent/mcp.json", scope: "global" };
  const statusEntry = { scope: "global", sourcePath: "/agent/mcp.json", name: "local" };
  let registered = null;
  const factory = wrapTransportFactoryForSession(
    () => fakeTransport({ onError: (listener) => { registered = listener; return () => {}; } }),
    { cwd: "/work", sessionId: "s1" },
  );
  const transport = factory(entry, "/work", undefined);
  let seen;
  transport.onError((error) => {
    seen = error;
  });
  registered(new Error("mid-session"));
  assert.equal(seen.message, "mid-session");
  assert.equal(readMcpStatus(statusEntry, mcpConfigKey(entry.config))?.state, "failed");
});

test("a project-scope entry reports under the project file, not the global one", () => {
  clearMcpStatuses();
  const entry = { name: "own", config: { command: "srv" }, source: "/work/.pi/mcp.json", scope: "project" };
  const statusEntry = { scope: "project", sourcePath: "/work/.pi/mcp.json", name: "own" };
  const factory = wrapTransportFactoryForSession(() => fakeTransport(), { cwd: "/work", sessionId: "s1" });
  factory(entry, "/work", undefined);
  assert.equal(readMcpStatus(statusEntry, mcpConfigKey(entry.config))?.state, "connecting");
  assert.equal(
    readMcpStatus({ scope: "global", sourcePath: "/agent/mcp.json", name: "own" }, mcpConfigKey(entry.config)),
    undefined,
  );
});

test("the extensions settings switch built-ins off as the session's resource loader would", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-builtin-switches-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const globalPath = join(agentDir, "settings.json");
  const projectPath = join(cwd, ".pi", "settings.json");
  const on = { enabled: true };
  const read = (projectTrusted = true) => readBuiltinExtensionSwitches({ agentDir, cwd, projectTrusted });

  assert.deepEqual(await read(), { codemode: on, "tool-search": on, mcp: on });

  // Never installs: a configured package that is missing is not even looked up.
  await writeFile(globalPath, JSON.stringify({ extensions: ["-builtin:mcp"], packages: ["npm:pi-web-test-not-a-package"] }));
  assert.deepEqual(await read(), { codemode: on, "tool-search": on, mcp: { enabled: false, settingsPath: globalPath } });

  // A trusted project's entry overrides the global one; an untrusted project's is not read. Each
  // switch then also says what the global list alone makes of it, for a global setting to be weighed against.
  await writeFile(projectPath, JSON.stringify({ extensions: ["+builtin:mcp", "-builtin:codemode"] }));
  assert.deepEqual(await read(), {
    codemode: { enabled: false, settingsPath: projectPath, global: on },
    "tool-search": { ...on, global: on },
    mcp: { ...on, global: { enabled: false, settingsPath: globalPath } },
  });
  assert.deepEqual(await read(false), { codemode: on, "tool-search": on, mcp: { enabled: false, settingsPath: globalPath } });
  assert.deepEqual(
    await readBuiltinExtensionSwitches({ agentDir, projectTrusted: true }),
    { codemode: on, "tool-search": on, mcp: { enabled: false, settingsPath: globalPath } },
    "without a project only the global settings count",
  );

  // Patterns follow the SDK's rules, not a string comparison.
  await writeFile(globalPath, `\uFEFF${JSON.stringify({ extensions: ["!builtin:*", "+builtin:tool-search"] })}`);
  await rm(projectPath);
  const off = { enabled: false, settingsPath: globalPath };
  assert.deepEqual(await read(), { codemode: off, "tool-search": on, mcp: off });

  await writeFile(globalPath, "{ not json");
  assert.deepEqual(await read(), { codemode: on, "tool-search": on, mcp: on }, "an unparsable file counts as empty, as in the SDK");
});

test("a trusted project's settings that are not a regular file never stall the switches read", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-builtin-switches-fifo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const projectPath = join(cwd, ".pi", "settings.json");
  const read = () => readBuiltinExtensionSwitches({ agentDir, cwd, projectTrusted: true });

  // A directory, and a file past the cap, throw as an unreadable file does; the overview then keeps the built-ins on.
  await mkdir(projectPath);
  await assert.rejects(read(), /not a regular file/);
  await rm(projectPath, { recursive: true });
  await writeFile(projectPath, `{"extensions":[],"pad":"${"x".repeat(1024 * 1024)}"}`);
  await assert.rejects(read(), /larger than/);
  if (process.platform !== "win32") {
    // A plain readFileSync() would wait on a FIFO until something writes to it, holding the whole server.
    await rm(projectPath);
    execFileSync("mkfifo", [projectPath]);
    await assert.rejects(read(), /not a regular file/);
    // Untrusted, the project's file is never opened at all.
    assert.deepEqual(
      await readBuiltinExtensionSwitches({ agentDir, cwd, projectTrusted: false }),
      { codemode: { enabled: true }, "tool-search": { enabled: true }, mcp: { enabled: true } },
    );
  }
});
