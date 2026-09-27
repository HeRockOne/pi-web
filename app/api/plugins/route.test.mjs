import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-web-plugin-route-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(join(agentDir, "extensions"), { recursive: true });
await mkdir(cwd);
await writeFile(join(agentDir, "extensions", "rtk.ts"), "export default () => {};\n");

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
const { GET, POST } = await jiti.import("./route.ts");
allowFileRoot(cwd);

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});

test("lists auto-discovered top-level extensions", async () => {
  const response = await GET(new Request(`http://localhost/api/plugins?cwd=${encodeURIComponent(cwd)}`));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.packages, []);
  assert.deepEqual(body.standaloneExtensions, [{
    kind: "extension",
    name: "rtk",
    path: join(agentDir, "extensions", "rtk.ts"),
    relativePath: "extensions/rtk.ts",
    scope: "global",
    enabled: true,
  }]);
  assert.equal(body.totals.extensions, 1);
});

test("disable-all and enable-all toggle every configured global package", async () => {
  const settingsPath = join(agentDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({
    packages: [
      "npm:active-plugin",
      { source: "npm:off-plugin", extensions: [], skills: [], prompts: [], themes: [] },
    ],
  }), "utf8");

  const post = (action) => POST(new Request("http://localhost/api/plugins", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ action, cwd }),
  }));

  const disabled = await post("disable-all");
  assert.equal(disabled.status, 200);
  const disabledBody = await disabled.json();
  assert.deepEqual(
    disabledBody.packages.map((pkg) => [pkg.source, pkg.disabled]),
    [["npm:active-plugin", true], ["npm:off-plugin", true]],
  );
  let stored = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(stored.packages, [
    { source: "npm:active-plugin", extensions: [], skills: [], prompts: [], themes: [] },
    { source: "npm:off-plugin", extensions: [], skills: [], prompts: [], themes: [] },
  ]);

  const enabled = await post("enable-all");
  assert.equal(enabled.status, 200);
  const enabledBody = await enabled.json();
  assert.deepEqual(
    enabledBody.packages.map((pkg) => [pkg.source, pkg.disabled]),
    [["npm:active-plugin", false], ["npm:off-plugin", false]],
  );
  stored = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(stored.packages, ["npm:active-plugin", "npm:off-plugin"]);
});
