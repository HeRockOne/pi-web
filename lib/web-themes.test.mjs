import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  activateWebTheme,
  deleteCustomTheme,
  getWebThemesPath,
  listWebThemes,
  readWebThemes,
  upsertCustomTheme,
} = await createJiti(import.meta.url).import("./web-themes.ts");

const LIGHT = {
  "--bg": "#fff8f0", "--bg-panel": "#ffffff", "--bg-hover": "#f6ede2",
  "--bg-selected": "#f0e2d2", "--border": "#e6d5c0", "--text": "#33251a",
  "--text-muted": "#7a6a58", "--text-dim": "#a3937f", "--accent": "#e07b39",
  "--accent-hover": "#c96a2c", "--user-bg": "#f7e8d8", "--assistant-bg": "#ffffff",
  "--tool-bg": "#faf3ea", "--bg-subtle": "#fdf6ec",
};

const DARK = {
  "--bg": "#1d140d", "--bg-panel": "#271a11", "--bg-hover": "#33231a",
  "--bg-selected": "#3d2a1b", "--border": "#4a3421", "--text": "#f3e8dc",
  "--text-muted": "#bda894", "--text-dim": "#8f7c67", "--accent": "#f08c4a",
  "--accent-hover": "#f79d5f", "--user-bg": "#33231a", "--assistant-bg": "#271a11",
  "--tool-bg": "#241710", "--bg-subtle": "#211610",
};

function newAgentDir(t, name) {
  // Unique mkdtemp root so the legacy sibling lookup
  // (join(agentDir, "..", "pi-web-theme")) cannot leak between tests.
  const root = mkdtempSync(join(tmpdir(), "pi-web-themes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, agentDir: join(root, name) };
}

test("read on a fresh agent dir returns defaults and creates the store file", (t) => {
  const { agentDir } = newAgentDir(t, "agent");
  const file = readWebThemes(agentDir);
  assert.equal(file.active, "pi-default");
  assert.deepEqual(file.custom, []);
  const onDisk = JSON.parse(readFileSync(getWebThemesPath(agentDir), "utf8"));
  assert.equal(onDisk.active, "pi-default");
});

test("activate accepts builtin ids and rejects unknown ones", (t) => {
  const { agentDir } = newAgentDir(t, "agent");
  const theme = activateWebTheme("warm-orange", agentDir);
  assert.equal(theme?.id, "warm-orange");
  assert.equal(readWebThemes(agentDir).active, "warm-orange");
  assert.equal(activateWebTheme("no-such-theme", agentDir), null);
  assert.equal(readWebThemes(agentDir).active, "warm-orange");
});

test("upsert saves a validated custom theme and activates it", (t) => {
  const { agentDir } = newAgentDir(t, "agent");
  const theme = upsertCustomTheme(
    { id: "sunset", name: "Sunset", light: LIGHT, dark: DARK },
    agentDir,
  );
  assert.equal(theme?.builtin, false);
  const listed = listWebThemes(agentDir);
  assert.equal(listed.active, "sunset");
  assert.ok(listed.themes.some((entry) => entry.id === "sunset"));

  assert.equal(upsertCustomTheme({ id: "pi-x", name: "x", light: LIGHT, dark: DARK }, agentDir), null);
  assert.equal(upsertCustomTheme({ id: "bad id", name: "x", light: LIGHT, dark: DARK }, agentDir), null);
  assert.equal(upsertCustomTheme(null, agentDir), null);
  assert.equal(listWebThemes(agentDir).themes.filter((entry) => entry.id === "sunset").length, 1);
});

test("delete removes a custom theme and falls back when it was active", (t) => {
  const { agentDir } = newAgentDir(t, "agent");
  upsertCustomTheme({ id: "sunset", name: "Sunset", light: LIGHT, dark: DARK }, agentDir);
  const result = deleteCustomTheme("sunset", agentDir);
  assert.deepEqual(result, { ok: true, wasActive: true });
  assert.equal(readWebThemes(agentDir).active, "pi-default");
  assert.deepEqual(deleteCustomTheme("sunset", agentDir), { ok: false, wasActive: false });
  assert.equal(deleteCustomTheme("pi-default", agentDir).ok, false);
});

test("legacy pi-web-theme data files are imported once on first read", (t) => {
  const { root, agentDir } = newAgentDir(t, "agent");
  const legacyDir = join(root, "pi-web-theme");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(
    join(legacyDir, "palette.json"),
    JSON.stringify({
      presets: [
        { name: "warm-orange", description: "builtin duplicate", light: LIGHT, dark: DARK },
        { name: "sunset", description: "legacy preset", light: LIGHT, dark: DARK },
        { name: "pi-web", light: LIGHT, dark: DARK },
      ],
    }),
  );
  writeFileSync(join(legacyDir, "active.json"), JSON.stringify({ name: "Sunset" }));

  const file = readWebThemes(agentDir);
  assert.equal(file.active, "sunset"); // from legacy active.json, lowercased
  assert.ok(!file.custom.some((entry) => entry.id === "warm-orange")); // builtin wins
  assert.ok(!file.custom.some((entry) => entry.id === "pi-web")); // pi- prefix skipped
  assert.equal(file.custom.find((entry) => entry.id === "sunset")?.description, "legacy preset");

  // Migration happens once: editing legacy files afterwards has no effect.
  writeFileSync(join(legacyDir, "active.json"), JSON.stringify({ name: "matrix" }));
  assert.equal(readWebThemes(agentDir).active, "sunset");
});

test("a damaged store file fails closed to defaults", (t) => {
  const { agentDir } = newAgentDir(t, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(getWebThemesPath(agentDir), "{");
  const file = readWebThemes(agentDir);
  assert.equal(file.active, "pi-default");
  assert.deepEqual(file.custom, []);
});
