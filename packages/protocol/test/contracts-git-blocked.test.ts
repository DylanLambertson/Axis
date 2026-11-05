// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GIT_PUSH_BLOCKS, GIT_PUSH_REASONS, GIT_PUSH_REFUSALS, MAX_ALLOWED_BINARY_PATHS, MAX_BLOCKED_BINARY_PATHS, gitPushReasonSchema } from "../src/index.js";
import { DIGEST, SHA1, plan } from "./samples-p1b.js";
import { accepts, rejects, schemaOf } from "./suite.js";

const G = "axis.git";
/** A plan the scan blocks: nothing to confirm, the closed reason and the binary paths still to allow. */
const blocked = (patch: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  ...plan,
  requiresConfirmation: false,
  reasons: [],
  blocked: { reason: "binary_unscanned", binaryPaths: ["img/logo.png"], binaryPathsTruncated: false, ...patch },
  ...over,
});

test("push refusals: the four scan blocks and git_drift are closed reasons of E_CONFLICT, beside plan_changed", () => {
  assert.deepEqual([...GIT_PUSH_BLOCKS], ["message_unscannable", "secrets_found", "scan_incomplete", "binary_unscanned"]);
  assert.deepEqual([...GIT_PUSH_REFUSALS.E_CONFLICT].sort(), ["binary_unscanned", "git_drift", "message_unscannable", "plan_changed", "scan_incomplete", "secrets_found"]);
  assert.deepEqual(Object.keys(GIT_PUSH_REFUSALS), ["E_CONFLICT"]);
  for (const r of GIT_PUSH_REASONS) assert.equal(gitPushReasonSchema.safeParse(r).success, true, r);
  for (const r of ["", "secrets", "SECRETS_FOUND", "secrets_found ", "binary", "head_moved", "other"]) assert.equal(gitPushReasonSchema.safeParse(r).success, false, r);
});

test("git.pushPlan response: a blocked plan names a closed reason and its binary paths, and cannot be confirmed", () => {
  const res = schemaOf(G, "pushPlan", "response");
  for (const reason of GIT_PUSH_BLOCKS) accepts(res, blocked({ reason }), `blocked ${reason}`);
  accepts(res, blocked({ reason: "secrets_found", binaryPaths: [] }, { findings: plan.findings }), "findings and no paths");
  accepts(res, plan, "an unblocked plan has no blocked field");
  for (const reason of ["", "plan_changed", "git_drift", "secrets", "SECRETS_FOUND", "unknown", 1, null, "a b", "x".repeat(65)]) rejects(res, blocked({ reason }), `reason ${JSON.stringify(reason)}`);
  rejects(res, blocked({}, { requiresConfirmation: true, reasons: ["r"] }), "blocked and confirmable");
  rejects(res, blocked({}, { requiresConfirmation: true }), "blocked and requiring confirmation");
  rejects(res, blocked({}, { reasons: ["a reason"] }), "blocked with a reason");
  rejects(res, { ...plan, blocked: null }, "null blocked");
  rejects(res, { ...plan, blocked: "binary_unscanned" }, "blocked as a string");
});

test("git.pushPlan response: blocked is strict, bounded and holds display-safe paths only", () => {
  const res = schemaOf(G, "pushPlan", "response");
  for (const k of ["match", "text", "secret", "label", "rule", "paths", "findings", "value", "detail"]) rejects(res, blocked({ [k]: "x" }), `blocked key ${k}`);
  rejects(res, blocked({ binaryPaths: undefined }), "paths missing");
  rejects(res, blocked({ binaryPathsTruncated: undefined }), "truncated flag missing");
  rejects(res, blocked({ binaryPathsTruncated: "yes" }), "truncated flag not boolean");
  assert.equal(MAX_BLOCKED_BINARY_PATHS, MAX_ALLOWED_BINARY_PATHS, "every listed path fits allowedBinaryPaths");
  const many = (n: number) => Array.from({ length: n }, (_, i) => `b/${i}.bin`);
  accepts(res, blocked({ binaryPaths: many(MAX_BLOCKED_BINARY_PATHS), binaryPathsTruncated: true }), "full and truncated");
  rejects(res, blocked({ binaryPaths: many(MAX_BLOCKED_BINARY_PATHS + 1) }), "over the cap");
  rejects(res, blocked({ binaryPaths: many(3), binaryPathsTruncated: true }), "truncated but short");
  for (const p of ["a\nb", "a‮b", "a\u0000b", "a​b", "x".repeat(257), 1, null, ""]) {
    if (p === "") continue; // an empty path is what displayTextSchema allows; the host never produces one
    rejects(res, blocked({ binaryPaths: [p] }), `path ${JSON.stringify(p).slice(0, 20)}`);
  }
  rejects(res, blocked({ binaryPaths: [{ path: "a" }] }), "an object instead of a path");
});

test("git.push request: the refusal reasons are not accepted as input, and the plan binding is unchanged", () => {
  const req = schemaOf(G, "push", "request");
  accepts(req, { workspaceId: "ws-1", remote: "origin", confirmedPlan: { tip: SHA1, digest: DIGEST } }, "plain push");
  for (const k of ["blocked", "reason", "force"]) rejects(req, { workspaceId: "ws-1", remote: "origin", confirmedPlan: { tip: SHA1, digest: DIGEST }, [k]: "x" }, k);
});
