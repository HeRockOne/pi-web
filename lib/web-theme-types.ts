/**
 * Web theme data model shared by client and server (no node-only imports here).
 *
 * A theme is two palettes (light / dark) of the app's 14 CSS custom properties.
 * The runtime mechanism: a generated stylesheet overrides the variables defined
 * in app/globals.css; light vs dark still follows the existing `html.dark`
 * class toggled by hooks/useTheme.ts, so nothing else in the UI changes.
 */

export const THEME_VARIABLE_KEYS = [
  "--bg",
  "--bg-panel",
  "--bg-hover",
  "--bg-selected",
  "--border",
  "--text",
  "--text-muted",
  "--text-dim",
  "--accent",
  "--accent-hover",
  "--user-bg",
  "--assistant-bg",
  "--tool-bg",
  "--bg-subtle",
] as const;

export type ThemeVariableKey = (typeof THEME_VARIABLE_KEYS)[number];

export type WebThemePalette = Record<ThemeVariableKey, string>;

export interface WebTheme {
  /** Stable identifier; also used as the persisted "active" value. */
  id: string;
  name: string;
  description?: string;
  /** Builtin presets cannot be edited or deleted from the UI. */
  builtin: boolean;
  light: WebThemePalette;
  dark: WebThemePalette;
}

export interface WebThemesFile {
  active: string;
  custom: WebTheme[];
}

export const DEFAULT_THEME_ID = "codex";

function palette(entries: [string, string][]): WebThemePalette {
  return Object.fromEntries(entries) as WebThemePalette;
}

/**
 * Codex — the default: neutral zinc surfaces, near-black (near-white in dark)
 * primary accent, generous whitespace. Every other preset keeps this exact
 * structure and only re-tints it, so no theme can ship clashing surfaces.
 */
const CODEX: WebTheme = {
  id: DEFAULT_THEME_ID,
  name: "Codex",
  description: "中性极简，近黑主色，全站默认",
  builtin: true,
  light: palette([
    ["--bg", "#ffffff"],
    ["--bg-panel", "#f7f7f8"],
    ["--bg-hover", "#ececee"],
    ["--bg-selected", "#e4e4e6"],
    ["--border", "#e4e4e7"],
    ["--text", "#18181b"],
    ["--text-muted", "#5f5f6b"],
    ["--text-dim", "#9d9da8"],
    ["--accent", "#18181b"],
    ["--accent-hover", "#3f3f46"],
    ["--user-bg", "#f4f4f5"],
    ["--assistant-bg", "#ffffff"],
    ["--tool-bg", "#fafafa"],
    ["--bg-subtle", "rgba(0, 0, 0, 0.03)"],
  ]),
  dark: palette([
    ["--bg", "#101012"],
    ["--bg-panel", "#17171a"],
    ["--bg-hover", "#202024"],
    ["--bg-selected", "#28282d"],
    ["--border", "#2a2a30"],
    ["--text", "#ececed"],
    ["--text-muted", "#a4a4ae"],
    ["--text-dim", "#6c6c76"],
    ["--accent", "#ececed"],
    ["--accent-hover", "#ffffff"],
    ["--user-bg", "#1c1c20"],
    ["--assistant-bg", "#101012"],
    ["--tool-bg", "#141417"],
    ["--bg-subtle", "rgba(255, 255, 255, 0.045)"],
  ]),
};

function preset(id: string, name: string, description: string, light: [string, string][], dark: [string, string][]): WebTheme {
  return { id, name, description, builtin: true, light: palette(light), dark: palette(dark) };
}

export const BUILTIN_THEMES: WebTheme[] = [
  CODEX,
  // Kept id for existing installs whose active theme referenced it.
  preset("paper-ink", "纸墨", "暖纸灰 + 墨色主色，纯粹阅读", [
    ["--bg", "#fafaf9"],
    ["--bg-panel", "#f0efed"],
    ["--bg-hover", "#e7e5e2"],
    ["--bg-selected", "#dcdad6"],
    ["--border", "#dedcd8"],
    ["--text", "#1c1c1a"],
    ["--text-muted", "#61605c"],
    ["--text-dim", "#98968f"],
    ["--accent", "#44403c"],
    ["--accent-hover", "#292524"],
    ["--user-bg", "#f1f0ee"],
    ["--assistant-bg", "#fcfcfb"],
    ["--tool-bg", "#f5f4f2"],
    ["--bg-subtle", "rgba(0, 0, 0, 0.035)"],
  ], [
    ["--bg", "#131312"],
    ["--bg-panel", "#1b1b19"],
    ["--bg-hover", "#242422"],
    ["--bg-selected", "#2d2d2a"],
    ["--border", "#2e2e2b"],
    ["--text", "#e8e8e6"],
    ["--text-muted", "#a3a29c"],
    ["--text-dim", "#6f6e68"],
    ["--accent", "#d6d3d1"],
    ["--accent-hover", "#f5f5f4"],
    ["--user-bg", "#212120"],
    ["--assistant-bg", "#131312"],
    ["--tool-bg", "#171716"],
    ["--bg-subtle", "rgba(255, 255, 255, 0.05)"],
  ]),
  preset("graphite-blue", "石墨蓝", "冷灰面板 + 钢青主色，专注氛围", [
    ["--bg", "#fbfbfc"],
    ["--bg-panel", "#f2f3f6"],
    ["--bg-hover", "#e9ebf0"],
    ["--bg-selected", "#dfe2e9"],
    ["--border", "#e0e3e9"],
    ["--text", "#1a2029"],
    ["--text-muted", "#5c6675"],
    ["--text-dim", "#939caa"],
    ["--accent", "#2f5f8f"],
    ["--accent-hover", "#26507a"],
    ["--user-bg", "#eef1f6"],
    ["--assistant-bg", "#fdfdfe"],
    ["--tool-bg", "#f3f5f8"],
    ["--bg-subtle", "rgba(47, 95, 143, 0.05)"],
  ], [
    ["--bg", "#12151a"],
    ["--bg-panel", "#191d24"],
    ["--bg-hover", "#232935"],
    ["--bg-selected", "#2d3542"],
    ["--border", "#2c3440"],
    ["--text", "#dfe4ec"],
    ["--text-muted", "#94a0b0"],
    ["--text-dim", "#6b7887"],
    ["--accent", "#7fb0dc"],
    ["--accent-hover", "#a3c7ea"],
    ["--user-bg", "#1b212b"],
    ["--assistant-bg", "#12151a"],
    ["--tool-bg", "#161a21"],
    ["--bg-subtle", "rgba(127, 176, 220, 0.08)"],
  ]),
  preset("sage", "松枝", "灰绿底 + 松针主色，护眼安静", [
    ["--bg", "#fbfcfa"],
    ["--bg-panel", "#f1f4ef"],
    ["--bg-hover", "#e7ece4"],
    ["--bg-selected", "#dde4d9"],
    ["--border", "#dfe4da"],
    ["--text", "#1d231c"],
    ["--text-muted", "#5d685b"],
    ["--text-dim", "#939c90"],
    ["--accent", "#4a7c59"],
    ["--accent-hover", "#3b6647"],
    ["--user-bg", "#eff3ec"],
    ["--assistant-bg", "#fdfefd"],
    ["--tool-bg", "#f4f7f1"],
    ["--bg-subtle", "rgba(74, 124, 89, 0.05)"],
  ], [
    ["--bg", "#111511"],
    ["--bg-panel", "#181d17"],
    ["--bg-hover", "#222a20"],
    ["--bg-selected", "#2c3529"],
    ["--border", "#2b342a"],
    ["--text", "#e2e8df"],
    ["--text-muted", "#9dab99"],
    ["--text-dim", "#6b796a"],
    ["--accent", "#7dc794"],
    ["--accent-hover", "#a3dab2"],
    ["--user-bg", "#1a221a"],
    ["--assistant-bg", "#111511"],
    ["--tool-bg", "#141a13"],
    ["--bg-subtle", "rgba(125, 199, 148, 0.08)"],
  ]),
  preset("plum", "暮紫", "雾紫面板 + 紫藤主色，夜间沉静", [
    ["--bg", "#fcfbfd"],
    ["--bg-panel", "#f3f1f6"],
    ["--bg-hover", "#eae6f0"],
    ["--bg-selected", "#e0dae9"],
    ["--border", "#e2dde9"],
    ["--text", "#211d29"],
    ["--text-muted", "#645c72"],
    ["--text-dim", "#9b93a8"],
    ["--accent", "#6d5a9e"],
    ["--accent-hover", "#5a4887"],
    ["--user-bg", "#f1edf7"],
    ["--assistant-bg", "#fefeff"],
    ["--tool-bg", "#f5f2f9"],
    ["--bg-subtle", "rgba(109, 90, 158, 0.05)"],
  ], [
    ["--bg", "#131118"],
    ["--bg-panel", "#1a1822"],
    ["--bg-hover", "#242030"],
    ["--bg-selected", "#2e2939"],
    ["--border", "#2d2838"],
    ["--text", "#e6e2ee"],
    ["--text-muted", "#a79fbd"],
    ["--text-dim", "#716a85"],
    ["--accent", "#b09ae0"],
    ["--accent-hover", "#c7b6ec"],
    ["--user-bg", "#1e1a2a"],
    ["--assistant-bg", "#131118"],
    ["--tool-bg", "#171420"],
    ["--bg-subtle", "rgba(176, 154, 224, 0.08)"],
  ]),
  preset("rose", "藕粉", "暖灰底 + 藕荷主色，柔和克制", [
    ["--bg", "#fdfbfb"],
    ["--bg-panel", "#f7f1f2"],
    ["--bg-hover", "#f0e6e8"],
    ["--bg-selected", "#e7d8db"],
    ["--border", "#e9dce0"],
    ["--text", "#291f22"],
    ["--text-muted", "#6f5c62"],
    ["--text-dim", "#a8939a"],
    ["--accent", "#b0566d"],
    ["--accent-hover", "#96455a"],
    ["--user-bg", "#f8eef0"],
    ["--assistant-bg", "#fefcfc"],
    ["--tool-bg", "#f9f3f4"],
    ["--bg-subtle", "rgba(176, 86, 109, 0.05)"],
  ], [
    ["--bg", "#161114"],
    ["--bg-panel", "#1e171b"],
    ["--bg-hover", "#291f25"],
    ["--bg-selected", "#33272e"],
    ["--border", "#322630"],
    ["--text", "#f0e4e8"],
    ["--text-muted", "#bb9ea8"],
    ["--text-dim", "#826870"],
    ["--accent", "#e59cb0"],
    ["--accent-hover", "#eeb8c7"],
    ["--user-bg", "#251a1f"],
    ["--assistant-bg", "#161114"],
    ["--tool-bg", "#1a1318"],
    ["--bg-subtle", "rgba(229, 156, 176, 0.08)"],
  ]),
  // Kept id for existing installs whose active theme referenced it.
  preset("warm-orange", "琥珀", "米黄纸面 + 琥珀主色，温润沉稳", [
    ["--bg", "#faf9f7"],
    ["--bg-panel", "#f1ede6"],
    ["--bg-hover", "#e8e2d6"],
    ["--bg-selected", "#ded4c2"],
    ["--border", "#ddd5c6"],
    ["--text", "#2b2418"],
    ["--text-muted", "#6f6350"],
    ["--text-dim", "#a3957d"],
    ["--accent", "#b45309"],
    ["--accent-hover", "#92400e"],
    ["--user-bg", "#f5eee2"],
    ["--assistant-bg", "#fdfcfa"],
    ["--tool-bg", "#f6f1e8"],
    ["--bg-subtle", "rgba(180, 83, 9, 0.05)"],
  ], [
    ["--bg", "#16130e"],
    ["--bg-panel", "#1e1a13"],
    ["--bg-hover", "#292318"],
    ["--bg-selected", "#332c1e"],
    ["--border", "#332c1f"],
    ["--text", "#ede4d3"],
    ["--text-muted", "#b3a488"],
    ["--text-dim", "#7d7159"],
    ["--accent", "#f59e0b"],
    ["--accent-hover", "#fbbf24"],
    ["--user-bg", "#262015"],
    ["--assistant-bg", "#16130e"],
    ["--tool-bg", "#1a160f"],
    ["--bg-subtle", "rgba(245, 158, 11, 0.07)"],
  ]),
];

const VARIABLE_VALUE_MAX_LENGTH = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidThemeId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
}

export function isValidPalette(value: unknown): value is WebThemePalette {
  if (!isRecord(value)) return false;
  return THEME_VARIABLE_KEYS.every((key) => {
    const entry = value[key];
    return typeof entry === "string" && entry.length > 0 && entry.length <= VARIABLE_VALUE_MAX_LENGTH
      && !entry.includes("{") && !entry.includes("}") && !entry.includes("<") && !entry.includes(">");
  });
}

/** Validate a user-submitted custom theme; returns null when invalid. */
export function sanitizeCustomTheme(input: unknown): WebTheme | null {
  if (!isRecord(input)) return null;
  if (!isValidThemeId(input.id) || input.id.startsWith("pi-")) return null;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length === 0 || name.length > 60) return null;
  if (!isValidPalette(input.light) || !isValidPalette(input.dark)) return null;
  const description = typeof input.description === "string" ? input.description.trim().slice(0, 200) : undefined;
  return {
    id: input.id,
    name,
    ...(description ? { description } : {}),
    builtin: false,
    light: input.light,
    dark: input.dark,
  };
}

export function sanitizeThemesFile(input: unknown): WebThemesFile {
  const file: WebThemesFile = { active: DEFAULT_THEME_ID, custom: [] };
  if (!isRecord(input)) return file;
  if (typeof input.active === "string" && input.active) file.active = input.active;
  if (Array.isArray(input.custom)) {
    for (const entry of input.custom) {
      const theme = sanitizeCustomTheme(entry);
      if (theme && !file.custom.some((existing) => existing.id === theme.id)) file.custom.push(theme);
    }
  }
  return file;
}

export function findTheme(themes: WebTheme[], id: string): WebTheme | undefined {
  return themes.find((theme) => theme.id === id);
}

export function allThemes(custom: WebTheme[]): WebTheme[] {
  return [...BUILTIN_THEMES, ...custom];
}

/**
 * Build the override stylesheet for one theme. Selectors are doubled
 * (`:root:root` / `html.dark:root`) so the overrides win over app/globals.css
 * regardless of <style> injection order in <head>.
 */
export function themeToCss(theme: WebTheme): string {
  const lightBlock = THEME_VARIABLE_KEYS.map((key) => `  ${key}: ${theme.light[key]};`).join("\n");
  const darkBlock = THEME_VARIABLE_KEYS.map((key) => `  ${key}: ${theme.dark[key]};`).join("\n");
  return `/* pi-web custom theme: ${theme.id} */\n:root:root {\n${lightBlock}\n}\nhtml.dark:root {\n${darkBlock}\n}`;
}
