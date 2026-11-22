// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectTrustVerdict } from "./project-trust-rule.mjs";

test("project trust: only the composition builds a gate, only the gate modules reach the ticket, only the root loads the helper (review S1b A SF1)", () => {
  assert.equal(projectTrustVerdict("src/gate/project-trust-gate.ts", "src/compose-serving.ts"), null, "the composition builds the gate");
  for (const from of ["src/handlers/git.ts", "src/compose-parts.ts", "src/gate/run-trust.ts", "src/index.ts", "src/compose.ts", "src/bindings/worktrees.ts"]) {
    assert.notEqual(projectTrustVerdict("src/gate/project-trust-gate.js", from), null, `${from} may not build a gate`);
  }
  assert.equal(projectTrustVerdict("src/gate/project-ticket", "src/gate/project-trust.ts"), null);
  assert.equal(projectTrustVerdict("src/gate/project-ticket.ts", "src/gate/project-trust-gate.ts"), null);
  for (const from of ["src/bindings/git.ts", "src/worktrees/service.ts", "src/compose-serving.ts"]) {
    assert.notEqual(projectTrustVerdict("src/gate/project-ticket.js", from), null, `${from} may not reach the ticket's state`);
  }
  assert.equal(projectTrustVerdict("src/compose-serving.ts", "src/compose.ts"), null);
  assert.notEqual(projectTrustVerdict("src/compose-serving.js", "src/compose-parts.ts"), null);
  assert.equal(projectTrustVerdict("src/gate/project-trust-gate.ts", "testing/open-gate.ts"), null, "the test rigs may build one");
  assert.equal(projectTrustVerdict("src/gate/project-trust.ts", "src/handlers/git.ts"), null, "consumeTicket and projectGated stay open to handlers and ports");
});
