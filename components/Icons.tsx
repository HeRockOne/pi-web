"use client";

import type { CSSProperties } from "react";
import { MorphIcon } from "morphicons/react";

// Central home for icons that are actually shared across files (or need
// state animation). One-off decorative SVGs stay inline next to their
// markup — the duplication data doesn't justify a full catalog here.

// MorphIcon's canonical grid is 24×24 (lucide standard); our legacy chevron
// lives on a 10×10 grid, so the points below are the 10-grid shape scaled
// by 2.4. Feeding 10-grid coordinates directly renders a tiny glyph.
const CHEVRON_DOWN = [
  ["polyline", { points: "4.8 8.4 12 15.6 19.2 8.4" }],
] as const;
const CHEVRON_RIGHT = [
  ["polyline", { points: "8.4 4.8 15.6 12 8.4 19.2" }],
] as const;

export function ChevronDownIcon({
  size = 10,
  strokeWidth = 1.6,
  style,
}: {
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <polyline points="2 3.5 5 6.5 8 3.5" />
    </svg>
  );
}

const VOLUME_ON = [
  ["polygon", { points: "11 5 6 9 2 9 2 15 6 15 11 19 11 5" }],
  ["path", { d: "M15.54 8.46a5 5 0 0 1 0 7.07" }],
  ["path", { d: "M19.07 4.93a10 10 0 0 1 0 14.14" }],
] as const;
const VOLUME_OFF = [
  ["polygon", { points: "11 5 6 9 2 9 2 15 6 15 11 19 11 5" }],
  ["line", { x1: "23", y1: "9", x2: "17", y2: "15" }],
  ["line", { x1: "17", y1: "9", x2: "23", y2: "15" }],
] as const;

/** Sound toggle: springs between volume-on waves and the muted cross. */
export function MorphVolumeIcon({
  on,
  size = 12,
  strokeWidth = 2,
  style,
}: {
  on: boolean;
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
}) {
  return (
    <MorphIcon
      icon={on ? VOLUME_ON : VOLUME_OFF}
      size={size}
      strokeWidth={strokeWidth}
      spring="snappy"
      reducedMotion="user"
      style={style}
    />
  );
}

/** Collapse/expand chevron: springs between pointing-right (collapsed) and
 *  pointing-down (open) instead of a hard CSS rotate. `strokeWidth` keeps
 *  the legacy 10×10-grid convention (1.6/1.8) and is rescaled internally. */
export function MorphChevron({
  open,
  size = 10,
  strokeWidth = 1.8,
  style,
}: {
  open: boolean;
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
}) {
  return (
    <MorphIcon
      icon={open ? CHEVRON_DOWN : CHEVRON_RIGHT}
      size={size}
      strokeWidth={strokeWidth * 2.4}
      spring="snappy"
      reducedMotion="user"
      style={style}
    />
  );
}
