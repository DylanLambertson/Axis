// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chordAria, chordKeys, chordMatches, isTypingChord, parseChord, sameChord, type KeyGesture } from "../src/index.js";

function ev(key: string, extra: Partial<KeyGesture> = {}): KeyGesture {
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : key;
  return { key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra };
}

test("parseChord reads modifiers in any order and refuses unknown, repeated or missing parts", () => {
  assert.deepEqual(parseChord("Mod+Shift+K"), { mod: true, ctrl: false, alt: false, shift: true, key: "K" });
  assert.ok(sameChord(parseChord("Shift+Mod+K"), parseChord("Mod+Shift+K")));
  assert.ok(!sameChord(parseChord("Mod+K"), parseChord("Ctrl+K")), "Mod and Ctrl differ on macOS");
  assert.deepEqual(parseChord("F6"), { mod: false, ctrl: false, alt: false, shift: false, key: "F6" });
  for (const bad of ["", "Mod+", "Cmd+K", "Mod+Mod+K", "Mod+k", "Mod+KK", "Mod+F13", "Shift"]) {
    assert.throws(() => parseChord(bad), /not a chord/, bad);
  }
});

test("Mod is Cmd on macOS and Ctrl elsewhere, and matching is exact on every modifier", () => {
  const modK = parseChord("Mod+K");
  assert.ok(chordMatches(ev("k", { metaKey: true }), modK, "mac"));
  assert.ok(!chordMatches(ev("k", { ctrlKey: true }), modK, "mac"), "Ctrl+K on macOS");
  assert.ok(chordMatches(ev("k", { ctrlKey: true }), modK, "other"));
  assert.ok(!chordMatches(ev("k", { metaKey: true }), modK, "other"), "Meta+K elsewhere");
  assert.ok(!chordMatches(ev("k", { ctrlKey: true, shiftKey: true }), modK, "other"), "an extra Shift");
  assert.ok(!chordMatches(ev("k", { ctrlKey: true, altKey: true }), modK, "other"), "an extra Alt");
  assert.ok(!chordMatches(ev("j", { ctrlKey: true }), modK, "other"), "another key");
  const toggle = parseChord("Ctrl+Mod+V");
  assert.ok(chordMatches(ev("v", { ctrlKey: true, metaKey: true }), toggle, "mac"));
  assert.ok(!chordMatches(ev("v", { metaKey: true }), toggle, "mac"));
});

test("letters and digits match by physical key too, so Alt or a layout that changes event.key still matches", () => {
  assert.ok(chordMatches({ key: "å", code: "KeyA", ctrlKey: false, metaKey: false, altKey: true, shiftKey: false }, parseChord("Alt+A"), "mac"));
  assert.ok(chordMatches({ key: "!", code: "Digit1", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }, parseChord("Ctrl+Shift+1"), "other"));
  assert.ok(chordMatches(ev("F6", { shiftKey: true }), parseChord("Shift+F6"), "other"));
  assert.ok(chordMatches({ key: " ", code: "Space", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, parseChord("Space"), "other"));
});

test("a bare letter, digit, symbol or Space is a typing chord; a named key or any Mod/Ctrl/Alt chord is not", () => {
  for (const c of ["J", "Shift+N", "1", "[", "Space"]) assert.ok(isTypingChord(parseChord(c)), c);
  for (const c of ["F6", "Enter", "Escape", "Mod+K", "Ctrl+J", "Alt+N"]) assert.ok(!isTypingChord(parseChord(c)), c);
});

test("keycaps and aria-keyshortcuts per platform", () => {
  assert.deepEqual(chordKeys(parseChord("Mod+Enter"), "mac"), ["⌘", "↩"]);
  assert.deepEqual(chordKeys(parseChord("Mod+Enter"), "other"), ["Ctrl", "Enter"]);
  assert.deepEqual(chordKeys(parseChord("Ctrl+Alt+Shift+Mod+1"), "mac"), ["⌃", "⌥", "⇧", "⌘", "1"]);
  assert.deepEqual(chordKeys(parseChord("Ctrl+Alt+Shift+Mod+1"), "other"), ["Ctrl", "Shift", "Alt", "1"]);
  assert.deepEqual(chordKeys(parseChord("Escape"), "other"), ["Esc"]);
  assert.equal(chordAria(parseChord("Mod+Enter"), "mac"), "Meta+Enter");
  assert.equal(chordAria(parseChord("Mod+Enter"), "other"), "Control+Enter");
  assert.equal(chordAria(parseChord("Ctrl+Mod+V"), "mac"), "Control+Meta+V");
  assert.equal(chordAria(parseChord("Shift+F6"), "other"), "Shift+F6");
});
