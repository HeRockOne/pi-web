import {
  THEME_VARIABLE_KEYS,
  type ThemeVariableKey,
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

/**
 * Blend two colors in HSL space: `t = 0` keeps `a`, `t = 1` yields `b`.
 * Non-hex inputs (rgba() and friends) return null — callers fall back to
 * leaving the token untouched rather than writing a broken value.
 */
export function mixHex(a: string, b: string, t: number): string | null {
  const ha = hexToHsl(normalizeHex6(a) ?? "");
  const hb = hexToHsl(normalizeHex6(b) ?? "");
  if (!ha || !hb) return null;
  const k = clamp(t, 0, 1);
  // Keep `a`'s hue: interpolating hues would drag neutral surfaces through
  // unrelated colors when text and background sit on different sides of the wheel.
  return hslToHex(ha[0], ha[1] + (hb[1] - ha[1]) * k, ha[2] + (hb[2] - ha[2]) * k);
}

/** #rrggbb / rgb() / rgba() → channels + alpha; null when unparseable. */
function parseColor(value: string): { r: number; g: number; b: number; a: number } | null {
  const v = value.trim();
  const hex = normalizeHex6(v);
  if (hex) {
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16),
      a: 1,
    };
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (!m) return null;
  const parts = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 && !Number.isNaN(parts[3]) ? parts[3] : 1 };
}

function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
  const channel = (raw: number) => {
    const c = clamp(raw, 0, 255) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/**
 * WCAG contrast ratio between two palette colors, or null when either value is
 * not a color we can read. A translucent foreground is composited over the
 * background first, which is what the eye sees in the app.
 */
export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (!fg || !bg) return null;
  const composed = {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
  };
  const lf = relativeLuminance(composed);
  const lb = relativeLuminance(bg);
  const [hi, lo] = lf >= lb ? [lf, lb] : [lb, lf];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG thresholds: 4.5:1 for body text, 3:1 for the "good enough" tier. */
export function contrastVerdict(ratio: number | null): "good" | "low" | "bad" {
  if (ratio === null) return "bad";
  if (ratio >= 4.5) return "good";
  if (ratio >= 3) return "low";
  return "bad";
}

/**
 * Which base token every derived token follows. The editor uses this to offer
 * "restore automatic" on a field the user overrode by hand.
 */
export const DERIVED_FROM: Partial<Record<ThemeVariableKey, ThemeVariableKey>> = {
  "--bg-panel": "--bg",
  "--bg-hover": "--bg",
  "--bg-selected": "--bg",
  "--border": "--bg",
  "--bg-subtle": "--bg",
  "--assistant-bg": "--bg",
  "--tool-bg": "--bg",
  "--text-muted": "--text",
  "--text-dim": "--text",
  "--accent-hover": "--accent",
  "--user-bg": "--accent",
};

/**
 * Recompute the tokens that follow from one base color.
 *
 * Every rule is "step away from the page background toward the text color" (for
 * surfaces) or "step away from the text color toward the page background" (for
 * quieter text), so a palette stays coherent when the user only picks a handful
 * of colors by hand. Dark palettes take bigger steps because the same lightness
 * delta reads as a smaller contrast change on dark surfaces.
 */
export function deriveRelated(
  palette: WebThemePalette,
  base: ThemeVariableKey,
  mode: "light" | "dark",
): Partial<WebThemePalette> {
  const out: Partial<WebThemePalette> = {};
  const dark = mode === "dark";
  const bg = palette["--bg"];
  const text = palette["--text"];
  const accent = palette["--accent"];

  const surface = (t: number) => {
    const mixed = mixHex(bg, text, dark ? t * 1.6 : t);
    return mixed ?? undefined;
  };
  const put = (key: ThemeVariableKey, value: string | undefined) => {
    if (value) out[key] = value;
  };

  if (base === "--bg") {
    put("--bg-panel", surface(0.035));
    put("--bg-hover", surface(0.07));
    put("--bg-selected", surface(0.11));
    put("--tool-bg", surface(0.025));
    // Stays translucent on purpose: it fills chart hover cursors and stacks on
    // top of other surfaces, where an opaque tint would hide what is under it.
    const textRgb = parseColor(text);
    put(
      "--bg-subtle",
      textRgb
        ? `rgba(${Math.round(textRgb.r)}, ${Math.round(textRgb.g)}, ${Math.round(textRgb.b)}, ${dark ? 0.05 : 0.028})`
        : undefined,
    );
    out["--assistant-bg"] = bg;
    const border = mixHex(bg, text, dark ? 0.34 : 0.16);
    put("--border", border ?? undefined);
  } else if (base === "--text") {
    put("--text-muted", mixHex(text, bg, dark ? 0.34 : 0.36) ?? undefined);
    put("--text-dim", mixHex(text, bg, dark ? 0.55 : 0.62) ?? undefined);
  } else if (base === "--accent") {
    put("--accent-hover", dark ? mixHex(accent, "#ffffff", 0.16) ?? undefined : mixHex(accent, "#000000", 0.16) ?? undefined);
    put("--user-bg", mixHex(bg, accent, 0.08) ?? undefined);
  }
  return out;
}

/** Value a derived token would have if it had not been overridden by hand. */
export function restoreDerived(
  palette: WebThemePalette,
  key: ThemeVariableKey,
  mode: "light" | "dark",
): string | undefined {
  const base = DERIVED_FROM[key];
  if (!base) return undefined;
  return deriveRelated(palette, base, mode)[key];
}

/**
 * A solid hex that approximates how `value` looks on `surface`, for small
 * color swatches. Translucent tokens are composited over the surface instead of
 * being shown as their raw (misleading) channel value.
 */
export function swatchHex(value: string, surface: string): string {
  const toHex = (rgb: { r: number; g: number; b: number }) =>
    `#${[rgb.r, rgb.g, rgb.b].map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, "0")).join("")}`;
  const fg = parseColor(value);
  if (!fg) return "#888888";
  const bg = parseColor(surface);
  if (fg.a >= 1 || !bg) return toHex(fg);
  return toHex({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
  });
}
