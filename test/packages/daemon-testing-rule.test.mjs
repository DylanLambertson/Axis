// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RESTRICTED_MODULES } from "../../scripts/code-oss/stage-scan.mjs";
import { daemonTestingVerdict } from "./daemon-testing-rule.mjs";

test("@axis/daemon/testing: refused in shipped code, allowed in tests and test support", () => {
  assert.notEqual(daemonTestingVerdict("@axis/daemon/testing", true), null);
  assert.notEqual(daemonTestingVerdict("@axis/daemon/testing/x", true), null);
  assert.equal(daemonTestingVerdict("@axis/daemon/testing", false), null);
  for (const other of ["@axis/daemon", "@axis/daemon/testings", "@axis/journal/testing"]) assert.equal(daemonTestingVerdict(other, true), null, other);
});

test("the staged-tree scan keeps daemon/testing.ts out of every staged tree", () => {
  const rows = RESTRICTED_MODULES.filter((m) => m.pkg === "daemon" && m.file === "testing.ts");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].importers.size, 0);
  assert.equal(rows[0].files.size, 0);
});
