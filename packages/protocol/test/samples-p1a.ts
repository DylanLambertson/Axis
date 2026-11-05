// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Sample } from "./suite.js";

export const H1 = "1".repeat(64);
export const H2 = "2".repeat(64);
export const H3 = "3".repeat(64);
export const CHALLENGE_A = "A".repeat(22);
export const CHALLENGE_B = "B".repeat(22);

export const challengeA = {
  challengeId: CHALLENGE_A,
  digest: "a".repeat(64),
  contract: "axis.worktrees",
  method: "remove",
  tier: 4,
  targetSummary: "Remove workspace fix-login",
  nativeConfirmationRequired: true,
  expiresAt: 1_800_000_000_000,
};
export const challengeB = { ...challengeA, challengeId: CHALLENGE_B, method: "restoreFromRunBase", tier: 2, nativeConfirmationRequired: false };

export const eventOne = {
  seq: 11,
  ts: "2026-11-04T10:00:00.000Z",
  actor: "user",
  action: "tier4.challenge",
  target: "workspace:ws-1",
  outcome: "success",
  payload: { phase: "issued", tier: 4, awaitingNative: true },
  prevHash: H1,
  hash: H2,
};
export const eventTwo = {
  seq: 12,
  ts: "2026-11-04T10:00:01.250Z",
  actor: "daemon",
  action: "rpc.execute",
  target: "workspace:ws-1",
  outcome: "denied",
  payload: { "[content]": { length: 12, sha256: H3 } },
  prevHash: H2,
  hash: H3,
};

export const P1A_SAMPLES: readonly Sample[] = [
  { contract: "axis.projects", method: "list", side: "request", name: "empty", value: {} },
  {
    contract: "axis.projects",
    method: "list",
    side: "response",
    name: "two projects",
    value: { projects: [{ id: "p1", name: "Axis", trusted: true }, { id: "proj_2", name: "Docs site", trusted: false }] },
  },
  {
    contract: "axis.approvals",
    method: "resolve",
    side: "request",
    name: "approve",
    value: { challengeId: CHALLENGE_A, decision: "approve", digest: "a".repeat(64) },
  },
  { contract: "axis.approvals", method: "resolve", side: "response", name: "approved", value: { challengeId: CHALLENGE_A, state: "approved" } },
  { contract: "axis.approvals", method: "pending", side: "request", name: "empty", value: {} },
  { contract: "axis.approvals", method: "pending", side: "response", name: "two challenges", value: { challenges: [challengeA, challengeB] } },
  { contract: "axis.audit", method: "status", side: "request", name: "empty", value: {} },
  {
    contract: "axis.audit",
    method: "status",
    side: "response",
    name: "healthy with lag",
    value: {
      head: { seq: 12, hash: H3 },
      anchor: { seq: 10, hash: H1 },
      lag: 2,
      oldestUnackedAgeMs: 1500,
      stalled: false,
      degraded: null,
    },
    tolerated: ["null at oldestUnackedAgeMs"],
  },
  {
    contract: "axis.audit",
    method: "status",
    side: "response",
    name: "degraded and stalled",
    value: { head: null, anchor: null, lag: 0, oldestUnackedAgeMs: null, stalled: true, degraded: { reason: "database_behind_anchor" } },
  },
  { contract: "axis.audit", method: "list", side: "request", name: "minimal", value: {} },
  { contract: "axis.audit", method: "list", side: "request", name: "full", value: { afterSeq: 5, limit: 200 } },
  {
    contract: "axis.audit",
    method: "list",
    side: "response",
    name: "two events",
    value: { events: [eventOne, eventTwo] },
    // `payload` is free-form bounded JSON, so a wrong type inside it is still valid JSON.
    toleratedPattern: /^((null|number|boolean|array|object|array of string|numeric string|0|1|string|empty string|false) at|extra key \S+ at) events\.\d+\.payload(\.|$)/,
  },
  { contract: "axis.audit", method: "verify", side: "request", name: "empty", value: {} },
  { contract: "axis.audit", method: "verify", side: "response", name: "ok", value: { ok: true, count: 12, head: { seq: 12, hash: H3 } } },
  { contract: "axis.audit", method: "verify", side: "response", name: "ok, empty log", value: { ok: true, count: 0, head: null } },
  {
    contract: "axis.audit",
    method: "verify",
    side: "response",
    name: "broken chain",
    value: { ok: false, firstBadSeq: 7, reason: "hash_mismatch", checked: 6 },
  },
];
