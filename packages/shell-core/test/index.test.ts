// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/index.js";

test("the package exports the ported API at version 1, and no test support", () => {
  assert.equal(core.SHELL_CORE_API_VERSION, 1);
  for (const name of ["AxisSnapshotLoader", "AxisDaemonApi", "AxisViewState", "approvalShortcutAllowed", "daemonNotice", "trustSource", "localize", "Emitter", "DisposableStore"]) {
    assert.equal(typeof (core as Record<string, unknown>)[name], "function", name);
  }
  for (const name of ["ensureNoDisposablesAreLeakedInTestSuite", "leakTracker"]) {
    assert.equal(name in core, false, `${name} is test support`);
  }
});
