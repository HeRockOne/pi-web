import {
  THEME_VARIABLE_KEYS,
  type WebThemePalette,
} from "./web-theme-types";

/**
 * One-color theme generation.
 *
 * Everything here is pure color math so it can be unit-tested: a single seed
 * hex expands into a full 14-key light palette and a matching dark palette.
 * Backgrounds are near-neutral tints of the seed hue, text inverts the same
 * hue for warmth coherence, and the accent keeps the seed's identity.
 */

/** #rgb / #rrggbb → lowercase #rrggbb, or null for rgba() and friends. */
export function normalizeHex6(value: string): string | null {
  const v = value.trim();
  let m = /^#([0-9a-fA-F]{6})$/.exec(v);
  if (m) return `#${m[1].toLowerCase()}`;
  m = /^#([0-9a-fA-F]{3})$/.exec(v);
  if (m) return `#${[...m[1]].map((c) => c + c).join("").toLowerCase()}`;
  return null;
}

export function hexToHsl(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/.exec(hex);
  if (!m) return null;
  const r = parseInt(m[1].slice(0, 2), 16) / 255;
  const g = parseInt(m[1].slice(2, 4), 16) / 255;
  const b = parseInt(m[1].slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s * 100, l * 100];
}

export function hslToHex(h: number, s: number, l: number): string {
  const sN = Math.min(Math.max(s, 0), 100) / 100;
  const lN = Math.min(Math.max(l, 0), 100) / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const hp = ((((h % 360) + 360) % 360) / 60);
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const mN = lN - c / 2;
  const to = (v: number) => Math.round((v + mN) * 255).toString(16).padStart(2, "0");
  return `#${to(rgb[0])}${to(rgb[1])}${to(rgb[2])}`;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

const DARK_BACKGROUND_KEYS = new Set([
  "--bg",
  "--bg-panel",
  "--bg-hover",
  "--bg-selected",
  "--border",
  "--bg-subtle",
  "--user-bg",
  "--assistant-bg",
  "--tool-bg",
]);

/** Turn a light palette into a plausible dark palette (non-hex values pass through). */
export function deriveDarkFromLight(light: WebThemePalette): WebThemePalette {
  const out = {} as WebThemePalette;
  const accentHsl = hexToHsl(normalizeHex6(light["--accent"]) ?? "");
  for (const key of THEME_VARIABLE_KEYS) {
    const hsl = hexToHsl(normalizeHex6(light[key]) ?? "");
    if (!hsl) {
      out[key] = light[key];
      continue;
    }
    const [h, s, l] = hsl;
    if (key === "--accent-hover" && accentHsl) {
      out[key] = hslToHex(accentHsl[0], Math.max(accentHsl[1], 55), clamp(accentHsl[2], 48, 60) + 8);
    } else if (key === "--accent") {
      out[key] = hslToHex(h, Math.max(s, 55), clamp(l, 48, 66));
    } else if (DARK_BACKGROUND_KEYS.has(key)) {
      // Keep each surface slightly lighter than --bg, mirroring light layouts.
      const depth = key === "--bg" ? 0 : key === "--border" ? 8 : 4;
      out[key] = hslToHex(h, s * 0.5, clamp(100 - l + depth, 5, 20));
    } else {
      // Text keys invert into the bright range, dimmer for muted/dim.
      out[key] = hslToHex(h, s * 0.8, clamp(100 - l, 62, 94));
    }
  }
  return out;
}

function tint(h: number, sat: number, l: number): string {
  return hslToHex(h, sat, clamp(l, 0, 100));
}

/**
 * Expand one seed color into complete light + dark palettes.
 * Neutral surfaces carry a whisper of the seed hue; the accent keeps it bold.
 */
export function generatePalettesFromSeed(seedHex: string): { light: WebThemePalette; dark: WebThemePalette } {
  const normalized = normalizeHex6(seedHex) ?? "#2563eb";
  const seedHsl = hexToHsl(normalized) ?? [224, 76, 48];
  const [h, rawSat] = seedHsl;
  // Gray-ish seeds still get enough chroma to feel intentional.
  const s = Math.max(rawSat, 18);

  const light: WebThemePalette = {
    "--bg": tint(h, s * 0.35, 98),
    "--bg-panel": tint(h, s * 0.3, 96.5),
    "--bg-hover": tint(h, s * 0.28, 93.5),
    "--bg-selected": tint(h, s * 0.3, 90),
    "--border": tint(h, s * 0.25, 86),
    "--text": tint(h, s * 0.3, 16),
    "--text-muted": tint(h, s * 0.14, 42),
    "--text-dim": tint(h, s * 0.12, 60),
    "--accent": tint(h, s, 44),
    "--accent-hover": tint(h, s, 37),
    "--user-bg": tint(h, s * 0.55, 93.5),
    "--assistant-bg": tint(h, s * 0.12, 99.5),
    "--tool-bg": tint(h, s * 0.22, 96),
    "--bg-subtle": tint(h, s * 0.18, 96.5),
  };

  const dark: WebThemePalette = {
    "--bg": tint(h, s * 0.3, 7.5),
    "--bg-panel": tint(h, s * 0.26, 11),
    "--bg-hover": tint(h, s * 0.22, 16),
    "--bg-selected": tint(h, s * 0.24, 18.5),
    "--border": tint(h, s * 0.18, 23),
    "--text": tint(h, s * 0.18, 90),
    "--text-muted": tint(h, s * 0.12, 68),
    "--text-dim": tint(h, s * 0.1, 50),
    "--accent": tint(h, Math.max(s, 55), 58),
    "--accent-hover": tint(h, Math.max(s, 55), 67),
    "--user-bg": tint(h, s * 0.28, 14),
    "--assistant-bg": tint(h, s * 0.26, 11),
    "--tool-bg": tint(h, s * 0.3, 9.5),
    "--bg-subtle": tint(h, s * 0.26, 10.5),
  };

  return { light, dark };
}
