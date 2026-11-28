// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterCommands, paletteKeyAction, paletteMove, type PaletteKey } from "../src/index.js";

const ITEMS = [
  { id: "a.focusNext", title: "Focus next region" },
  { id: "a.goHome", title: "Go to Home" },
  { id: "a.goTasks", title: "Go to Tasks" },
  { id: "a.showHome", title: "Show home tasks" },
];
const ids = (items: readonly { id: string }[]) => items.map((i) => i.id);

test("an empty or blank query shows every command in the given order", () => {
  assert.equal(filterCommands(ITEMS, ""), ITEMS);
  assert.deepEqual(ids(filterCommands(ITEMS, "   ")), ids(ITEMS));
});

test("every term must appear in the title, ignoring case and extra spaces", () => {
  assert.deepEqual(ids(filterCommands(ITEMS, "HOME")), ["a.goHome", "a.showHome"]);
  assert.deepEqual(ids(filterCommands(ITEMS, "  go   tasks ")), ["a.goTasks"]);
  assert.deepEqual(ids(filterCommands(ITEMS, "home tasks")), ["a.showHome"]);
  assert.deepEqual(ids(filterCommands(ITEMS, "nothing")), []);
});

test("titles that start with the first term come first, otherwise the order is kept", () => {
  assert.deepEqual(ids(filterCommands(ITEMS, "show")), ["a.showHome"]);
  assert.deepEqual(ids(filterCommands(ITEMS, "s")), ["a.showHome", "a.focusNext", "a.goTasks"], "the prefix hit leads, the rest keep their order");
  assert.deepEqual(ids(filterCommands(ITEMS, "o home")), ["a.goHome", "a.showHome"], "no prefix hit: the order is kept");
  assert.deepEqual(ids(filterCommands(ITEMS, "TASKS go")), ["a.goTasks"], "the prefix rule reads the first term, any case");
});

test("the active option: arrows wrap, nothing selected starts at an end, other keys and an empty list do nothing", () => {
  assert.equal(paletteMove(3, 0, "ArrowDown"), 1);
  assert.equal(paletteMove(3, 2, "ArrowDown"), 0);
  assert.equal(paletteMove(3, 0, "ArrowUp"), 2);
  assert.equal(paletteMove(3, 1, "ArrowUp"), 0);
  assert.equal(paletteMove(3, -1, "ArrowDown"), 0);
  assert.equal(paletteMove(3, -1, "ArrowUp"), 2);
  assert.equal(paletteMove(3, 1, "Home"), undefined);
  assert.equal(paletteMove(0, 0, "ArrowDown"), undefined);
});

const press = (key: string, extra: Partial<PaletteKey> = {}): PaletteKey => ({ key, isComposing: false, keyCode: 0, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra });

test("palette keys: only an unmodified, first Enter runs; input-method keys do nothing, not even Escape (review SF1)", () => {
  assert.equal(paletteKeyAction(press("Enter")), "run");
  assert.equal(paletteKeyAction(press("Enter", { isComposing: true })), "none", "Enter that completes IME text");
  assert.equal(paletteKeyAction(press("Process")), "none", "Chromium's composition key");
  for (const key of ["Enter", "Escape", "ArrowDown", "ArrowUp", "Tab"]) {
    assert.equal(paletteKeyAction(press(key, { keyCode: 229 })), "none", `${key} with keyCode 229 and isComposing false (review 2 F1)`);
    assert.notEqual(paletteKeyAction(press(key, { keyCode: 228 })), "none", `${key}: only 229 is the input-method code`);
  }
  assert.equal(paletteKeyAction(press("Escape", { isComposing: true })), "none");
  assert.equal(paletteKeyAction(press("ArrowDown", { isComposing: true })), "none");
  assert.equal(paletteKeyAction(press("Enter", { repeat: true })), "swallow", "a held Enter never chooses");
  for (const m of ["ctrlKey", "metaKey", "altKey", "shiftKey"] as const) {
    assert.equal(paletteKeyAction(press("Enter", { [m]: true })), "none", `${m}+Enter is another chord`);
    assert.equal(paletteKeyAction(press("Escape", { [m]: true })), "none");
    assert.equal(paletteKeyAction(press("ArrowDown", { [m]: true })), "none");
  }
  assert.equal(paletteKeyAction(press("Escape")), "close");
  assert.equal(paletteKeyAction(press("Tab")), "hold");
  assert.equal(paletteKeyAction(press("Tab", { shiftKey: true })), "hold");
  assert.equal(paletteKeyAction(press("ArrowDown", { repeat: true })), "next", "arrows repeat on purpose");
  assert.equal(paletteKeyAction(press("ArrowUp")), "previous");
  assert.equal(paletteKeyAction(press("k")), "none");
});
