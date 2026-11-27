// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The single colour source of the own shell. Values are the provisional tokens of docs/UX.md ("Visual tokens"),
// the same values the legacy theme-axis extension uses. Every surface takes its colours from these tokens (as CSS
// custom properties from `cssVariables`, or by name in main, for example the window's background); no other file
// holds a colour literal. A rebrand changes the values here.

export type ThemeKind = "dark" | "light";

/** Semantic token names; both themes define every one. */
export const TOKEN_NAMES = [
  "canvas",
  "surface",
  "raised",
  "border",
  "control-border",
  "text",
  "text-secondary",
  "text-muted",
  "accent",
  "accent-text",
  "on-accent",
] as const;

export type TokenName = (typeof TOKEN_NAMES)[number];
export type Palette = Readonly<Record<TokenName, string>>;

const dark: Palette = Object.freeze({
  canvas: "#111214",
  surface: "#181A1D",
  raised: "#202227",
  border: "#2B2E34",
  "control-border": "#6B7079",
  text: "#E8E9EB",
  "text-secondary": "#9A9EA7",
  "text-muted": "#70757F",
  accent: "#5823F6",
  "accent-text": "#9776F9",
  "on-accent": "#FFFFFF",
});

const light: Palette = Object.freeze({
  canvas: "#FAFAFB",
  surface: "#FFFFFF",
  raised: "#FFFFFF",
  border: "#E5E7EB",
  "control-border": "#8A8F98",
  text: "#17191D",
  "text-secondary": "#50555F",
  "text-muted": "#6B7280",
  accent: "#5823F6",
  "accent-text": "#5823F6",
  "on-accent": "#FFFFFF",
});

export const PALETTES: Readonly<Record<ThemeKind, Palette>> = Object.freeze({ dark, light });

/** The CSS custom property that carries a token, for example `--axis-text-secondary`. */
export function cssVariableName(token: TokenName): string {
  return `--axis-${token}`;
}

/** Every token of one theme as CSS custom properties, in TOKEN_NAMES order. */
export function cssVariables(theme: ThemeKind): ReadonlyArray<readonly [string, string]> {
  const palette = PALETTES[theme];
  return TOKEN_NAMES.map((t) => [cssVariableName(t), palette[t]] as const);
}

const HEX = /^#[0-9A-F]{6}$/;

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  if (!HEX.test(hex)) throw new Error(`not a #RRGGBB colour: ${hex}`);
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 0xff) + 0.7152 * channel((n >> 8) & 0xff) + 0.0722 * channel(n & 0xff);
}

/** The WCAG 2.2 contrast ratio of two #RRGGBB colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
