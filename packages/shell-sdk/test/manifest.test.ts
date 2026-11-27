// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModule, manifestProblems } from "../src/index.js";

test("a valid manifest is returned frozen and copied", () => {
  const input = { id: "axis.changes", manifestVersion: 1 as const };
  const m = defineModule(input);
  assert.deepEqual(m, input);
  assert.notEqual(m, input);
  assert.ok(Object.isFrozen(m));
  assert.deepEqual(manifestProblems({ id: "terminal", manifestVersion: 1 }), []);
  assert.deepEqual(manifestProblems({ id: "a".repeat(64), manifestVersion: 1 }), []);
});

test("ids: lower-case words joined by single dots or hyphens, at most 64 characters", () => {
  for (const id of ["Axis.changes", "axis..changes", "axis.", ".axis", "1axis", "axis changes", "axis/changes", "", "a".repeat(65), "axis.-x", "axis_x"]) {
    assert.deepEqual(manifestProblems({ id, manifestVersion: 1 }), ["id is not a module id"], id);
  }
  assert.deepEqual(manifestProblems({ id: 7, manifestVersion: 1 }), ["id is not a module id"]);
});

test("the version, unknown fields and non-objects are refused, all problems at once, never a throw", () => {
  assert.deepEqual(manifestProblems({ id: "axis", manifestVersion: 2 }), ["manifestVersion is not 1"]);
  assert.deepEqual(manifestProblems({ id: "axis", manifestVersion: "1" }), ["manifestVersion is not 1"]);
  assert.deepEqual(manifestProblems({ id: "axis" }), ["manifestVersion is not 1"]);
  assert.deepEqual(manifestProblems({ id: "X", manifestVersion: 1, z: 1, main: "x" }), ["unknown fields: main, z", "id is not a module id"]);
  for (const v of [null, undefined, 1, "axis", [], () => 0]) assert.deepEqual(manifestProblems(v), ["the manifest is not an object"], String(v));
  assert.throws(() => defineModule({ id: "Bad", manifestVersion: 1 }), /invalid module manifest: id is not a module id/);
});
