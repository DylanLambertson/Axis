// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNodeRunner } from "../src/index.js";
import { fixture } from "./realFixture.js";

test("RR-N4: the node runner reports truncated when stdout passes its limit, and not otherwise", async () => {
  const f = fixture();
  const req = { argv: ["var", "-l"], cwd: f.wt.workTree, env: { PATH: process.env["PATH"] ?? "", HOME: f.home }, context: "pty" as const };
  const small = await createNodeRunner({ allowPtyContext: true, maxOutput: 40 }).run(req);
  assert.equal(small.truncated, true);
  assert.equal(small.stdout.length, 40);
  const big = await createNodeRunner({ allowPtyContext: true }).run(req);
  assert.equal(big.truncated, undefined);
  assert.ok(big.stdout.length > 40);
});
