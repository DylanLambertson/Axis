// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_TOPICS,
  ackEnvelopeSchema,
  eventBodySchema,
  eventsMethods,
  parseClientMessage,
  serverFrameSchema,
} from "../src/index.js";
import { accepts, errorText, parse, rejects, runSuite, schemaOf, type Sample } from "./suite.js";

const E = "axis.events";
const SUB = "S".repeat(22);
const EPOCH = "E".repeat(22);

const SAMPLES: readonly Sample[] = [
  { contract: E, method: "subscribe", side: "request", name: "fresh", value: { topics: ["workspaces", "runs"] } },
  { contract: E, method: "subscribe", side: "request", name: "resume", value: { topics: ["approvals"], resumeFrom: { epoch: EPOCH, seq: 12 } } },
  { contract: E, method: "subscribe", side: "response", name: "made", value: { subscriptionId: SUB, epoch: EPOCH, seq: 12, resumed: true, window: 32 } },
  { contract: E, method: "unsubscribe", side: "request", name: "one", value: { subscriptionId: SUB } },
  { contract: E, method: "unsubscribe", side: "response", name: "one", value: { subscriptionId: SUB } },
];

runSuite(SAMPLES);

test("events: both methods have both schemas guarded (no unknown key is echoed)", () => {
  for (const [name, spec] of Object.entries(eventsMethods)) {
    for (const side of ["request", "response"] as const) {
      const r = parse(spec[side], { CANARY_KEY_x: 1 }, `${name} ${side}`);
      assert.equal(r.success, false);
      assert.equal(errorText(r).includes("CANARY"), false);
    }
  }
});

test("events: subscribe topics are a non-empty set of the closed topics", () => {
  const s = schemaOf(E, "subscribe", "request");
  for (const t of EVENT_TOPICS) accepts(s, { topics: [t] }, t);
  rejects(s, { topics: [] }, "empty");
  rejects(s, { topics: ["runs", "runs"] }, "duplicate");
  rejects(s, { topics: ["secrets"] }, "unknown topic");
  rejects(s, { topics: ["runs"], resumeFrom: { epoch: "short", seq: 1 } }, "epoch too short");
  rejects(s, { topics: ["runs"], resumeFrom: { epoch: EPOCH, seq: -1 } }, "negative seq");
  rejects(s, { topics: ["runs"], windowId: "w" }, "a window id from the payload");
});

test("events: every body is closed and strict, so an extra field (a path, a name, a message) is invalid", () => {
  const valid = [
    { topic: "workspaces", workspaceId: "ws-1" },
    { topic: "runs", runId: "r-1", state: "RUNNING" },
    { topic: "runs", runId: "r-1" },
    { topic: "approvals" },
    { topic: "anchor", stalled: false },
    { topic: "audit", headSeq: 4 },
  ];
  for (const b of valid) assert.equal(eventBodySchema.safeParse(b).success, true, JSON.stringify(b));
  const invalid = [
    { topic: "workspaces", workspaceId: "ws-1", path: "/home/x" },
    { topic: "workspaces", workspaceId: "/home/x" },
    { topic: "workspaces", workspaceId: "-rf" },
    { topic: "runs", runId: "r-1", state: "EXPLODED" },
    { topic: "approvals", challengeId: "A".repeat(43) },
    { topic: "anchor", stalled: "yes" },
    { topic: "audit", headSeq: -1 },
    { topic: "audit", headSeq: 1, hash: "0".repeat(64) },
    { topic: "projects" },
  ];
  for (const b of invalid) assert.equal(eventBodySchema.safeParse(b).success, false, JSON.stringify(b));
});

test("events: frames are event, resync or end with closed reasons; nothing else passes", () => {
  const ok = [
    { v: 1, sub: SUB, seq: 3, event: { topic: "approvals" } },
    { v: 1, sub: SUB, seq: 3, resync: { reason: "overflow" } },
    { v: 1, sub: SUB, end: { reason: "shutdown" } },
  ];
  for (const f of ok) assert.equal(serverFrameSchema.safeParse(f).success, true, JSON.stringify(f));
  const bad = [
    { v: 1, sub: SUB, seq: 3, resync: { reason: "because" } },
    { v: 1, sub: SUB, end: { reason: "crash" } },
    { v: 1, sub: SUB, seq: 3, event: { topic: "approvals" }, extra: 1 },
    { v: 1, sub: SUB, event: { topic: "approvals" } },
    { v: 1, sub: "x", seq: 3, event: { topic: "approvals" } },
  ];
  for (const f of bad) assert.equal(serverFrameSchema.safeParse(f).success, false, JSON.stringify(f));
});

test("events: an ack is a client message (bounded walk first), strict, and never a request", () => {
  const ack = { v: 1, ack: SUB, seq: 7 };
  const parsed = parseClientMessage(ack);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && "ack" in parsed.message, true);
  assert.equal(parseClientMessage({ ...ack, extra: 1 }).ok, false);
  assert.equal(parseClientMessage({ ...ack, seq: 1.5 }).ok, false);
  assert.equal(parseClientMessage({ v: 1, ack: SUB, seq: 1, __proto__: null, constructor: 1 }).ok, false);
  assert.equal(ackEnvelopeSchema.safeParse({ v: 1, ack: "short", seq: 1 }).success, false);
});
