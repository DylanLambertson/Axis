// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Checks over the BUILT packages that @axis/protocol cannot make itself (it may not depend on them): its copies of
// other packages' enums, and that the request digest the daemon computes for a registry method is the shared
// vector. `npm test` builds before it runs this.
import { test } from "node:test";
import assert from "node:assert/strict";
import { requestDigest } from "@axis/daemon";
import { RUN_STATES } from "@axis/journal";
import { RUN_STATE_VALUES, contracts, lookupMethod } from "@axis/protocol";

test("the protocol's run states are the journal's run states", () => {
  assert.deepEqual([...RUN_STATE_VALUES], [...RUN_STATES]);
});

test("the daemon's request digest reproduces the shared vectors (docs/packages.md 'Shared request digest')", () => {
  assert.equal(requestDigest("axis.worktrees/1", 1, "remove", { id: "ws-1", deleteBranch: false }), "ccb3a71aa0bc5bd6db5ccfe6fe9a09abef12092dce13ba4f6d99e929a30e0fd7");
  assert.equal(requestDigest("c", 1, "m", { b: [1, { z: null, y: true }], a: "x" }), "de8399306f850ad7498d82c8f95ec94ca317181b2422480425c52ad8ed55e596");
});

test("every registry method that needs approval has a pinned digest under its own contract id, method and version", () => {
  const pinned = new Map([
    // contract id, version, method -> digest of the payload below
    ["axis.worktrees/1#remove", "adb7a157e75395816cf74974fbdfa2b5bdf32831996a578ff80cdb46fe9d2735"],
  ]);
  const payloads = new Map([["axis.worktrees/1#remove", { id: "ws-1", deleteBranch: false }]]);
  const needing = [];
  for (const [key, methods] of Object.entries(contracts)) {
    const at = key.lastIndexOf("/");
    const contract = key.slice(0, at);
    const version = Number(key.slice(at + 1));
    for (const [method, spec] of Object.entries(methods)) {
      assert.equal(lookupMethod(contract, version, method), spec);
      if (spec.tier >= 3) needing.push(`${key}#${method}`);
    }
  }
  // A new tier 3+ method must come with a vector here, or this fails.
  assert.deepEqual(needing.sort(), [...pinned.keys()].sort());
  for (const key of needing) {
    const [contractVersion, method] = key.split("#");
    const at = contractVersion.lastIndexOf("/");
    const digest = requestDigest(contractVersion.slice(0, at), Number(contractVersion.slice(at + 1)), method, payloads.get(key));
    assert.equal(digest, pinned.get(key), key);
    // `approval` is not part of the digest, so the retry digests the same as the first request.
    const retry = { ...payloads.get(key), approval: { challengeId: "A".repeat(22) } };
    assert.equal(requestDigest(contractVersion.slice(0, at), Number(contractVersion.slice(at + 1)), method, retry), digest);
  }
});
