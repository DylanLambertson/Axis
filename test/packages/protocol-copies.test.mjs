// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Checks over the BUILT packages that @axis/protocol cannot make itself (it may not depend on them): its copies of
// other packages' enums, and that the request digest the daemon computes for a registry method is the shared
// vector. `npm test` builds before it runs this.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { requestDigest } from "@axis/daemon";
import { RUN_STATES } from "@axis/journal";
import { RUN_STATUS_VALUES, RUN_STATE_VALUES, contracts, lookupMethod } from "@axis/protocol";
import { RUN_STATUSES } from "@axis/runs";
import { GIT_COMMIT_REFUSALS, GIT_PUSH_REFUSALS, REVIEW_DIFF_REFUSALS } from "@axis/protocol";

test("the protocol's run states are the journal's run states", () => {
  assert.deepEqual([...RUN_STATE_VALUES], [...RUN_STATES]);
});

test("the protocol's run statuses are the runs package's RUN_STATUSES", () => {
  assert.deepEqual([...RUN_STATUS_VALUES], [...RUN_STATUSES]);
});

test("@axis/protocol has no dependency on another @axis package (runtime, dev, peer or optional)", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../packages/protocol/package.json", import.meta.url), "utf8"));
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies"]) {
    const names = Array.isArray(pkg[field]) ? pkg[field] : Object.keys(pkg[field] ?? {});
    assert.deepEqual(names.filter((n) => n.startsWith("@axis/")), [], field);
  }
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ["zod"]);
});

test("the daemon's request digest reproduces the shared vectors (docs/packages.md 'Shared request digest')", () => {
  assert.equal(requestDigest("axis.worktrees/1", 1, "remove", { id: "ws-1", deleteBranch: false }), "ccb3a71aa0bc5bd6db5ccfe6fe9a09abef12092dce13ba4f6d99e929a30e0fd7");
  assert.equal(requestDigest("c", 1, "m", { b: [1, { z: null, y: true }], a: "x" }), "de8399306f850ad7498d82c8f95ec94ca317181b2422480425c52ad8ed55e596");
});

test("every registry method that needs approval has a pinned digest under its own contract id, method and version", () => {
  const pinned = new Map([
    // contract id, version, method -> digest of the payload below
    ["axis.worktrees/1#remove", "adb7a157e75395816cf74974fbdfa2b5bdf32831996a578ff80cdb46fe9d2735"],
    ["axis.git/1#push", "2ecb81c9079eaa3d3702f0cdb2b4c46e846306ac7cac7ad43938605541cf1747"],
  ]);
  const payloads = new Map([
    ["axis.worktrees/1#remove", { id: "ws-1", deleteBranch: false }],
    ["axis.git/1#push", { workspaceId: "ws-1", remote: "origin", confirmedPlan: { tip: "a".repeat(40), digest: "d".repeat(64) }, allowedBinaryPaths: ["assets/logo.png"] }],
  ]);
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

/** Every `reason` the two packages raise or report, with the error codes it is raised under (empty when it is not an error). */
function packageReasons() {
  const found = new Map();
  const add = (reason, code) => {
    const codes = found.get(reason) ?? new Set();
    if (code) codes.add(code);
    found.set(reason, codes);
  };
  const byHelper = { conflict: "E_CONFLICT", denied: "E_POLICY_DENIED", invalid: "E_INVALID_ARGUMENT" };
  for (const dir of ["git-ops", "review"]) {
    const root = new URL(`../../packages/${dir}/src/`, import.meta.url);
    for (const file of readdirSync(root).filter((f) => f.endsWith(".ts"))) {
      const lines = readFileSync(new URL(file, root), "utf8").split("\n");
      lines.forEach((line, i) => {
        // conflict(message, "reason"[, extra]) and the like
        for (const m of line.matchAll(/\b(conflict|denied|invalid)\(.*?,\s*"([a-z][a-z_]*)"\s*[,)]/g)) add(m[2], byHelper[m[1]]);
        // new GitOpsError("E_X", message, { reason: "..." }): the code is on this line or a few lines above in the same statement
        for (const m of line.matchAll(/\breason:\s*"([a-z][a-z_]*)"/g)) {
          let code;
          for (let j = i; j >= Math.max(0, i - 4) && code === undefined; j--) {
            if (j < i && /;\s*$/.test(lines[j])) break;
            code = /"(E_[A-Z_]+)"/.exec(lines[j])?.[1];
          }
          add(m[1], code);
        }
        if (/\bheadMoved\(/.test(line) && !/function headMoved/.test(line)) add("head_moved", "E_CONFLICT");
      });
    }
  }
  return found;
}

test("the closed-set refusal reasons of axis.git/1 and axis.review/1 are what the packages raise, with the same codes, in both directions", () => {
  const raised = packageReasons();
  const wire = new Map();
  for (const table of [GIT_COMMIT_REFUSALS, GIT_PUSH_REFUSALS, REVIEW_DIFF_REFUSALS]) {
    for (const [code, reasons] of Object.entries(table)) {
      for (const r of reasons) wire.set(r, new Set([...(wire.get(r) ?? []), code]));
    }
  }
  // Wire to packages: every listed reason exists, and is raised under the code the contract lists it under.
  for (const [reason, codes] of wire) {
    assert.ok(raised.has(reason), `no package raises "${reason}"`);
    for (const code of codes) assert.ok(raised.get(reason).has(code), `"${reason}" is not raised under ${code} by the packages`);
  }
  // Packages to wire: everything a package raises or reports is on the wire or named here as not on it, with the reason why.
  const NOT_ON_THE_WIRE = {
    not_a_commit: "diff has no `against` field",
    no_hunks: "no hunk API on the wire",
    too_large_to_review: "a SkippedFile reason, not a refusal",
    binary: "a per-file label (fileLevelReason), not a refusal",
    malformed: "a per-file label (fileLevelReason), not a refusal",
    too_many_hunks: "a per-file label (fileLevelReason), not a refusal",
  };
  for (const reason of raised.keys()) {
    assert.ok(wire.has(reason) || Object.hasOwn(NOT_ON_THE_WIRE, reason), `the packages raise "${reason}", which is neither on the wire nor listed as off it`);
  }
  for (const reason of Object.keys(NOT_ON_THE_WIRE)) assert.ok(raised.has(reason), `"${reason}" is listed as off the wire but no package uses it`);
  for (const reason of Object.keys(NOT_ON_THE_WIRE)) assert.equal(wire.has(reason), false, `"${reason}" is both on and off the wire`);
});
