// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/index.js";

test("the empty package exports only its API version", () => {
  assert.deepEqual(Object.keys(core), ["SHELL_CORE_API_VERSION"]);
  assert.equal(core.SHELL_CORE_API_VERSION, 0);
});
