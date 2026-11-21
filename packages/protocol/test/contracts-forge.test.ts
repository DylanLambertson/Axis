// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.forge/1 (PV-D2): planned, not served; the shared forge-list wire schemas; the one owner and repository check.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contracts,
  forgeListRequestSchema,
  forgeMethods,
  forgeReplySchema,
  lookupMethod,
  lookupMethodIn,
  plannedContracts,
  vetOwnerRepo,
} from "../src/index.js";

test("axis.forge/1 is planned, never served, with the designed method table", () => {
  assert.equal(contracts["axis.forge/1"], undefined);
  assert.equal(lookupMethod("axis.forge", 1, "pullRequests"), undefined);
  assert.equal(lookupMethodIn(plannedContracts, "axis.forge", 1, "pullRequests"), forgeMethods.pullRequests);
  assert.deepEqual(
    Object.entries(forgeMethods).map(([m, s]) => [m, s.sideEffect, s.tier, s.idempotency]),
    [["pullRequests", "read", 0, "none"], ["pinRepository", "write", 1, "none"]],
  );
});

test("vetOwnerRepo: the GitHub owner and repository patterns, never . or ..", () => {
  for (const [o, r] of [["acme", "app"], ["a", "a.b_c-d"], ["A-1", ".github"], ["x".repeat(39), "r".repeat(100)]]) assert.equal(vetOwnerRepo(o, r), true, `${o}/${r}`);
  const bad: [unknown, unknown][] = [["acme", "."], ["acme", ".."], ["-acme", "app"], ["acme", ""], ["", "app"], ["x".repeat(40), "app"], ["acme", "r".repeat(101)], ["ac me", "app"], ["acme", "a/b"], ["acme", "a‮"], [1, "app"], ["acme", null]];
  for (const [o, r] of bad) assert.equal(vetOwnerRepo(o, r), false, `${String(o)}/${String(r)}`);
});

test("the forge-list request carries a vetted repository on github.com and nothing else", () => {
  const ok = { t: "forge-list", req: "r1", host: "github.com", owner: "acme", repo: "app" };
  assert.equal(forgeListRequestSchema.safeParse(ok).success, true);
  for (const bad of [{ ...ok, host: "gitlab.com" }, { ...ok, repo: ".." }, { ...ok, owner: "--upload-pack" }, { ...ok, argv: ["x"] }, { ...ok, env: {} }, { ...ok, req: "r 1" }]) {
    assert.equal(forgeListRequestSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("the forge replies are closed: known classes and codes only, no extra field, bounded stdout", () => {
  const res = { t: "forge-result", req: "r1", exit: 0, class: "none", stdout: "[]", truncated: false };
  assert.equal(forgeReplySchema.safeParse(res).success, true);
  assert.equal(forgeReplySchema.safeParse({ t: "forge-failed", req: "r1", code: "timeout" }).success, true);
  for (const bad of [{ ...res, class: "stderr text" }, { ...res, stderr: "x" }, { ...res, exit: 256 }, { ...res, stdout: "x".repeat(4 * 1024 * 1024 + 1) }, { t: "forge-failed", req: "r1", code: "ENOENT" }, { t: "forge-failed", req: "r1", code: "timeout", detail: "x" }]) {
    assert.equal(forgeReplySchema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80));
  }
});
