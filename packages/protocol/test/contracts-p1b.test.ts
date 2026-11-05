// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GIT_COMMIT_REASONS, MAX_ALLOWED_BINARY_PATHS, MAX_COMMIT_MESSAGE, MAX_PUSH_FINDINGS, MAX_REVIEW_FILES, MAX_REVIEW_SKIPPED, contracts, lookupMethod, requiresIdempotencyKey, tableProblems } from "../src/index.js";
import { DIGEST, SHA1, SHA2, SHA3, completed, diffResponse, file, plan, P1B_SAMPLES } from "./samples-p1b.js";
import { accepts, rejects, runSuite, schemaOf } from "./suite.js";

runSuite(P1B_SAMPLES);

const G = "axis.git";
const R = "axis.review";
const commitReq = (patch: Record<string, unknown> = {}) => ({ workspaceId: "ws-1", reviewedTreeHash: SHA2, expectedParent: SHA1, expectedBranch: "axis/fix-it", message: "m", ...patch });
const pushReq = (patch: Record<string, unknown> = {}) => ({ workspaceId: "ws-1", remote: "origin", confirmedPlan: { tip: SHA1, digest: DIGEST }, ...patch });

test("registry: tiers, side effects, idempotency, as in the design table", () => {
  const expect: Array<[string, string, number, string, string]> = [
    [G, "pushPlan", 1, "read", "none"],
    [G, "commit", 2, "write", "required"],
    [G, "push", 4, "network", "required"],
    [G, "compareUrl", 0, "read", "none"],
    [R, "diff", 1, "read", "none"],
    [R, "complete", 2, "write", "required"],
  ];
  for (const [c, m, tier, sideEffect, idem] of expect) {
    const spec = lookupMethod(c, 1, m);
    assert.ok(spec, `${c}.${m}`);
    assert.equal(spec.tier, tier, `${c}.${m} tier`);
    assert.equal(spec.sideEffect, sideEffect);
    assert.equal(spec.idempotency, idem);
    assert.equal(requiresIdempotencyKey(c, 1, m), idem === "required");
    assert.equal(Object.isFrozen(spec), true);
  }
  assert.deepEqual(Object.keys(contracts["axis.git/1"] ?? {}).sort(), ["commit", "compareUrl", "push", "pushPlan"]);
  assert.deepEqual(Object.keys(contracts["axis.review/1"] ?? {}).sort(), ["complete", "diff"]);
  assert.deepEqual(tableProblems(contracts), []);
});

test("the old names are not served: commit and push are not worktrees methods", () => {
  assert.equal(lookupMethod("axis.worktrees", 1, "commit"), undefined);
  assert.equal(lookupMethod("axis.worktrees", 1, "push"), undefined);
  assert.equal(lookupMethod(G, 2, "push"), undefined);
});

test("git.commit request: the reviewed tree, parent and branch are all required", () => {
  const req = schemaOf(G, "commit", "request");
  accepts(req, commitReq(), "minimal");
  for (const k of ["reviewedTreeHash", "expectedParent", "expectedBranch", "message", "workspaceId"]) {
    const { [k]: _gone, ...rest } = commitReq() as Record<string, unknown>;
    rejects(req, rest, `${k} missing`);
  }
  for (const k of ["path", "paths", "cwd", "branch", "parent", "env", "args", "flags", "amend", "noVerify", "approval", "actor", "gitDir", "worktree", "sign"]) {
    rejects(req, commitReq({ [k]: "x" }), `unknown key ${k}`);
  }
  for (const bad of ["", "A".repeat(40), "a".repeat(39), "a".repeat(41), "a".repeat(63), "g".repeat(40), `${"a".repeat(39)}\n`, "HEAD", "main", "../x", "-x", 1, null]) {
    rejects(req, commitReq({ reviewedTreeHash: bad }), `tree ${JSON.stringify(bad)}`);
    rejects(req, commitReq({ expectedParent: bad }), `parent ${JSON.stringify(bad)}`);
  }
  for (const bad of ["main", "refs/heads/axis/x", "axis/", "axis/-x", "axis/x-", "axis/X", "axis/a/b", "axis/a b", "axis/..", "AXIS/x", "-axis/x", `axis/${"a".repeat(65)}`, null, 1, "axis/x\n"]) {
    rejects(req, commitReq({ expectedBranch: bad }), `branch ${JSON.stringify(bad)}`);
  }
  accepts(req, commitReq({ expectedBranch: `axis/${"a".repeat(64)}` }), "slug of 64");
});

test("git.commit message: non-empty text up to 64 KiB, no NUL, no lone surrogate", () => {
  const req = schemaOf(G, "commit", "request");
  accepts(req, commitReq({ message: "a".repeat(MAX_COMMIT_MESSAGE) }), "at the cap");
  accepts(req, commitReq({ message: "line one\n\n\tindented \u{1F600} \u00e9" }), "multi-line unicode");
  for (const m of ["", "   ", "\n\t", "a".repeat(MAX_COMMIT_MESSAGE + 1), "a\0b", "\ud800", "a\udc00b", 1, null, ["a"], {}]) {
    rejects(req, commitReq({ message: m }), `message ${typeof m === "string" ? JSON.stringify(m.slice(0, 20)) : String(m)}`);
  }
});

test("git.commit author: a name and email to compare, never a git option", () => {
  const req = schemaOf(G, "commit", "request");
  accepts(req, commitReq({ author: { name: "A B", email: "a@b.dev" } }), "author");
  for (const author of [{}, { name: "A" }, { email: "a@b.dev" }, { name: "", email: "a@b.dev" }, { name: "A\nB", email: "a@b.dev" }, { name: "A <x>", email: "a@b.dev" }, { name: "A", email: "a b@c" }, { name: "A", email: "a@b>" }, { name: "A", email: "a@b.dev", date: "now" }, { name: "x".repeat(257), email: "a@b" }, { name: "A", email: `${"x".repeat(321)}` }, null, "A <a@b>"]) {
    rejects(req, commitReq({ author }), JSON.stringify(author));
  }
});

test("git.push: always a confirmed plan; approval is optional; no branch, base or URL", () => {
  const req = schemaOf(G, "push", "request");
  accepts(req, pushReq(), "first request");
  accepts(req, pushReq({ approval: { challengeId: "A".repeat(22) } }), "retry");
  rejects(req, { workspaceId: "ws-1", remote: "origin" }, "no confirmed plan");
  rejects(req, pushReq({ confirmedPlan: { tip: SHA1 } }), "plan without digest");
  rejects(req, pushReq({ confirmedPlan: { digest: DIGEST } }), "plan without tip");
  rejects(req, pushReq({ confirmedPlan: { tip: SHA1, digest: DIGEST, extra: 1 } }), "plan extra key");
  rejects(req, pushReq({ confirmedPlan: { tip: SHA1, digest: "D".repeat(64) } }), "upper-case digest");
  rejects(req, pushReq({ confirmedPlan: { tip: SHA1, digest: "d".repeat(63) } }), "short digest");
  for (const k of ["branch", "baseSha", "base", "url", "remoteUrl", "refspec", "force", "forceWithLease", "tags", "delete", "confirmed", "noVerify", "path", "cwd", "env", "args", "actor", "digest"]) {
    rejects(req, pushReq({ [k]: "x" }), `unknown key ${k}`);
  }
  for (const remote of ["", "-x", "--upload-pack=evil", "https://evil.example/r.git", "git@github.com:o/r.git", "../x", "a b", "a/b", "a;b", "a\nb", "x".repeat(65), ".hidden", 1, null]) {
    rejects(req, pushReq({ remote }), `remote ${JSON.stringify(remote)}`);
  }
  accepts(req, pushReq({ remote: "up.stream_1-b" }), "dotted remote name");
  rejects(req, pushReq({ approval: { challengeId: "short" } }), "bad approval id");
  rejects(req, pushReq({ approval: { challengeId: "A".repeat(43), actor: "agent:x" } }), "approval extra key");
});

test("push and pushPlan allowedBinaryPaths: relative paths only, bounded", () => {
  for (const [method, make] of [["push", pushReq], ["pushPlan", (p: Record<string, unknown>) => ({ workspaceId: "ws-1", remote: "origin", ...p })]] as const) {
    const req = schemaOf(G, method, "request");
    accepts(req, make({ allowedBinaryPaths: [] }), `${method} empty`);
    accepts(req, make({ allowedBinaryPaths: Array.from({ length: MAX_ALLOWED_BINARY_PATHS }, (_, i) => `a/${i}.png`) }), `${method} at cap`);
    rejects(req, make({ allowedBinaryPaths: Array.from({ length: MAX_ALLOWED_BINARY_PATHS + 1 }, (_, i) => `a/${i}.png`) }), `${method} over cap`);
    for (const p of ["/etc/passwd", "../x", "a/../b", ".git/config", "a/.GIT/x", ":(top)x", "-x", "a\\b", "", "a\nb", "C:\\x", 1, null]) {
      rejects(req, make({ allowedBinaryPaths: [p] }), `${method} ${JSON.stringify(p)}`);
    }
  }
});

test("git.pushPlan response: rule names and paths only, never matched text", () => {
  const res = schemaOf(G, "pushPlan", "response");
  for (const k of ["match", "matched", "text", "secret", "snippet", "content", "value", "diff", "command", "refspec", "argv", "env", "path", "worktree"]) {
    rejects(res, { ...plan, [k]: "x" }, `plan key ${k}`);
    rejects(res, { ...plan, findings: [{ rule: "aws-access", [k === "path" ? "pathx" : k]: "AKIAFAKE" }] }, `finding key ${k}`);
  }
  accepts(res, { ...plan, findings: [{ rule: "a.b_c-1" }] }, "rule charset");
  for (const rule of ["", "a b", "a/b", "x".repeat(65), "AKIA\n", "a:b", 1, null]) rejects(res, { ...plan, findings: [{ rule }] }, `rule ${JSON.stringify(rule)}`);
  for (const path of ["a\nb", "a\u202eb", "a\u0000b", "x".repeat(257), 1]) rejects(res, { ...plan, findings: [{ rule: "r", path }] }, `path ${JSON.stringify(path).slice(0, 20)}`);
  rejects(res, { ...plan, findings: [{ rule: "r", line: -1 }] }, "negative line");
  rejects(res, { ...plan, findings: [{ rule: "r", line: 1.5 }] }, "fractional line");
  rejects(res, { ...plan, findings: [{ rule: "r", commit: "abc" }] }, "short commit");
});

test("git.pushPlan response: bounds, and confirmation matches its reasons", () => {
  const res = schemaOf(G, "pushPlan", "response");
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ rule: "r", path: `p${i}`, line: i }));
  accepts(res, { ...plan, findings: many(MAX_PUSH_FINDINGS), findingsTruncated: true }, "full and truncated");
  rejects(res, { ...plan, findings: many(MAX_PUSH_FINDINGS + 1) }, "over the cap");
  rejects(res, { ...plan, findings: many(3), findingsTruncated: true }, "truncated but short");
  rejects(res, { ...plan, reasons: [] }, "confirmation without a reason");
  rejects(res, { ...plan, requiresConfirmation: false }, "a reason without confirmation");
  rejects(res, { ...plan, reasons: Array.from({ length: 9 }, () => "r") }, "nine reasons");
  rejects(res, { ...plan, reasons: ["x".repeat(1025)] }, "long reason");
  rejects(res, { ...plan, reasons: ["a\nb"] }, "control in a reason");
  rejects(res, { ...plan, branch: "main" }, "not an axis branch");
  rejects(res, { ...plan, digest: "x" }, "digest");
});

test("git.compareUrl: names a remote and a base, returns an https GitHub-shaped URL", () => {
  const req = schemaOf(G, "compareUrl", "request");
  const res = schemaOf(G, "compareUrl", "response");
  for (const k of ["remoteUrl", "url", "head", "allowedHosts", "host", "branch"]) rejects(req, { workspaceId: "ws-1", remote: "origin", [k]: "x" }, k);
  for (const base of ["-x", "a b", "a..b", "@{u}", "", "x".repeat(257), "a:b", "a\nb"]) rejects(req, { workspaceId: "ws-1", remote: "origin", base }, `base ${JSON.stringify(base)}`);
  accepts(req, { workspaceId: "ws-1", remote: "origin", base: "release/1.2" }, "base with slash");
  accepts(res, { url: "https://ghe.example.com/o/r.x/compare/release%2F1...axis/fix-it" }, "enterprise host");
  for (const url of ["http://github.com/o/r/compare/a...b", "javascript:alert(1)", "https://github.com/o/r/compare/a...b?x=1", "https://github.com/o/r/compare/a...b#f", "https://user@github.com/o/r/compare/a...b", "https://github.com/o/r/compare/a b...c", "https://github.com/o/r/compare/a...b\n", "https://github.com:8443/o/r/compare/a...b", "https://github.com/o/r/pull/1", "https://github.com/o/r/compare/a...b/..", `https://github.com/o/r/compare/${"a".repeat(2100)}...b`, "", 1]) {
    rejects(res, { url }, JSON.stringify(url).slice(0, 40));
  }
});

test("review.diff request and response", () => {
  const req = schemaOf(R, "diff", "request");
  const res = schemaOf(R, "diff", "response");
  accepts(req, { workspaceId: "ws-1" }, "workspace");
  for (const k of ["path", "paths", "against", "base", "worktree", "limit", "head"]) rejects(req, { workspaceId: "ws-1", [k]: "x" }, k);
  for (const w of ["", "../x", "a/b", 1, null, undefined]) rejects(req, { workspaceId: w }, JSON.stringify(w));
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...structuredClone(file), displayPath: `f${i}` }));
  accepts(res, { ...diffResponse, files: many(MAX_REVIEW_FILES) }, "full list");
  rejects(res, { ...diffResponse, files: many(MAX_REVIEW_FILES + 1) }, "one too many files");
  rejects(res, { ...diffResponse, skipped: Array.from({ length: MAX_REVIEW_SKIPPED + 1 }, () => diffResponse.skipped[0]) }, "too many skipped");
  for (const k of ["path", "oldPath", "newOid", "oldOid", "oldMode", "newMode", "link"]) rejects(res, { ...diffResponse, files: [{ ...file, [k]: "x" }] }, `file key ${k}`);
  for (const k of ["worktree", "gitDir", "path", "reviewedTree", "digest"]) rejects(res, { ...diffResponse, [k]: "x" }, `response key ${k}`);
  for (const status of ["X", "m", "", "MM", null]) rejects(res, { ...diffResponse, files: [{ ...file, status }] }, `status ${String(status)}`);
  for (const kind of ["Text", "other", "", null]) rejects(res, { ...diffResponse, files: [{ ...file, kind }] }, `kind ${String(kind)}`);
  for (const kind of ["text", "binary", "symlink", "submodule", "too-large", "filtered"]) accepts(res, { ...diffResponse, files: [{ ...file, kind }] }, kind);
  for (const displayPath of ["a\nb", "a\u202eb", "x".repeat(257)]) rejects(res, { ...diffResponse, files: [{ ...file, displayPath }] }, JSON.stringify(displayPath).slice(0, 20));
  rejects(res, { ...diffResponse, files: [{ ...file, protectedRules: ["a", "b", "c", "d", "e"] }] }, "five rules");
  rejects(res, { ...diffResponse, files: [{ ...file, similarity: 101 }] }, "similarity");
  rejects(res, { ...diffResponse, head: "main" }, "head");
  rejects(res, { ...diffResponse, branch: "refs/heads/axis/x" }, "full ref");
  rejects(res, { ...diffResponse, skipped: [{ ...diffResponse.skipped[0], reason: "other" }] }, "skipped reason");
  accepts(res, { ...diffResponse, treeHash: SHA3 }, "sha-256 tree");
});

test("review.complete: a run id in, a COMPLETED run out, and no actor in the request", () => {
  const req = schemaOf(R, "complete", "request");
  const res = schemaOf(R, "complete", "response");
  accepts(req, { runId: "run-1" }, "run id");
  for (const k of ["actor", "principal", "user", "userPrincipal", "approvedByUser", "state", "workspaceId", "approval", "force"]) rejects(req, { runId: "run-1", [k]: "x" }, k);
  for (const runId of ["", "../x", 1, null]) rejects(req, { runId }, JSON.stringify(runId));
  accepts(res, { run: completed }, "completed");
  for (const state of ["REVIEWING", "RUNNING", "FAILED", "CANCELLED"]) rejects(res, { run: { ...completed, state } }, state);
});

test("the git commit reasons are the ones the packages use and are a closed set", () => {
  assert.deepEqual([...GIT_COMMIT_REASONS].sort(), ["detached_head", "head_moved", "index_changed", "no_head", "operation_in_progress", "ref_update_failed", "stale"]);
});
