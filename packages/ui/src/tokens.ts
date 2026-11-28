// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The single colour source of the own shell. Values are direction C's tokens (docs/design/ui/tokens.md section 1,
// "Precise instrument", the default direction until the owner decides otherwise): docs/UX.md's provisional tokens with
// the contrast fixes of tokens.md section 2.4 (dark accent-text #A386FA, dark control-border #757A84, light
// control-border #80858E) and the status, soft and diff colours for both themes. Every surface takes its colours from
// these tokens (as CSS custom properties from `cssVariables`, or by name in main, for example the window's
// background); no other file holds a colour literal. A rebrand changes the values here.

export type ThemeKind = "dark" | "light";

/** Semantic colour roles; both themes define every one. Each is an opaque #RRGGBB value, so its contrast is exact. */
export const TOKEN_NAMES = [
  "canvas", // window, top bar edges, status bar
  "surface", // panes, the navigation rail, the top bar
  "raised", // cards in a pane: groups, diff files, the decision card
  "overlay", // palette, menus, notifications
  "hover", // row and control hover
  "border", // decorative separators only, never a control boundary
  "control-border", // inputs, secondary buttons, segmented controls, keycaps
  "text",
  "text-secondary", // secondary text, placeholders, line numbers, timestamps
  "text-disabled", // disabled controls only (SC 1.4.3 exempts inactive components)
  "accent", // filled primary controls; the label is on-accent
  "accent-hover",
  "accent-text", // links, accent text, focus ring, the current-page edge
  "accent-soft", // selected row, current navigation item
  "on-accent",
  "ok",
  "warn",
  "bad",
  "info",
  "on-status", // label on a filled ok or bad control
  "warn-soft", // protected-path flag, decision header, read-only notice
  "diff-add",
  "diff-del",
] as const;

export type TokenName = (typeof TOKEN_NAMES)[number];
export type Palette = Readonly<Record<TokenName, string>>;

const dark: Palette = Object.freeze({
  canvas: "#111214",
  surface: "#181A1D",
  raised: "#202227",
  overlay: "#272A30",
  hover: "#1F2125",
  border: "#2B2E34",
  "control-border": "#757A84",
  text: "#E8E9EB",
  "text-secondary": "#9A9EA7",
  "text-disabled": "#70757F",
  accent: "#5823F6",
  "accent-hover": "#4A1AD6",
  "accent-text": "#A386FA",
  "accent-soft": "#241C3F",
  "on-accent": "#FFFFFF",
  ok: "#4CC38A",
  warn: "#E5A33D",
  bad: "#F2777C",
  info: "#6CA8F7",
  "on-status": "#111214",
  "warn-soft": "#2A2114",
  "diff-add": "#14281D",
  "diff-del": "#2D1719",
});

const light: Palette = Object.freeze({
  canvas: "#FAFAFB",
  surface: "#FFFFFF",
  raised: "#FFFFFF",
  overlay: "#FFFFFF",
  hover: "#F4F4F6",
  border: "#E5E7EB",
  "control-border": "#80858E",
  text: "#17191D",
  "text-secondary": "#50555F",
  "text-disabled": "#6B7280",
  accent: "#5823F6",
  "accent-hover": "#4A1AD6",
  "accent-text": "#5823F6",
  "accent-soft": "#EFEAFE",
  "on-accent": "#FFFFFF",
  ok: "#146C34",
  warn: "#965506",
  bad: "#C0262D",
  info: "#1D66C2",
  "on-status": "#FFFFFF",
  "warn-soft": "#FFF4E0",
  "diff-add": "#E7F5EC",
  "diff-del": "#FBE9EA",
});

export const PALETTES: Readonly<Record<ThemeKind, Palette>> = Object.freeze({ dark, light });

/** Elevation (tokens.md section 4): 1 resting card, 2 the pending decision only, 3 overlays; the scrim behind a dialog. */
export const SHADOW_NAMES = ["elev-1", "elev-2", "elev-3", "scrim"] as const;
export type ShadowName = (typeof SHADOW_NAMES)[number];

export const SHADOWS: Readonly<Record<ThemeKind, Readonly<Record<ShadowName, string>>>> = Object.freeze({
  dark: Object.freeze({
    "elev-1": "none",
    "elev-2": "0 4px 12px #00000059",
    "elev-3": "0 16px 48px #0000008C, 0 0 0 1px #FFFFFF0A",
    scrim: "#00000066",
  }),
  light: Object.freeze({
    "elev-1": "0 1px 2px #17191D0F",
    "elev-2": "0 4px 12px #17191D14, 0 1px 3px #17191D0F",
    "elev-3": "0 16px 48px #17191D29, 0 2px 8px #17191D14",
    scrim: "#17191D33",
  }),
});

/** The CSS custom property that carries a token, for example `--axis-text-secondary`. */
export function cssVariableName(token: TokenName | ShadowName): string {
  return `--axis-${token}`;
}

/** Every colour of one theme as CSS custom properties, in TOKEN_NAMES order, then the shadows in SHADOW_NAMES order. */
export function cssVariables(theme: ThemeKind): ReadonlyArray<readonly [string, string]> {
  const palette = PALETTES[theme];
  const shadows = SHADOWS[theme];
  return [
    ...TOKEN_NAMES.map((t) => [cssVariableName(t), palette[t]] as const),
    ...SHADOW_NAMES.map((s) => [cssVariableName(s), shadows[s]] as const),
  ];
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
