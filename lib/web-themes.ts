import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  allThemes,
  findTheme,
  sanitizeCustomTheme,
  sanitizeThemesFile,
  type WebTheme,
  type WebThemesFile,
} from "./web-theme-types";

/**
 * Server-side store for pi-web frontend color themes.
 *
 * File: <agentDir>/pi-web-themes.json — { active, custom: WebTheme[] }.
 * Builtin presets live in lib/web-theme-types.ts and are merged on read.
 *
 * Legacy migration: the old patch-based extension kept themes in
 * <agentDir>/../pi-web-theme/{palette.json,active.json}; on first read they
 * are imported as custom themes (builtin ids always win on collision).
 *
 * All functions accept an optional agentDir override for tests.
 */

export function getWebThemesPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "pi-web-themes.json");
}

function getLegacyPalettePath(agentDir: string): string {
  return join(agentDir, "..", "pi-web-theme", "palette.json");
}

function getLegacyActivePath(agentDir: string): string {
  return join(agentDir, "..", "pi-web-theme", "active.json");
}

function readJsonFile(path: string): unknown {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null; // malformed file fails closed to defaults
  }
}

const LEGACY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

function importLegacyThemes(agentDir: string): WebThemesFile {
  const file: WebThemesFile = { active: DEFAULT_THEME_ID, custom: [] };
  const palette = readJsonFile(getLegacyPalettePath(agentDir)) as Record<string, unknown> | null;
  if (palette && Array.isArray(palette.presets)) {
    for (const entry of palette.presets) {
      if (typeof entry !== "object" || entry === null) continue;
      const source = entry as Record<string, unknown>;
      const name = typeof source.name === "string" ? source.name : "";
      if (!name || !LEGACY_ID_PATTERN.test(name) || name.startsWith("pi-")) continue;
      const id = name.toLowerCase();
      // Builtin presets already ship these ids with identical palettes.
      if (BUILTIN_THEMES.some((builtin) => builtin.id === id)) continue;
      const theme = sanitizeCustomTheme({
        id,
        name,
        description: typeof source.description === "string" ? source.description : undefined,
        light: source.light,
        dark: source.dark,
      });
      if (!theme || file.custom.some((existing) => existing.id === theme.id)) continue;
      file.custom.push(theme);
    }
  }
  const legacyActive = readJsonFile(getLegacyActivePath(agentDir));
  if (typeof legacyActive === "object" && legacyActive !== null) {
    const name = (legacyActive as Record<string, unknown>).name;
    if (typeof name === "string" && name) file.active = name.toLowerCase();
  }
  return file;
}

function ensureActive(file: WebThemesFile): WebThemesFile {
  if (!findTheme(allThemes(file.custom), file.active)) file.active = DEFAULT_THEME_ID;
  return file;
}

export function readWebThemes(agentDir: string = getAgentDir()): WebThemesFile {
  const path = getWebThemesPath(agentDir);
  const raw = readJsonFile(path);
  if (raw === null && !existsSync(path)) {
    // One-time import from the legacy patch extension's data files.
    const migrated = ensureActive(importLegacyThemes(agentDir));
    writeWebThemes(migrated, agentDir);
    return migrated;
  }
  return ensureActive(sanitizeThemesFile(raw));
}

export function writeWebThemes(file: WebThemesFile, agentDir: string = getAgentDir()): void {
  const path = getWebThemesPath(agentDir);
  mkdirSync(join(path, ".."), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

export function listWebThemes(agentDir: string = getAgentDir()): { themes: WebTheme[]; active: string } {
  const file = readWebThemes(agentDir);
  return { themes: allThemes(file.custom), active: file.active };
}

export function activateWebTheme(id: string, agentDir: string = getAgentDir()): WebTheme | null {
  const file = readWebThemes(agentDir);
  const theme = findTheme(allThemes(file.custom), id);
  if (!theme) return null;
  file.active = id;
  writeWebThemes(file, agentDir);
  return theme;
}

export function upsertCustomTheme(input: unknown, agentDir: string = getAgentDir()): WebTheme | null {
  const theme = sanitizeCustomTheme(input);
  if (!theme) return null;
  const file = readWebThemes(agentDir);
  file.custom = [...file.custom.filter((existing) => existing.id !== theme.id), theme];
  file.active = theme.id;
  writeWebThemes(file, agentDir);
  return theme;
}

export function deleteCustomTheme(id: string, agentDir: string = getAgentDir()): { ok: boolean; wasActive: boolean } {
  const file = readWebThemes(agentDir);
  const existing = file.custom.find((theme) => theme.id === id);
  if (!existing) return { ok: false, wasActive: false };
  file.custom = file.custom.filter((theme) => theme.id !== id);
  const wasActive = file.active === id;
  if (wasActive) file.active = DEFAULT_THEME_ID;
  writeWebThemes(file, agentDir);
  return { ok: true, wasActive };
}
