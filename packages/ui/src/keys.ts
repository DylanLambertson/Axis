// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Key chords of the own shell (OS-6): what Code OSS's keybinding service gave the legacy shell. A chord is written
// once, platform-neutral ("Mod+K", "Shift+F6", "Ctrl+Alt+Mod+1"), and resolved per platform: Mod is Cmd on macOS and
// Ctrl elsewhere. Matching is exact: a chord with fewer modifiers than were pressed does not match.

export type Platform = "mac" | "other";

/** The part of a DOM `KeyboardEvent` a chord reads. */
export interface KeyGesture {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

export interface Chord {
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  /** `KeyboardEvent.key` for named keys ("Enter", "F6", "Escape"), an upper-case letter, a digit or one symbol. */
  readonly key: string;
}

const MODIFIERS = new Set(["Mod", "Ctrl", "Alt", "Shift"]);
const NAMED = /^(Enter|Escape|Tab|Space|Backspace|Delete|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|F([1-9]|1[0-2]))$/;

/** Parses "Mod+Shift+K". Throws on an unknown or repeated modifier, an empty key or more than one key. */
export function parseChord(text: string): Chord {
  const parts = text.split("+");
  const key = parts.pop() ?? "";
  const seen = new Set<string>();
  for (const p of parts) {
    if (!MODIFIERS.has(p) || seen.has(p)) throw new Error(`not a chord: ${text}`);
    seen.add(p);
  }
  const valid = NAMED.test(key) || /^[A-Z0-9]$/.test(key) || /^[[\]\\/.,;'`=-]$/.test(key);
  if (!valid) throw new Error(`not a chord: ${text}`);
  return { mod: seen.has("Mod"), ctrl: seen.has("Ctrl"), alt: seen.has("Alt"), shift: seen.has("Shift"), key };
}

function keyMatches(event: KeyGesture, key: string): boolean {
  if (/^[A-Z]$/.test(key)) return event.code === `Key${key}` || event.key.toUpperCase() === key;
  if (/^[0-9]$/.test(key)) return event.code === `Digit${key}` || event.key === key;
  if (key === "Space") return event.key === " " || event.code === "Space";
  return event.key === key;
}

/** True when the event is exactly this chord on this platform. */
export function chordMatches(event: KeyGesture, chord: Chord, platform: Platform): boolean {
  const wantCtrl = chord.ctrl || (chord.mod && platform === "other");
  const wantMeta = chord.mod && platform === "mac";
  return event.ctrlKey === wantCtrl && event.metaKey === wantMeta && event.altKey === chord.alt && event.shiftKey === chord.shift && keyMatches(event, chord.key);
}

/** A chord with no Mod, Ctrl or Alt on a printable key: it would eat typed text, so it never fires inside an input. */
export function isTypingChord(chord: Chord): boolean {
  return !chord.mod && !chord.ctrl && !chord.alt && (chord.key === "Space" || !NAMED.test(chord.key));
}

/** The same keys: equal modifiers and key, whatever order the text named them in. */
export function sameChord(a: Chord, b: Chord): boolean {
  return a.mod === b.mod && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.key === b.key;
}

const MAC_KEYS: Readonly<Record<string, string>> = { Enter: "↩", Escape: "⎋", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };
const OTHER_KEYS: Readonly<Record<string, string>> = { Escape: "Esc", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };

/** The keycaps a shortcut badge shows, in the platform's order (macOS: Ctrl, Alt, Shift, Cmd; else Ctrl, Shift, Alt). */
export function chordKeys(chord: Chord, platform: Platform): readonly string[] {
  if (platform === "mac") {
    const caps = [chord.ctrl && "⌃", chord.alt && "⌥", chord.shift && "⇧", chord.mod && "⌘"].filter((k): k is string => typeof k === "string");
    return [...caps, MAC_KEYS[chord.key] ?? chord.key];
  }
  const caps = [(chord.ctrl || chord.mod) && "Ctrl", chord.shift && "Shift", chord.alt && "Alt"].filter((k): k is string => typeof k === "string");
  return [...caps, OTHER_KEYS[chord.key] ?? chord.key];
}

/** The `aria-keyshortcuts` value of a chord (WAI-ARIA names: Control, Meta, Alt, Shift). */
export function chordAria(chord: Chord, platform: Platform): string {
  const mods = [(chord.ctrl || (chord.mod && platform === "other")) && "Control", chord.mod && platform === "mac" && "Meta", chord.alt && "Alt", chord.shift && "Shift"];
  return [...mods.filter((m): m is string => typeof m === "string"), chord.key].join("+");
}
