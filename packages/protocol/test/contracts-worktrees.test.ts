// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { worktreesMethods } from "../src/index.js";
import { WORKTREE_SAMPLES } from "./samples-worktrees.js";
import { accepts, errorText, parse, rejects, runSuite, schemaOf } from "./suite.js";

// Every axis.worktrees/1 schema is guarded like the newer contracts: accessors, Proxies, irregular arrays,
// forbidden keys and oversize input are refused, the result is a copy, and no error text echoes the input.
runSuite(WORKTREE_SAMPLES);

test("every worktrees method has both its schemas guarded (a bare strict schema echoes an unknown key)", () => {
  for (const [name, spec] of Object.entries(worktreesMethods)) {
    for (const side of ["request", "response"] as const) {
      const r = parse(spec[side], { CANARY_KEY_x: 1 }, `${name} ${side}`);
      assert.equal(r.success, false);
      assert.equal(errorText(r).includes("CANARY"), false, `${name} ${side} echoes an unknown key`);
    }
  }
});

test("ids start with a letter or a digit", () => {
  const status = schemaOf("axis.worktrees", "status", "request");
  const list = schemaOf("axis.worktrees", "list", "request");
  for (const id of ["-rf", "--", "-", "_x", "_", "-1"]) {
    rejects(status, { ids: [id] }, `workspace id ${id}`);
    rejects(list, { projectId: id }, `project id ${id}`);
  }
  for (const id of ["a", "0", "ws-1", "ws_1", "A".repeat(64)]) accepts(list, { projectId: id }, id);
  rejects(list, { projectId: "a".repeat(65) }, "65 characters");
  rejects(list, { projectId: "" }, "empty");
});
