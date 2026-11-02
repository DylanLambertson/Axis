// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as protocol from "@axis/protocol";
import { AxisError, ERROR_CODES } from "../src/index.js";

test("the error code set is the protocol's own, not a copy", () => {
  assert.equal(ERROR_CODES, protocol.ERROR_CODES);
});

test("every code constructs an AxisError whose wire form passes the protocol schema", () => {
  for (const code of ERROR_CODES) {
    // The protocol requires a challenge in the details of this one; it is exercised below.
    if (code === "E_APPROVAL_REQUIRED") continue;
    const wire = new AxisError(code, "message", { n: 1 }).toWire("corr-1");
    assert.deepEqual(protocol.errorSchema.parse(wire).code, code);
    assert.equal(wire.retryable, protocol.RETRYABLE_CODES.has(code));
  }
});

test("a detail-free error has no details field on the wire", () => {
  assert.equal("details" in new AxisError("E_INTERNAL", "x").toWire("c"), false);
});

test("E_APPROVAL_REQUIRED without a challenge is refused by the protocol schema, so callers must not use toWire for it", () => {
  const wire = new AxisError("E_APPROVAL_REQUIRED", "needs approval").toWire("c");
  assert.equal(protocol.errorSchema.safeParse(wire).success, false);
});
