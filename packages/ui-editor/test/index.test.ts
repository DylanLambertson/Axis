// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as editor from "../src/index.js";

test("the empty package exports only its API version", () => {
  assert.deepEqual(Object.keys(editor), ["UI_EDITOR_API_VERSION"]);
  assert.equal(editor.UI_EDITOR_API_VERSION, 0);
});
