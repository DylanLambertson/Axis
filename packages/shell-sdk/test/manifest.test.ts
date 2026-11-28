// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as sdk from "../src/index.js";
import type { ModuleManifest } from "../src/index.js";

test("the typed shell exports only its API version at run time; the manifest is a type", () => {
  assert.deepEqual(Object.keys(sdk), ["SHELL_SDK_API_VERSION"]);
  assert.equal(sdk.SHELL_SDK_API_VERSION, 0);
  const m: ModuleManifest = { id: "axis.changes", manifestVersion: 1 };
  assert.equal(m.manifestVersion, 1);
});
