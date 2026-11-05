// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_AUDIT_LIST, MAX_PENDING_CHALLENGES, MAX_PROJECTS } from "../src/index.js";
import { CHALLENGE_A, H1, H2, H3, P1A_SAMPLES, challengeA, eventOne, eventTwo } from "./samples-p1a.js";
import { accepts, rejects, runSuite, schemaOf } from "./suite.js";

runSuite(P1A_SAMPLES);

const projectsReq = () => schemaOf("axis.projects", "list", "request");
const projectsRes = () => schemaOf("axis.projects", "list", "response");
const resolveReq = () => schemaOf("axis.approvals", "resolve", "request");
const resolveRes = () => schemaOf("axis.approvals", "resolve", "response");
const pendingRes = () => schemaOf("axis.approvals", "pending", "response");
const statusRes = () => schemaOf("axis.audit", "status", "response");
const listReq = () => schemaOf("axis.audit", "list", "request");
const listRes = () => schemaOf("axis.audit", "list", "response");
const verifyRes = () => schemaOf("axis.audit", "verify", "response");

const project = (n: number) => ({ id: `p${n}`, name: `Project ${n}`, trusted: false });
// A fresh copy each time: a shared payload object between events is itself refused (aliasing).
const event = (seq: number, extra: Record<string, unknown> = {}) => ({ ...structuredClone(eventOne), seq, ...extra });

test("projects: requests take nothing, and no path can ride along", () => {
  accepts(projectsReq(), {}, "empty");
  for (const k of ["path", "root", "cwd", "projectId", "limit"]) rejects(projectsReq(), { [k]: "x" }, k);
  rejects(projectsReq(), { projects: [] }, "response shape as request");
});

test("projects: response bounds, ids and names", () => {
  accepts(projectsRes(), { projects: [] }, "empty list");
  accepts(projectsRes(), { projects: Array.from({ length: MAX_PROJECTS }, (_, i) => project(i)) }, "at the cap");
  rejects(projectsRes(), { projects: Array.from({ length: MAX_PROJECTS + 1 }, (_, i) => project(i)) }, "over the cap");
  rejects(projectsRes(), { projects: [project(1), project(1)] }, "duplicate id");
  rejects(projectsRes(), { projects: [{ ...project(1), path: "/home/u/repo" }] }, "a path field");
  rejects(projectsRes(), { projects: [{ ...project(1), id: "../x" }] }, "id with a separator");
  rejects(projectsRes(), { projects: [{ ...project(1), id: "x".repeat(65) }] }, "id over 64");
  for (const name of ["", " lead", "trail ", "a\nb", "a\u202eb", "a\u200bb", "a\u2028b", "a\u2029b", "n".repeat(81)]) {
    rejects(projectsRes(), { projects: [{ ...project(1), name }] }, JSON.stringify(name));
  }
  accepts(projectsRes(), { projects: [{ ...project(1), name: "n".repeat(80) }] }, "name at 80");
  for (const trusted of ["yes", 1, null, undefined]) rejects(projectsRes(), { projects: [{ ...project(1), trusted }] }, String(trusted));
  rejects(projectsRes(), {}, "projects missing");
});

test("approvals.resolve: request bounds and identity", () => {
  const ok = { challengeId: CHALLENGE_A, decision: "deny", digest: "b".repeat(64) };
  accepts(resolveReq(), ok, "deny");
  for (const k of ["approver", "actor", "windowId", "connectionId", "approval", "state"]) rejects(resolveReq(), { ...ok, [k]: "user" }, k);
  rejects(resolveReq(), { ...ok, decision: "maybe" }, "decision");
  rejects(resolveReq(), { ...ok, decision: "Approve" }, "decision case");
  rejects(resolveReq(), { ...ok, digest: "B".repeat(64) }, "uppercase digest");
  rejects(resolveReq(), { ...ok, digest: "b".repeat(63) }, "short digest");
  rejects(resolveReq(), { ...ok, digest: "b".repeat(65) }, "long digest");
  rejects(resolveReq(), { ...ok, challengeId: "A".repeat(21) }, "short challenge id");
  rejects(resolveReq(), { ...ok, challengeId: "A".repeat(65) }, "long challenge id");
  rejects(resolveReq(), { ...ok, challengeId: `${"A".repeat(21)}!` }, "bad character");
  accepts(resolveReq(), { ...ok, challengeId: "A".repeat(64) }, "challenge id at 64");
  const { digest: _d, ...noDigest } = ok;
  rejects(resolveReq(), noDigest, "digest missing");
});

test("approvals.resolve: response states are the closed three", () => {
  for (const state of ["approved", "denied", "expired"]) accepts(resolveRes(), { challengeId: CHALLENGE_A, state }, state);
  for (const state of ["pending", "confirmed", "APPROVED", "", null]) rejects(resolveRes(), { challengeId: CHALLENGE_A, state }, String(state));
  rejects(resolveRes(), { challengeId: CHALLENGE_A, state: "approved", nativeRequired: true }, "extra field");
});

test("approvals.pending: bounds, shape and unique ids", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...challengeA, challengeId: `C${String(i).padStart(21, "0")}` }));
  accepts(pendingRes(), { challenges: [] }, "empty");
  accepts(pendingRes(), { challenges: many(MAX_PENDING_CHALLENGES) }, "at the cap");
  rejects(pendingRes(), { challenges: many(MAX_PENDING_CHALLENGES + 1) }, "over the cap");
  rejects(pendingRes(), { challenges: [{ ...challengeA }, { ...challengeA }] }, "duplicate challenge id (separate objects)");
  for (const bad of [{ tier: 6 }, { tier: Number.NaN }, { tier: 1.5 }, { tier: -1 }, { expiresAt: 0 }, { expiresAt: -5 }, { digest: "xyz" }, { x: 1 }, { challengeId: "short" }]) {
    rejects(pendingRes(), { challenges: [{ ...challengeA, ...bad }] }, JSON.stringify(bad));
  }
});

test("audit.status: counts, anchors and degraded reason", () => {
  const ok = { head: { seq: 3, hash: H1 }, anchor: null, lag: 3, oldestUnackedAgeMs: 0, stalled: false, degraded: null };
  accepts(statusRes(), ok, "base");
  for (const lag of [-1, 1.5, Number.NaN, "3", null, 2 ** 53]) rejects(statusRes(), { ...ok, lag }, `lag ${String(lag)}`);
  for (const age of [-1, 0.5, "1", undefined]) rejects(statusRes(), { ...ok, oldestUnackedAgeMs: age }, `age ${String(age)}`);
  for (const head of [{ seq: 0, hash: H1 }, { seq: 1, hash: "A".repeat(64) }, { seq: 1, hash: "a" }, { seq: 1 }, { seq: 1, hash: H1, x: 1 }]) {
    rejects(statusRes(), { ...ok, head }, JSON.stringify(head));
  }
  for (const reason of ["Bad Reason", "", "x".repeat(65), "1abc", "a-b"]) rejects(statusRes(), { ...ok, degraded: { reason } }, reason);
  accepts(statusRes(), { ...ok, degraded: { reason: "x".repeat(64) } }, "reason at 64");
  rejects(statusRes(), { ...ok, degraded: { reason: "ok", message: "x" } }, "degraded extra field");
  rejects(statusRes(), { ...ok, stalled: "false" }, "stalled as string");
  const { degraded: _g, ...partial } = ok;
  rejects(statusRes(), partial, "degraded missing");
});

test("audit.list request: limit is 1 to 200, afterSeq a safe non-negative integer", () => {
  assert.equal(MAX_AUDIT_LIST, 200);
  for (const limit of [1, 200]) accepts(listReq(), { limit }, `limit ${limit}`);
  for (const limit of [0, 201, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "10", null, 10_000_000]) {
    rejects(listReq(), { limit }, `limit ${String(limit)}`);
  }
  for (const afterSeq of [0, 1, Number.MAX_SAFE_INTEGER]) accepts(listReq(), { afterSeq }, `afterSeq ${afterSeq}`);
  for (const afterSeq of [-1, 0.5, Number.NaN, 2 ** 53, Number.POSITIVE_INFINITY, "5", null]) {
    rejects(listReq(), { afterSeq }, `afterSeq ${String(afterSeq)}`);
  }
  for (const k of ["actor", "filter", "from", "expectedHead"]) rejects(listReq(), { [k]: 1 }, k);
});

test("audit.list response: cap, order and the shape of an event", () => {
  const page = (n: number) => Array.from({ length: n }, (_, i) => event(i + 1));
  accepts(listRes(), { events: [] }, "empty");
  accepts(listRes(), { events: page(MAX_AUDIT_LIST) }, "at the cap");
  rejects(listRes(), { events: page(MAX_AUDIT_LIST + 1) }, "over the cap");
  rejects(listRes(), { events: [eventTwo, eventOne] }, "descending");
  rejects(listRes(), { events: [event(5), event(5)] }, "duplicate seq");
  const bad: Record<string, Record<string, unknown>> = {
    "seq 0": { seq: 0 },
    "seq fraction": { seq: 1.5 },
    "seq unsafe": { seq: 2 ** 53 },
    "ts date only": { ts: "2026-11-04" },
    "ts with offset": { ts: "2026-11-04T10:00:00.000+01:00" },
    "ts without millis": { ts: "2026-11-04T10:00:00Z" },
    "actor root": { actor: "root" },
    "actor empty agent": { actor: "agent:" },
    "actor spaces": { actor: "agent:a b" },
    "action upper": { action: "Tier4.challenge" },
    "action no dot": { action: "tier4" },
    "action 97": { action: `a.${"b".repeat(95)}` },
    "outcome ok": { outcome: "ok" },
    "target empty": { target: "" },
    "target 1025": { target: "t".repeat(1025) },
    "hash upper": { hash: "A".repeat(64) },
    "prevHash short": { prevHash: "a".repeat(63) },
    "payload undefined": { payload: undefined },
    "payload 5 levels": { payload: { a: { b: { c: { d: { e: 1 } } } } } },
    "payload long string": { payload: { a: "x".repeat(2049) } },
    "payload 600 nodes": { payload: Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`k${i}`, i])) },
    "extra field": { signature: "x" },
  };
  for (const [name, patch] of Object.entries(bad)) rejects(listRes(), { events: [event(1, patch)] }, name);
  accepts(listRes(), { events: [event(1, { actor: "agent:cli.1", target: "t".repeat(1024), payload: null })] }, "agent actor, 1024 target, null payload");
  accepts(listRes(), { events: [event(1, { action: `a.${"b".repeat(94)}` })] }, "action at 96");
  accepts(listRes(), { events: [event(1, { payload: { a: { b: { c: { d: 1 } } } } })] }, "payload 4 levels");
});

test("audit.list response: a page too big for one message is refused whole", () => {
  const fat = (seq: number) => event(seq, { target: "t".repeat(1024), payload: { a: "x".repeat(2000), b: "y".repeat(2000), c: "z".repeat(2000), d: "w".repeat(2000) } });
  accepts(listRes(), { events: Array.from({ length: 20 }, (_, i) => fat(i + 1)) }, "20 large events fit");
  rejects(listRes(), { events: Array.from({ length: MAX_AUDIT_LIST }, (_, i) => fat(i + 1)) }, "200 large events exceed one message");
});

test("audit.verify response: the two outcomes cannot be mixed", () => {
  const good = { ok: true, count: 12, head: { seq: 12, hash: H3 } };
  const badChain = { ok: false, firstBadSeq: 7, reason: "seq_gap", checked: 6 };
  accepts(verifyRes(), good, "ok");
  accepts(verifyRes(), badChain, "failure");
  for (const reason of ["malformed_row", "seq_gap", "unsupported_version", "hash_mismatch", "prev_hash_mismatch", "truncated"]) {
    accepts(verifyRes(), { ...badChain, reason }, reason);
  }
  for (const reason of ["other", "HASH_MISMATCH", "", null]) rejects(verifyRes(), { ...badChain, reason }, String(reason));
  rejects(verifyRes(), { ...good, count: 5 }, "count differs from head.seq");
  rejects(verifyRes(), { ok: true, count: 3, head: null }, "count with no head");
  rejects(verifyRes(), { ok: true, count: 0, head: { seq: 1, hash: H2 } }, "head with count 0");
  rejects(verifyRes(), { ...good, firstBadSeq: 1 }, "failure field on success");
  rejects(verifyRes(), { ...badChain, count: 1 }, "success field on failure");
  rejects(verifyRes(), { ...badChain, firstBadSeq: 0 }, "firstBadSeq 0");
  rejects(verifyRes(), { ...badChain, checked: -1 }, "checked negative");
  rejects(verifyRes(), { ok: "true", count: 0, head: null }, "ok as string");
  rejects(verifyRes(), { count: 0, head: null }, "no discriminator");
});

test("axis.audit: nothing in any request lets the caller choose the anchor", () => {
  for (const method of ["status", "list", "verify"]) {
    for (const k of ["expectedHead", "anchor", "from", "head"]) rejects(schemaOf("axis.audit", method, "request"), { [k]: { seq: 1, hash: H1 } }, `${method} ${k}`);
  }
});
