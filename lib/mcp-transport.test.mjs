import { homedir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createPiWebMcpTransportFactory } = await jiti.import("./mcp-transport.ts");

const entry = (config) => ({ name: "srv", config });

test("a server that references PI_WEB_PASSWORD is refused", () => {
  const factory = createPiWebMcpTransportFactory({ baseEnvironment: {}, platform: "linux" });
  assert.throws(
    () => factory(entry({ command: "srv", env: { TOKEN: "$PI_WEB_PASSWORD" } }), "/repo"),
    /PI_WEB_PASSWORD/,
  );
  assert.throws(
    () => factory(entry({ url: "https://x", headers: { A: "!cat pi_web_password" } }), "/repo"),
    /PI_WEB_PASSWORD/,
  );
});

test("a stdio server starts from the sanitized environment with its own values on top", () => {
  const factory = createPiWebMcpTransportFactory({
    baseEnvironment: { PATH: "/bin", PORT: "3080", NODE_ENV: "development", PI_WEB_PASSWORD: "secret" },
    platform: "linux",
  });
  const transport = factory(entry({ command: "npx", args: ["-y", "srv"], env: { FOO: "own" } }), "/repo");
  assert.ok(transport instanceof StdioTransport);
  assert.equal(transport.options.command, "npx");
  assert.deepEqual(transport.options.args, ["-y", "srv"]);
  assert.equal(transport.options.inheritEnv, false);
  assert.equal(transport.options.stderr, "pipe");
  assert.deepEqual(transport.options.env, { PATH: "/bin", FOO: "own" });
});

test("a server env value is resolved in this process, or the server is refused", () => {
  const factory = createPiWebMcpTransportFactory({ baseEnvironment: {}, platform: "linux" });
  process.env.PI_ENV_TEST = "v1";
  try {
    const transport = factory(entry({ command: "srv", env: { FOO: "$PI_ENV_TEST" } }), "/repo");
    assert.equal(transport.options.env.FOO, "v1");
  } finally {
    delete process.env.PI_ENV_TEST;
  }
  assert.throws(
    () => factory(entry({ command: "srv", env: { FOO: "$PI_ENV_TEST_MISSING" } }), "/repo"),
    /missing environment variable/,
  );
});

test("on Windows a server variable replaces any casing of itself", () => {
  const factory = createPiWebMcpTransportFactory({ baseEnvironment: { Path: "/bin" }, platform: "win32" });
  const transport = factory(entry({ command: "srv", env: { PATH: "/own" } }), "/repo");
  assert.deepEqual(transport.options.env, { PATH: "/own" });
});

test("a leading tilde expands to the home directory", () => {
  const factory = createPiWebMcpTransportFactory({ baseEnvironment: {}, platform: "linux" });
  const transport = factory(entry({ command: "~", args: ["~/bin/srv"] }), "/repo");
  assert.equal(transport.options.command, homedir());
  assert.deepEqual(transport.options.args, [join(homedir(), "bin", "srv")]);
});

test("an HTTP server resolves its headers and keeps the auth provider", () => {
  const factory = createPiWebMcpTransportFactory({ baseEnvironment: {}, platform: "linux" });
  const authProvider = { tokens: () => undefined };
  process.env.PI_HTTP_TEST = "token";
  try {
    const transport = factory(
      entry({ url: "https://example.test/mcp", headers: { Authorization: "Bearer $PI_HTTP_TEST" } }),
      "/repo",
      authProvider,
    );
    assert.ok(transport instanceof StreamableHttpTransport);
    assert.equal(transport.options.url, "https://example.test/mcp");
    assert.deepEqual(transport.options.headers, { Authorization: "Bearer token" });
    assert.equal(transport.options.authProvider, authProvider);
  } finally {
    delete process.env.PI_HTTP_TEST;
  }
});

test("an HTTP server without headers or an auth provider omits both", () => {
  const factory = createPiWebMcpTransportFactory({ baseEnvironment: {}, platform: "linux" });
  const transport = factory(entry({ url: "https://example.test/mcp" }), "/repo");
  assert.ok(transport instanceof StreamableHttpTransport);
  assert.equal(transport.options.headers, undefined);
  assert.equal(transport.options.authProvider, undefined);
});
