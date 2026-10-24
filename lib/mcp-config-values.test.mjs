import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  describeConfigField,
  findWebPasswordField,
  getConfigValueEnvVarNames,
  isCommandConfigValue,
  resolvedConfigValues,
} = await jiti.import("./mcp-config-values.ts");
const { resolveConfigValue } = await jiti.import("./mcp-config-resolve.ts");

const withEnv = (name, value, run) => {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return Promise.resolve(run()).finally(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
};

test("a stdio entry resolves its env values, an HTTP entry its headers and secret", () => {
  assert.deepEqual(resolvedConfigValues({ command: "srv", env: { A: "1", B: "2", N: 3 } }), [
    { kind: "env", name: "A", value: "1" },
    { kind: "env", name: "B", value: "2" },
  ]);
  assert.deepEqual(resolvedConfigValues({
    url: "https://example.test/mcp",
    headers: { Authorization: "Bearer x", Skip: 1 },
    oauth: { clientSecret: "s3cret" },
  }), [
    { kind: "header", name: "Authorization", value: "Bearer x" },
    { kind: "oauth-client-secret", value: "s3cret" },
  ]);
  assert.deepEqual(resolvedConfigValues("not an object"), []);
});

test("describeConfigField names the field the way messages read", () => {
  assert.equal(describeConfigField({ kind: "env", name: "TOKEN" }), 'env "TOKEN"');
  assert.equal(describeConfigField({ kind: "header", name: "Authorization" }), 'header "Authorization"');
  assert.equal(describeConfigField({ kind: "oauth-client-secret" }), "oauth.clientSecret");
});

test("templates reference valid variable names and escape a literal dollar", () => {
  assert.deepEqual(getConfigValueEnvVarNames("${A}/$B"), ["A", "B"]);
  assert.deepEqual(getConfigValueEnvVarNames("${A}${A}"), ["A"]);
  assert.deepEqual(getConfigValueEnvVarNames("$$home is $!home"), []);
  assert.deepEqual(getConfigValueEnvVarNames("${NOT A NAME}"), []);
  assert.deepEqual(getConfigValueEnvVarNames("plain value"), []);
  assert.deepEqual(getConfigValueEnvVarNames("!echo $PI_WEB_PASSWORD"), []);
});

test("isCommandConfigValue is the ! prefix", () => {
  assert.equal(isCommandConfigValue("!echo hi"), true);
  assert.equal(isCommandConfigValue("echo hi"), false);
});

test("a template resolves against this process and a missing variable resolves to undefined", async () => {
  await withEnv("PI_CONFIG_VALUE_TEST", "v1", async () => {
    assert.equal(resolveConfigValue("prefix-${PI_CONFIG_VALUE_TEST}-$PI_CONFIG_VALUE_TEST"), "prefix-v1-v1");
  });
  await withEnv("PI_CONFIG_VALUE_TEST", undefined, async () => {
    assert.equal(resolveConfigValue("prefix-${PI_CONFIG_VALUE_TEST}"), undefined);
  });
});

test("a !command uses its trimmed stdout", () => {
  assert.equal(resolveConfigValue("!echo PI_CONFIG_VALUE_TEST"), "PI_CONFIG_VALUE_TEST");
});

test("findWebPasswordField catches the password through every resolved field", () => {
  assert.deepEqual(
    findWebPasswordField({ command: "srv", env: { TOKEN: "$PI_WEB_PASSWORD" } }),
    { kind: "env", name: "TOKEN" },
  );
  assert.deepEqual(
    findWebPasswordField({ url: "https://x", headers: { A: "1", B: "!grep pi_web_password /secrets" } }),
    { kind: "header", name: "B" },
  );
  assert.deepEqual(
    findWebPasswordField({ url: "https://x", oauth: { clientSecret: "${PI_WEB_PASSWORD}" } }),
    { kind: "oauth-client-secret" },
  );
  assert.deepEqual(
    findWebPasswordField({ command: "srv", env: { TOKEN: "!echo read $PI_WEB_PASSWORD now" } }),
    { kind: "env", name: "TOKEN" },
  );
  assert.equal(findWebPasswordField({ command: "srv", env: { TOKEN: "$OTHER" } }), undefined);
  assert.equal(findWebPasswordField({ url: "https://x" }), undefined);
});
