// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GIT_COMMIT_REFUSALS, GIT_COMMIT_REASONS, gitCommitReasonSchema, GIT_PUSH_BLOCKS, GIT_PUSH_REASONS, GIT_PUSH_REFUSALS, MAX_ALLOWED_BINARY_IDS, MAX_ALLOWED_BINARY_PATHS, MAX_BLOCKED_BINARY_FILES, gitPushReasonSchema } from "../src/index.js";
import { DIGEST, SHA1, plan } from "./samples-p1b.js";
import { accepts, rejects, schemaOf } from "./suite.js";

const G = "axis.git";
const id = (n: number) => `bin_${n.toString(16).padStart(32, "0")}`;
const file = (n: number, path = `b/${n}.bin`, lossy = false) => ({ id: id(n), path, lossy });
/** A plan the scan blocks: nothing to confirm, the closed reason and the binary paths still to allow. */
const blocked = (patch: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  ...plan,
  requiresConfirmation: false,
  reasons: [],
  blocked: { reason: "binary_unscanned", binaryFiles: [file(1, "img/logo.png")], binaryFilesTruncated: false, ...patch },
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
  accepts(res, blocked({ reason: "secrets_found", binaryFiles: [] }, { findings: plan.findings }), "findings and no paths");
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
  rejects(res, blocked({ binaryFiles: undefined }), "files missing");
  rejects(res, blocked({ binaryPaths: ["a.bin"] }), "the old paths list is not a key any more");
  rejects(res, blocked({ binaryFilesTruncated: undefined }), "truncated flag missing");
  rejects(res, blocked({ binaryFilesTruncated: "yes" }), "truncated flag not boolean");
  assert.equal(MAX_BLOCKED_BINARY_FILES, MAX_ALLOWED_BINARY_IDS, "every listed file fits allowedBinaryIds");
  assert.ok(MAX_BLOCKED_BINARY_FILES > MAX_ALLOWED_BINARY_PATHS, "more files than allowedBinaryPaths holds can be allowed by id");
  const many = (n: number) => Array.from({ length: n }, (_, i) => file(i));
  accepts(res, blocked({ binaryFiles: many(MAX_BLOCKED_BINARY_FILES), binaryFilesTruncated: true }), "full and truncated");
  rejects(res, blocked({ binaryFiles: many(MAX_BLOCKED_BINARY_FILES + 1) }), "over the cap");
  rejects(res, blocked({ binaryFiles: many(3), binaryFilesTruncated: true }), "truncated but short");
  for (const p of ["a\nb", "a\u202eb", "a\u0000b", "a\u200bb", "x".repeat(257), 1, null]) rejects(res, blocked({ binaryFiles: [file(1, p as string)] }), `path ${JSON.stringify(p).slice(0, 20)}`);
  rejects(res, blocked({ binaryFiles: ["a.bin"] }), "a bare path instead of a row");
});

test("git.push request: the refusal reasons are not accepted as input, and the plan binding is unchanged", () => {
  const req = schemaOf(G, "push", "request");
  accepts(req, { workspaceId: "ws-1", remote: "origin", confirmedPlan: { tip: SHA1, digest: DIGEST } }, "plain push");
  for (const k of ["blocked", "reason", "force"]) rejects(req, { workspaceId: "ws-1", remote: "origin", confirmedPlan: { tip: SHA1, digest: DIGEST }, [k]: "x" }, k);
});

test("git_drift is a closed E_CONFLICT reason of commit and of push, each in its own table", () => {
  assert.ok((GIT_COMMIT_REFUSALS.E_CONFLICT as readonly string[]).includes("git_drift"));
  assert.ok((GIT_PUSH_REFUSALS.E_CONFLICT as readonly string[]).includes("git_drift"));
  assert.ok((GIT_COMMIT_REASONS as readonly string[]).includes("git_drift"));
  assert.equal(gitCommitReasonSchema.safeParse("git_drift").success, true);
  for (const b of GIT_PUSH_BLOCKS) assert.equal(gitCommitReasonSchema.safeParse(b).success, false, `${b} is not a commit reason`);
});

test("git.pushPlan response: display paths that were shortened or escaped are still bounded display text", () => {
  const res = schemaOf(G, "pushPlan", "response");
  for (const p of [`${"a".repeat(120)}\u2026${"b".repeat(120)}`, "dir\\u{5c}name.bin", "a\\b.bin", "x\u2026y.bin"]) accepts(res, blocked({ binaryFiles: [file(1, p)] }), p.slice(0, 20));
});

test("git.pushPlan response: a file row is closed, its id is opaque and well formed, and an id is listed once", () => {
  const res = schemaOf(G, "pushPlan", "response");
  accepts(res, blocked({ binaryFiles: [file(1, "a.bin", true), file(2)] }), "a lossy row and a plain one");
  for (const bad of ["", "bin_", "bin_" + "0".repeat(31), "bin_" + "0".repeat(33), "bin_" + "G".repeat(32), "bin_" + "A".repeat(32), "BIN_" + "0".repeat(32), "0".repeat(36), "a.bin", `${id(1)} `]) {
    rejects(res, blocked({ binaryFiles: [{ id: bad, path: "a.bin", lossy: false }] }), `id ${bad}`);
  }
  rejects(res, blocked({ binaryFiles: [{ path: "a.bin", lossy: false }] }), "id missing");
  rejects(res, blocked({ binaryFiles: [{ id: id(1), lossy: false }] }), "path missing");
  rejects(res, blocked({ binaryFiles: [{ id: id(1), path: "a.bin" }] }), "lossy missing");
  rejects(res, blocked({ binaryFiles: [{ id: id(1), path: "a.bin", lossy: "no" }] }), "lossy not boolean");
  for (const k of ["blob", "mode", "size", "bytes", "content"]) rejects(res, blocked({ binaryFiles: [{ ...file(1), [k]: "x" }] }), `row key ${k}`);
  rejects(res, blocked({ binaryFiles: [file(1), file(1, "other.bin")] }), "one id twice");
});

test("git.pushPlan and git.push requests: allowedBinaryIds is a bounded set of well formed ids, beside allowedBinaryPaths", () => {
  const plan = schemaOf(G, "pushPlan", "request");
  const push = schemaOf(G, "push", "request");
  const base = { workspaceId: "ws-1", remote: "origin" };
  const confirmed = { ...base, confirmedPlan: { tip: SHA1, digest: DIGEST } };
  const ids = (n: number) => Array.from({ length: n }, (_, i) => id(i));
  for (const [s, b] of [[plan, base], [push, confirmed]] as const) {
    accepts(s, { ...b, allowedBinaryIds: [] }, "empty");
    accepts(s, { ...b, allowedBinaryIds: [id(1)], allowedBinaryPaths: ["a.bin"] }, "ids and paths together");
    accepts(s, { ...b, allowedBinaryIds: ids(MAX_ALLOWED_BINARY_IDS) }, "at the cap");
    rejects(s, { ...b, allowedBinaryIds: ids(MAX_ALLOWED_BINARY_IDS + 1) }, "over the cap");
    rejects(s, { ...b, allowedBinaryIds: [id(1), id(1)] }, "a repeated id");
    rejects(s, { ...b, allowedBinaryIds: ["a.bin"] }, "a path as an id");
    rejects(s, { ...b, allowedBinaryIds: [id(1).toUpperCase()] }, "upper case");
    rejects(s, { ...b, allowedBinaryIds: id(1) }, "a string, not a list");
    rejects(s, { ...b, allowedBinaryIds: [null] }, "null");
    rejects(s, { ...b, allowedBinaryIds: [{ id: id(1) }] }, "a row, not an id");
  }
});
