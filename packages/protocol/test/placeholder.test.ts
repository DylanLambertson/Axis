// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_PLACEHOLDER } from "../src/index.js";

test("scaffold builds and runs", () => {
  assert.equal(PROTOCOL_PLACEHOLDER, 0);
});
