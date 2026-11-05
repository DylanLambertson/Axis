// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inboundMessageSchema, outboundMessageSchema } from "../src/index.js";

const chal = "A".repeat(43);
const proof = "p".repeat(32);
const head = { seq: 3, hash: "a".repeat(64) };

const inbound: Record<string, unknown> = {
  init: { type: "init", config: { dataDir: "/x" } },
  connect: { type: "connect", cid: "conn-0001", attestation: { identity: { actor: "user" }, issuedAt: 1, mac: "m".repeat(43) } },
  "anchor.result": { type: "anchor.result", requestId: "r1", anchor: head },
  "anchor.result (none)": { type: "anchor.result", requestId: "r1", anchor: null },
  "anchor.ack": { type: "anchor.ack", seq: 3 },
  "native.result": { type: "native.result", challengeId: chal, proof, confirmed: true, windowId: "win-1" },
  "trust.result": { type: "trust.result", requestId: "r2", trusted: false },
  "trust.set": { type: "trust.set", windowId: "win-1", trusted: true },
  "settings.result": { type: "settings.result", requestId: "r3", key: "axis.git.runHooks", value: true },
  "projects.register": { type: "projects.register", requestId: "r4", path: "/work/repo", trusted: true },
  shutdown: { type: "shutdown" },
};

test("every inbound message of the design table parses, and a stray key refuses it", () => {
  for (const [name, msg] of Object.entries(inbound)) {
    assert.equal(inboundMessageSchema.safeParse(msg).success, true, name);
    assert.equal(inboundMessageSchema.safeParse({ ...(msg as object), extra: 1 }).success, false, `${name} + extra`);
  }
});

test("inbound refusals: unknown type, bad ids, relative path, unknown setting, bad anchor", () => {
  const bad: unknown[] = [
    { type: "nope" }, {}, null, "shutdown", [],
    { ...(inbound["trust.result"] as object), requestId: "has space" },
    { ...(inbound["projects.register"] as object), path: "relative/dir" },
    { ...(inbound["projects.register"] as object), path: "/a\0b" },
    { ...(inbound["settings.result"] as object), key: "axis.other" },
    { ...(inbound["anchor.result"] as object), anchor: { seq: 0, hash: "a".repeat(64) } },
    { ...(inbound["anchor.ack"] as object), seq: 1.5 },
    { ...(inbound["native.result"] as object), challengeId: "short" },
    { ...(inbound["connect"] as object), cid: "x" },
    { ...(inbound["connect"] as object), attestation: { identity: {}, issuedAt: -1, mac: "m".repeat(43) } },
  ];
  for (const b of bad) assert.equal(inboundMessageSchema.safeParse(b).success, false, JSON.stringify(b)?.slice(0, 60));
});

test("outbound messages: the design table parses; free text and non-closed codes do not", () => {
  const ok: unknown[] = [
    { type: "ready", protocolVersion: 1, contracts: ["axis.audit"] },
    { type: "ready", protocolVersion: 1, contracts: [], degraded: "behind_anchor" },
    { type: "anchor.get", requestId: "r1" },
    { type: "anchor.put", ...head },
    { type: "native.confirm", challengeId: chal, proof, windowId: "win-1", summary: "Push axis/x" },
    { type: "trust.check", requestId: "r1", windowId: "w", workspaceId: "ws", projectId: "p" },
    { type: "settings.get", requestId: "r1", key: "axis.cliAgents" },
    { type: "projects.result", requestId: "r1", ok: true, projectId: "p1" },
    { type: "projects.result", requestId: "r1", ok: false, code: "E_CONFLICT", reason: "nested_project" },
    { type: "fatal", code: "E_INTERNAL" },
    { type: "log", level: "info", event: "host.ready", fields: { count: 1 } },
  ];
  for (const m of ok) assert.equal(outboundMessageSchema.safeParse(m).success, true, JSON.stringify(m));
  const bad: unknown[] = [
    { type: "ready", protocolVersion: 1, contracts: [], degraded: "Free text with spaces" },
    { type: "fatal", code: "E_MADE_UP" },
    { type: "projects.result", requestId: "r1", ok: false, code: "E_NOPE" },
    { type: "native.confirm", challengeId: chal, proof, windowId: "w", summary: "multi\nline" },
    { type: "log", level: "info", event: "Host Ready" },
    { type: "log", level: "info", event: "x", fields: { nested: { a: 1 } } },
  ];
  for (const m of bad) assert.equal(outboundMessageSchema.safeParse(m).success, false, JSON.stringify(m));
});
