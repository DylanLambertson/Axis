// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterCommands, paletteMove } from "../src/index.js";

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
