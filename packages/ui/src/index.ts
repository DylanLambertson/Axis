// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// @axis/ui: the own shell's colour tokens (the single colour source), brand strings, key chords, the command registry
// and the focus rules. Framework-free: the React frame in apps/desktop/renderer uses these.
export { BRAND, windowTitle, type Brand } from "./brand.js";
export { CommandRegistry, type Command, type CommandSpec, type KeyContext } from "./commands.js";
export { nextRegion, rovingIndex, type Orientation } from "./focus.js";
export { chordAria, chordKeys, chordMatches, isTypingChord, parseChord, sameChord, type Chord, type KeyGesture, type Platform } from "./keys.js";
export { PALETTES, SHADOWS, SHADOW_NAMES, TOKEN_NAMES, contrastRatio, cssVariableName, cssVariables, type Palette, type ShadowName, type ThemeKind, type TokenName } from "./tokens.js";
