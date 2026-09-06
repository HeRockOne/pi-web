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

export const DEFAULT_THEME_ID = "pi-default";

function palette(entries: [string, string][]): WebThemePalette {
  return Object.fromEntries(entries) as WebThemePalette;
}

const PI_DEFAULT: WebTheme = {
  id: DEFAULT_THEME_ID,
  name: "Pi Default",
  description: "官方默认配色",
  builtin: true,
  light: palette([
    ["--bg", "#ffffff"],
    ["--bg-panel", "#f5f5f5"],
    ["--bg-hover", "#eeeeee"],
    ["--bg-selected", "#e8e8e8"],
    ["--border", "#e0e0e0"],
    ["--text", "#1a1a1a"],
    ["--text-muted", "#6b7280"],
    ["--text-dim", "#9ca3af"],
    ["--accent", "#2563eb"],
    ["--accent-hover", "#1d4ed8"],
    ["--user-bg", "#eff6ff"],
    ["--assistant-bg", "#ffffff"],
    ["--tool-bg", "#f9fafb"],
    ["--bg-subtle", "rgba(0,0,0,0.03)"],
  ]),
  dark: palette([
    ["--bg", "#1a1a1a"],
    ["--bg-panel", "#242424"],
    ["--bg-hover", "#2e2e2e"],
    ["--bg-selected", "#383838"],
    ["--border", "#3a3a3a"],
    ["--text", "#e8e8e8"],
    ["--text-muted", "#9ca3af"],
    ["--text-dim", "#6b7280"],
    ["--accent", "#60a5fa"],
    ["--accent-hover", "#93c5fd"],
    ["--user-bg", "#1e293b"],
    ["--assistant-bg", "#1a1a1a"],
    ["--tool-bg", "#1f2937"],
    ["--bg-subtle", "rgba(255,255,255,0.04)"],
  ]),
};

function preset(id: string, name: string, description: string, light: [string, string][], dark: [string, string][]): WebTheme {
  return { id, name, description, builtin: true, light: palette(light), dark: palette(dark) };
}

export const BUILTIN_THEMES: WebTheme[] = [
  PI_DEFAULT,
  preset("warm-orange", "暖橙", "米白背景 + 活力橙主色", [
    ["--bg", "#faf5ee"],
    ["--bg-panel", "#ede1cb"],
    ["--bg-hover", "#e4d4b6"],
    ["--bg-selected", "#eccda2"],
    ["--border", "#d2bb90"],
    ["--text", "#292116"],
    ["--text-muted", "#6f5f45"],
    ["--text-dim", "#a08b6d"],
    ["--accent", "#e56a0c"],
    ["--accent-hover", "#c85a05"],
    ["--user-bg", "#fdeeda"],
    ["--assistant-bg", "#fffdf9"],
    ["--tool-bg", "#f4ead7"],
    ["--bg-subtle", "rgba(229,106,12,.06)"],
  ], [
    ["--bg", "#1b1610"],
    ["--bg-panel", "#262016"],
    ["--bg-hover", "#322a1c"],
    ["--bg-selected", "#3e3422"],
    ["--border", "#423828"],
    ["--text", "#f2e9da"],
    ["--text-muted", "#b8a281"],
    ["--text-dim", "#8a7757"],
    ["--accent", "#f59e0b"],
    ["--accent-hover", "#ffb340"],
    ["--user-bg", "#3a2c15"],
    ["--assistant-bg", "#1b1610"],
    ["--tool-bg", "#241e13"],
    ["--bg-subtle", "rgba(245,158,11,.07)"],
  ]),
  preset("graphite-blue", "石墨蓝", "冷静商务蓝灰，专注氛围", [
    ["--bg", "#f4f6fa"],
    ["--bg-panel", "#e9edf3"],
    ["--bg-hover", "#dde3ec"],
    ["--bg-selected", "#cdd8e6"],
    ["--border", "#c2ccd9"],
    ["--text", "#1e2734"],
    ["--text-muted", "#5d6b7e"],
    ["--text-dim", "#93a0b0"],
    ["--accent", "#2d6da3"],
    ["--accent-hover", "#235a8a"],
    ["--user-bg", "#e6eef8"],
    ["--assistant-bg", "#fbfcfe"],
    ["--tool-bg", "#f0f3f8"],
    ["--bg-subtle", "rgba(45,109,163,.06)"],
  ], [
    ["--bg", "#131a22"],
    ["--bg-panel", "#1a2330"],
    ["--bg-hover", "#223047"],
    ["--bg-selected", "#2c3d55"],
    ["--border", "#32445e"],
    ["--text", "#dde6f0"],
    ["--text-muted", "#8fa3ba"],
    ["--text-dim", "#65788f"],
    ["--accent", "#6fa8dc"],
    ["--accent-hover", "#8fc0ea"],
    ["--user-bg", "#1d2a3c"],
    ["--assistant-bg", "#131a22"],
    ["--tool-bg", "#18212e"],
    ["--bg-subtle", "rgba(111,168,220,.09)"],
  ]),
  preset("emerald", "翠绿", "清新自然绿，护眼柔和", [
    ["--bg", "#f4f9f4"],
    ["--bg-panel", "#e6f0e6"],
    ["--bg-hover", "#d8e8d6"],
    ["--bg-selected", "#c2ddbf"],
    ["--border", "#b5cdb2"],
    ["--text", "#1e2b1e"],
    ["--text-muted", "#57705a"],
    ["--text-dim", "#8ba38c"],
    ["--accent", "#2f855a"],
    ["--accent-hover", "#266d49"],
    ["--user-bg", "#e4f2e5"],
    ["--assistant-bg", "#fbfefb"],
    ["--tool-bg", "#edf5ed"],
    ["--bg-subtle", "rgba(47,133,90,.06)"],
  ], [
    ["--bg", "#0f1712"],
    ["--bg-panel", "#16231a"],
    ["--bg-hover", "#1f3024"],
    ["--bg-selected", "#2a3f30"],
    ["--border", "#36503b"],
    ["--text", "#deebe0"],
    ["--text-muted", "#8fb397"],
    ["--text-dim", "#64806b"],
    ["--accent", "#34d399"],
    ["--accent-hover", "#57dfa8"],
    ["--user-bg", "#18281c"],
    ["--assistant-bg", "#0f1712"],
    ["--tool-bg", "#131f17"],
    ["--bg-subtle", "rgba(52,211,153,.08)"],
  ]),
  preset("violet", "紫罗兰", "浪漫典雅紫，夜间更沉静", [
    ["--bg", "#f7f5fb"],
    ["--bg-panel", "#ece8f6"],
    ["--bg-hover", "#e0daf0"],
    ["--bg-selected", "#cfc5e6"],
    ["--border", "#c2b7db"],
    ["--text", "#27203a"],
    ["--text-muted", "#6a5f8f"],
    ["--text-dim", "#9a91b8"],
    ["--accent", "#7c5cd6"],
    ["--accent-hover", "#6649bd"],
    ["--user-bg", "#e9e2f8"],
    ["--assistant-bg", "#fcfbfe"],
    ["--tool-bg", "#f2effa"],
    ["--bg-subtle", "rgba(124,92,214,.07)"],
  ], [
    ["--bg", "#171322"],
    ["--bg-panel", "#201a31"],
    ["--bg-hover", "#2b2242"],
    ["--bg-selected", "#372c55"],
    ["--border", "#443868"],
    ["--text", "#e6e0f5"],
    ["--text-muted", "#a99cc9"],
    ["--text-dim", "#7d729c"],
    ["--accent", "#a78bfa"],
    ["--accent-hover", "#bea9ff"],
    ["--user-bg", "#241c3d"],
    ["--assistant-bg", "#171322"],
    ["--tool-bg", "#1c1629"],
    ["--bg-subtle", "rgba(167,139,250,.09)"],
  ]),
  preset("paper-ink", "纸墨灰", "极简黑灰，纯粹文字阅读", [
    ["--bg", "#fafafa"],
    ["--bg-panel", "#f0f0f0"],
    ["--bg-hover", "#e6e6e6"],
    ["--bg-selected", "#d9d9d9"],
    ["--border", "#d1d1d1"],
    ["--text", "#1f1f1f"],
    ["--text-muted", "#5f5f5f"],
    ["--text-dim", "#909090"],
    ["--accent", "#4a4a4a"],
    ["--accent-hover", "#2f2f2f"],
    ["--user-bg", "#ececec"],
    ["--assistant-bg", "#ffffff"],
    ["--tool-bg", "#f4f4f4"],
    ["--bg-subtle", "rgba(0,0,0,.04)"],
  ], [
    ["--bg", "#161616"],
    ["--bg-panel", "#1f1f1f"],
    ["--bg-hover", "#292929"],
    ["--bg-selected", "#333333"],
    ["--border", "#3d3d3d"],
    ["--text", "#ececec"],
    ["--text-muted", "#9a9a9a"],
    ["--text-dim", "#707070"],
    ["--accent", "#d0d0d0"],
    ["--accent-hover", "#f0f0f0"],
    ["--user-bg", "#2a2a2a"],
    ["--assistant-bg", "#161616"],
    ["--tool-bg", "#1c1c1c"],
    ["--bg-subtle", "rgba(255,255,255,.05)"],
  ]),
  preset("cyberpunk", "赛博朋克", "夜城黄黑霓虹，荧光裂变", [
    ["--bg", "#f0e9da"],
    ["--bg-panel", "#e3d8c0"],
    ["--bg-hover", "#d9cbae"],
    ["--bg-selected", "#d0bf9b"],
    ["--border", "#bfae87"],
    ["--text", "#262217"],
    ["--text-muted", "#6e6450"],
    ["--text-dim", "#97896f"],
    ["--accent", "#c79100"],
    ["--accent-hover", "#a57600"],
    ["--user-bg", "#fdf0cd"],
    ["--assistant-bg", "#f8f4ea"],
    ["--tool-bg", "#ebe2cd"],
    ["--bg-subtle", "rgba(199,145,0,.07)"],
  ], [
    ["--bg", "#0d0d0c"],
    ["--bg-panel", "#171716"],
    ["--bg-hover", "#211f1c"],
    ["--bg-selected", "#2e2a1c"],
    ["--border", "#302d24"],
    ["--text", "#f2f0e8"],
    ["--text-muted", "#a09a86"],
    ["--text-dim", "#6a6553"],
    ["--accent", "#fcee0a"],
    ["--accent-hover", "#ffe14d"],
    ["--user-bg", "#26240f"],
    ["--assistant-bg", "#0d0d0c"],
    ["--tool-bg", "#141412"],
    ["--bg-subtle", "rgba(252,238,10,.08)"],
  ]),
  preset("matrix", "黑客帝国", "黑底代码绿，数字洪流", [
    ["--bg", "#f1f6f0"],
    ["--bg-panel", "#e3ecdf"],
    ["--bg-hover", "#d6e2d0"],
    ["--bg-selected", "#c6d9bd"],
    ["--border", "#b3cba6"],
    ["--text", "#1d2919"],
    ["--text-muted", "#55644c"],
    ["--text-dim", "#85947c"],
    ["--accent", "#1c8a3d"],
    ["--accent-hover", "#14662c"],
    ["--user-bg", "#e2f3dc"],
    ["--assistant-bg", "#f8fbf4"],
    ["--tool-bg", "#eaf2e4"],
    ["--bg-subtle", "rgba(28,138,61,.07)"],
  ], [
    ["--bg", "#050904"],
    ["--bg-panel", "#0e150c"],
    ["--bg-hover", "#172013"],
    ["--bg-selected", "#1f2d1a"],
    ["--border", "#28401f"],
    ["--text", "#c9ecc2"],
    ["--text-muted", "#5f8f52"],
    ["--text-dim", "#3f6636"],
    ["--accent", "#00ff41"],
    ["--accent-hover", "#3dff6e"],
    ["--user-bg", "#0c1a0a"],
    ["--assistant-bg", "#050904"],
    ["--tool-bg", "#0a1108"],
    ["--bg-subtle", "rgba(0,255,65,.09)"],
  ]),
  preset("rainbow", "七彩虹", "青粉流光，RGB 全开", [
    ["--bg", "#faf5fb"],
    ["--bg-panel", "#f1e9f7"],
    ["--bg-hover", "#e7dcf1"],
    ["--bg-selected", "#d9c9e7"],
    ["--border", "#cbb8d8"],
    ["--text", "#332338"],
    ["--text-muted", "#7a6284"],
    ["--text-dim", "#a18ba9"],
    ["--accent", "#f472b6"],
    ["--accent-hover", "#e14fa0"],
    ["--user-bg", "#fdeef6"],
    ["--assistant-bg", "#fefcfe"],
    ["--tool-bg", "#f7effa"],
    ["--bg-subtle", "rgba(244,114,182,.09)"],
  ], [
    ["--bg", "#0d0a16"],
    ["--bg-panel", "#161126"],
    ["--bg-hover", "#1f1836"],
    ["--bg-selected", "#2a2048"],
    ["--border", "#382d5c"],
    ["--text", "#ece6ff"],
    ["--text-muted", "#a698cf"],
    ["--text-dim", "#7a6da6"],
    ["--accent", "#22d3ee"],
    ["--accent-hover", "#f472b6"],
    ["--user-bg", "#1e1740"],
    ["--assistant-bg", "#0d0a16"],
    ["--tool-bg", "#130e20"],
    ["--bg-subtle", "rgba(34,211,238,.12)"],
  ]),
  preset("anime", "樱粉", "樱花粉二次元，甜系治愈", [
    ["--bg", "#fff6f8"],
    ["--bg-panel", "#ffe9ef"],
    ["--bg-hover", "#ffdce6"],
    ["--bg-selected", "#ffcbda"],
    ["--border", "#f5b8c9"],
    ["--text", "#3a2230"],
    ["--text-muted", "#8f5f72"],
    ["--text-dim", "#b58999"],
    ["--accent", "#ff5c9d"],
    ["--accent-hover", "#e53e83"],
    ["--user-bg", "#ffeef4"],
    ["--assistant-bg", "#ffffff"],
    ["--tool-bg", "#fff0f5"],
    ["--bg-subtle", "rgba(255,92,157,.09)"],
  ], [
    ["--bg", "#17111c"],
    ["--bg-panel", "#211823"],
    ["--bg-hover", "#2c2030"],
    ["--bg-selected", "#382940"],
    ["--border", "#46334a"],
    ["--text", "#f6e8f1"],
    ["--text-muted", "#b391a6"],
    ["--text-dim", "#856a7c"],
    ["--accent", "#ff7ab8"],
    ["--accent-hover", "#ffa3d0"],
    ["--user-bg", "#311d30"],
    ["--assistant-bg", "#17111c"],
    ["--tool-bg", "#1d1520"],
    ["--bg-subtle", "rgba(255,122,184,.1)"],
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
