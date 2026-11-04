// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AxisError, canonicalize } from "../src/index.js";

test("keys are sorted at every level and output has no whitespace", () => {
  assert.equal(canonicalize({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
});

test("equal data in different insertion order canonicalises identically", () => {
  assert.equal(canonicalize({ x: 1, y: 2 }), canonicalize({ y: 2, x: 1 }));
});

test("values JSON cannot represent exactly are rejected", () => {
  const circular: Record<string, unknown> = {};
  circular["me"] = circular;
  for (const bad of [undefined, Number.NaN, Infinity, 1n, () => 1, Symbol("s"), circular, new Date(), { a: undefined }]) {
    assert.throws(
      () => canonicalize(bad),
      (e: unknown) => e instanceof AxisError && e.code === "E_INVALID_ARGUMENT",
    );
  }
});
