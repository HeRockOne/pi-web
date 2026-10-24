import type { CSSProperties } from "react";
import { vs } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";

export type PrismTheme = Record<string, CSSProperties>;

const PRE_SELECTOR = 'pre[class*="language-"]';

/**
 * The bundled Prism themes disagree about how they paint the code block background:
 * the light theme sets the `backgroundColor` longhand while the dark theme sets the
 * `background` shorthand. Swapping themes therefore removes one property while its
 * conflicting counterpart is set, which React reports as a styling bug. Every code
 * block paints its own background through `customStyle` anyway, so both themes are
 * normalized to a transparent `backgroundColor` and no shorthand survives.
 */
function withoutPreBackground(theme: PrismTheme): PrismTheme {
  const pre = theme[PRE_SELECTOR];
  if (!pre) return theme;
  const rest: CSSProperties = { ...pre };
  delete rest.background;
  delete rest.backgroundColor;
  return { ...theme, [PRE_SELECTOR]: { ...rest, backgroundColor: "transparent" } };
}

export const PRISM_LIGHT_THEME = withoutPreBackground(vs as PrismTheme);
export const PRISM_DARK_THEME = withoutPreBackground(vscDarkPlus as PrismTheme);
