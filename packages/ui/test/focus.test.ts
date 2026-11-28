// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRegion, nextRegionIndex, rovingIndex } from "../src/index.js";

const REGIONS = ["top", "nav", "main", "side"];

test("F6 cycles forward and wraps; Shift+F6 cycles back and wraps", () => {
  assert.equal(nextRegion(REGIONS, "top", false), "nav");
  assert.equal(nextRegion(REGIONS, "side", false), "top");
  assert.equal(nextRegion(REGIONS, "nav", true), "top");
  assert.equal(nextRegion(REGIONS, "top", true), "side");
});

test("from no region or an unknown one, F6 goes to the first and Shift+F6 to the last; none is undefined", () => {
  assert.equal(nextRegion(REGIONS, undefined, false), "top");
  assert.equal(nextRegion(REGIONS, "elsewhere", true), "side");
  assert.equal(nextRegion([], "top", false), undefined);
  assert.equal(nextRegion(["only"], "only", false), "only");
});

test("by index: duplicate names do not trap focus, and an index out of range starts over", () => {
  assert.equal(nextRegionIndex(3, 1, false), 2, "the second of two same-named regions moves on");
  assert.equal(nextRegionIndex(3, 2, false), 0);
  assert.equal(nextRegionIndex(3, 0, true), 2);
  assert.equal(nextRegionIndex(3, 2, true), 1);
  assert.equal(nextRegionIndex(3, -1, false), 0);
  assert.equal(nextRegionIndex(3, -1, true), 2);
  assert.equal(nextRegionIndex(3, 3, false), 0);
  assert.equal(nextRegionIndex(3, 7, true), 2);
  assert.equal(nextRegionIndex(0, 0, false), undefined);
  assert.equal(nextRegionIndex(1, 0, false), 0);
});

test("roving index: arrows step and stop at the ends, Home and End jump, other keys are not handled", () => {
  assert.equal(rovingIndex(4, 1, "ArrowDown"), 2);
  assert.equal(rovingIndex(4, 3, "ArrowDown"), 3);
  assert.equal(rovingIndex(4, 0, "ArrowUp"), 0);
  assert.equal(rovingIndex(4, 2, "Home"), 0);
  assert.equal(rovingIndex(4, 0, "End"), 3);
  assert.equal(rovingIndex(4, 1, "ArrowRight"), undefined, "the other orientation");
  assert.equal(rovingIndex(4, 1, "ArrowRight", "horizontal"), 2);
  assert.equal(rovingIndex(4, 1, "ArrowLeft", "horizontal"), 0);
  assert.equal(rovingIndex(4, 1, "Enter"), undefined);
  assert.equal(rovingIndex(0, 0, "ArrowDown"), undefined);
  assert.equal(rovingIndex(4, 9, "ArrowUp"), 2, "an out-of-range current is clamped first");
});
