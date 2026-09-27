import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-web-skills-route-"));
const outsideDir = await mkdtemp(join(tmpdir(), "pi-web-skills-outside-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const skillsDir = join(cwd, "skills");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(join(agentDir, "skills"), { recursive: true });
await mkdir(skillsDir, { recursive: true });

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
const { PATCH } = await jiti.import("./route.ts");
allowFileRoot(root);

async function writeSkill(name, dir = skillsDir) {
  const filePath = join(dir, `${name}.md`);
  await writeFile(filePath, `---\nname: ${name}\n---\nBody of ${name}.\n`, "utf8");
  return filePath;
}

const patch = (body) => PATCH(new Request("http://localhost/api/skills", {
  method: "PATCH",
  headers: { host: "localhost", "content-type": "application/json" },
  body: JSON.stringify(body),
}));

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

test("batch disable then enable multiple skills via filePaths", async () => {
  const alpha = await writeSkill("alpha");
  const beta = await writeSkill("beta");

  const disabled = await patch({ filePaths: [alpha, beta], disableModelInvocation: true });
  assert.equal(disabled.status, 200);
  const disabledBody = await disabled.json();
  assert.equal(disabledBody.success, true);
  assert.equal(disabledBody.updated, 2);
  assert.match(await readFile(alpha, "utf8"), /name: alpha/);
  assert.match(await readFile(alpha, "utf8"), /disable-model-invocation: true/);
  assert.match(await readFile(beta, "utf8"), /name: beta/);
  assert.match(await readFile(beta, "utf8"), /disable-model-invocation: true/);

  const enabled = await patch({ filePaths: [alpha, beta], disableModelInvocation: false });
  assert.equal(enabled.status, 200);
  // Enabling removes the key line entirely — absence means enabled.
  assert.doesNotMatch(await readFile(alpha, "utf8"), /disable-model-invocation/);
  assert.match(await readFile(alpha, "utf8"), /name: alpha/);
  assert.doesNotMatch(await readFile(beta, "utf8"), /disable-model-invocation/);
  assert.match(await readFile(beta, "utf8"), /name: beta/);
});

test("batch toggle is all-or-nothing: one missing path aborts every write", async () => {
  const gamma = await writeSkill("gamma");
  const before = await readFile(gamma, "utf8");

  const response = await patch({
    filePaths: [gamma, join(skillsDir, "missing.md")],
    disableModelInvocation: true,
  });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.match(body.error, /missing\.md/);
  assert.equal(await readFile(gamma, "utf8"), before);
});

test("batch toggle rejects paths outside the allowed roots", async () => {
  const gamma = await readFile(join(skillsDir, "gamma.md"), "utf8");
  const evil = await writeSkill("evil", outsideDir);

  const response = await patch({
    filePaths: [join(skillsDir, "gamma.md"), evil],
    disableModelInvocation: true,
  });
  assert.equal(response.status, 403);
  assert.equal(await readFile(join(skillsDir, "gamma.md"), "utf8"), gamma);
});

test("batch toggle rejects an empty path list", async () => {
  const response = await patch({ filePaths: [], disableModelInvocation: true });
  assert.equal(response.status, 400);
});

test("single-file toggle via filePath keeps working", async () => {
  const delta = await writeSkill("delta");
  const response = await patch({ filePath: delta, disableModelInvocation: true });
  assert.equal(response.status, 200);
  const content = await readFile(delta, "utf8");
  assert.match(content, /disable-model-invocation: true/);
});
