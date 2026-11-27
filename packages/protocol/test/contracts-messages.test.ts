// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.messages/1 (PV-M1): registry placement, no capability field, opaque ids and the closed, oracle-free refusals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  MESSAGES_REASONS,
  MESSAGES_REFUSALS,
  MESSAGES_REFUSAL_MESSAGE,
  MESSAGING_ID_BYTES,
  contracts,
  encodeMessagingId,
  errorSchema,
  isMessagesRefusal,
  lookupMethod,
  makeError,
  messageIdSchema,
  messagesMethods,
  messagesCliEndpointResponseSchema,
  messagesDisableCliEndpointRequestSchema,
  messagesEnableCliEndpointRequestSchema,
  messagesMarkReadRequestSchema,
  messagesMarkReadResponseSchema,
  messagesPauseRequestSchema,
  messagesPauseResponseSchema,
  messagesReadRequestSchema,
  messagesReadResponseSchema,
  messagesResumeResponseSchema,
  messagesSendRequestSchema,
  messagesSendResponseSchema,
  messagesSettingsRequestSchema,
  messagesSettingsResponseSchema,
  messagesThreadRequestSchema,
  messagesThreadResponseSchema,
  messagesThreadsRequestSchema,
  messagesThreadsResponseSchema,
  messagesUpdateSettingsRequestSchema,
  messagesUpdateSettingsResponseSchema,
  messagesRefusalDetailsSchema,
  plannedContracts,
  tableProblems,
  threadIdSchema,
} from "../src/index.js";
import { MESSAGES_SAMPLES, MSG1, THREAD, settings as SETTINGS } from "./samples-messages.js";
import { accepts, rejects, runSuite, schemaOf } from "./suite.js";

runSuite(MESSAGES_SAMPLES);

/** The designed table: method, side effect, tier, idempotency, timeout. Reads are tier 0 or 1; nothing is tier 3 or above. */
const EXPECTED: ReadonlyArray<readonly [string, string, number, string, number]> = [
  ["send", "write", 2, "required", 15_000],
  ["thread", "read", 1, "none", 10_000],
  ["threads", "read", 0, "none", 10_000],
  ["read", "read", 1, "none", 10_000],
  ["markRead", "write", 1, "none", 5_000],
  ["pause", "write", 2, "none", 5_000],
  ["resume", "write", 2, "none", 5_000],
  ["settings", "read", 0, "none", 5_000],
  ["updateSettings", "write", 2, "none", 10_000],
  ["enableCliEndpoint", "write", 4, "none", 30_000],
  ["disableCliEndpoint", "write", 1, "none", 10_000],
];

test("messages: served (PV-M3), nothing left planned; the method table is the designed one, frozen and servable", () => {
  const table = contracts["axis.messages/1"];
  assert.ok(table !== undefined);
  assert.equal(plannedContracts["axis.messages/1"], undefined, "a served contract is never also planned");
  assert.deepEqual(tableProblems(contracts), []);
  assert.deepEqual(
    Object.entries(table).map(([m, s]) => [m, s.sideEffect, s.tier, s.idempotency, s.timeoutMs]),
    EXPECTED.map((r) => [...r]),
  );
  for (const [m] of EXPECTED) assert.equal(lookupMethod("axis.messages", 1, m), table[m], `${m} is not reachable through lookupMethod`);
  assert.equal(Object.isFrozen(plannedContracts), true);
  for (const s of Object.values(table)) assert.throws(() => { (s as { tier: number }).tier = 0; }, TypeError);
});

/** Every property name a schema can accept or produce, at any depth. */
function propertyNames(schema: z.ZodType): string[] {
  const names: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== "object" || node === null) return;
    const o = node as Record<string, unknown>;
    if (typeof o["properties"] === "object" && o["properties"] !== null) names.push(...Object.keys(o["properties"] as object));
    for (const v of Object.values(o)) visit(v);
  };
  for (const io of ["input", "output"] as const) visit(z.toJSONSchema(schema, { io, unrepresentable: "any" }));
  return names;
}

const BARE_REQUESTS: Record<string, z.ZodType> = {
  send: messagesSendRequestSchema, thread: messagesThreadRequestSchema, threads: messagesThreadsRequestSchema,
  read: messagesReadRequestSchema, markRead: messagesMarkReadRequestSchema, pause: messagesPauseRequestSchema,
  resume: messagesPauseRequestSchema, settings: messagesSettingsRequestSchema, updateSettings: messagesUpdateSettingsRequestSchema,
  enableCliEndpoint: messagesEnableCliEndpointRequestSchema, disableCliEndpoint: messagesDisableCliEndpointRequestSchema,
};
const BARE_RESPONSES: Record<string, z.ZodType> = {
  send: messagesSendResponseSchema, thread: messagesThreadResponseSchema, threads: messagesThreadsResponseSchema,
  read: messagesReadResponseSchema, markRead: messagesMarkReadResponseSchema, pause: messagesPauseResponseSchema,
  resume: messagesResumeResponseSchema, settings: messagesSettingsResponseSchema, updateSettings: messagesUpdateSettingsResponseSchema,
  enableCliEndpoint: messagesCliEndpointResponseSchema, disableCliEndpoint: messagesCliEndpointResponseSchema,
};
/** Names the pattern matches that are settings, not capabilities: the secret-scan mode of a project (section 8.2). */
const NOT_A_CAPABILITY: ReadonlySet<string> = new Set(["secretScan"]);
const CAPABILITY = /approv|challenge|digest|grant|token|capab|credential|secret|password|command|argv|exec|tool|permission|actor|sign/i;

/**
 * The one method that takes an approval (PV-M7 slice 2): switching the CLI endpoint on, tier 4 with main's native
 * confirmation. Its `approval` is the daemon's challenge reference that the retry spends, and nothing else it carries is one.
 */
const APPROVED: ReadonlyMap<string, ReadonlySet<string>> = new Map([["enableCliEndpoint", new Set(["approval", "challengeId"])]]);

test("messages: no request or response field, at any depth, can carry an approval, a capability or a command (but the switch's own approval)", () => {
  const all = new Set<string>();
  assert.deepEqual(Object.entries(messagesMethods).filter(([, spec]) => spec.tier > 2).map(([m]) => m), [...APPROVED.keys()], "only the switch is above tier 2");
  for (const [method, spec] of Object.entries(messagesMethods)) {
    if (!APPROVED.has(method)) assert.ok(spec.tier <= 2, `${method}: a tier 3 method would take an approval`);
    if (!APPROVED.has(method)) assert.equal((spec.request as { shape?: Record<string, unknown> }).shape?.["approval"], undefined, `${method}: approval field`);
    for (const side of ["request", "response"] as const) {
      // The bare schemas are what the guarded ones parse with; the walk sees their whole tree.
      const bare = (side === "request" ? BARE_REQUESTS : BARE_RESPONSES)[method];
      assert.ok(bare !== undefined, `${method} ${side}`);
      const names = propertyNames(bare);
      for (const n of names) all.add(n);
      for (const n of names) if (!NOT_A_CAPABILITY.has(n) && !(side === "request" && APPROVED.get(method)?.has(n) === true)) assert.doesNotMatch(n, CAPABILITY, `${method} ${side}: field ${n}`);
    }
  }
  // The walk sees nested fields (the excerpt's line range, a recipient's group), so it is not vacuous.
  for (const n of ["recipients", "group", "endLine", "throughSeq", "acceptsFrom", "scope", "verified", "participants", "truncated"]) assert.ok(all.has(n), `walk missed ${n}`);
  // A field added anywhere is caught: the same walk over a send request with an approval nested in a ref names it.
  const widened = messagesSendRequestSchema.extend({ refs: z.array(z.strictObject({ approval: z.string() })) });
  assert.ok(propertyNames(widened).some((n) => CAPABILITY.test(n)));
});

test("messages: every daemon-filled or capability field is refused in every request", () => {
  const send = schemaOf("axis.messages", "send", "request");
  const ok = { recipients: [{ user: true }], body: { format: "text", text: "hi" } };
  accepts(send, ok, "minimal send");
  const daemonFields: Record<string, unknown> = {
    messageId: MSG1, projectId: "proj-1", seq: 1, sender: { kind: "user", verified: true }, hop: 0, createdAt: "2026-11-20T10:00:00.000Z",
    expanded: [{ kind: "user" }], verified: true, approval: { challengeId: "A".repeat(43) }, challengeId: "A".repeat(43),
    digest: "c".repeat(64), grant: {}, token: "t", capability: "x", command: "ls", argv: ["ls"], actor: "user", tool: "write_file",
  };
  for (const [k, v] of Object.entries(daemonFields)) rejects(send, { ...ok, [k]: v }, `send with ${k}`);
  rejects(send, { ...ok, body: { format: "text", text: "hi", approved: true } }, "an extra body field");
  rejects(send, { ...ok, body: { format: "markdown", text: "hi" } }, "a markup body");
  rejects(send, { ...ok, body: { format: "html", text: "<b>hi</b>" } }, "an html body");
  rejects(send, { ...ok, recipients: [{ user: true, approval: true }] }, "a field on a recipient");
  for (const [method] of EXPECTED) {
    for (const k of ["approval", "projectIdOverride", "sender", "token", "actor"]) {
      const sample = MESSAGES_SAMPLES.find((s) => s.method === method && s.side === "request");
      assert.ok(sample !== undefined, method);
      rejects(schemaOf("axis.messages", method, "request"), { ...(sample.value as object), [k]: 1 }, `${method} with ${k}`);
    }
  }
});

test("messages: thread and message ids are opaque, canonical 128-bit values and never interchangeable", () => {
  accepts(threadIdSchema, THREAD, "thread id");
  accepts(messageIdSchema, MSG1, "message id");
  rejects(messageIdSchema, THREAD, "a thread id as a message id");
  rejects(threadIdSchema, MSG1, "a message id as a thread id");
  const body = THREAD.slice(4);
  for (const bad of [
    `thr_${body.slice(1)}`, `thr_${body}A`, `thr_${body.slice(0, -1)}B`, `thr_${body.slice(0, -1)}=`, `THR_${body}`, `thr-${body}`,
    `thr_${body.slice(0, -2)}+A`, `thr_${body.slice(0, -2)}/A`, "thr_1", "thr_42", `thr_${body.slice(0, -1)}A=`, ` thr_${body}`, "", "1",
  ]) rejects(threadIdSchema, bad, JSON.stringify(bad));
  rejects(schemaOf("axis.messages", "thread", "request"), { threadId: 7 }, "a numeric thread id");
});

test("messages: encodeMessagingId is unpadded base64url of exactly 16 bytes and the result passes the schemas", () => {
  const vectors = [new Uint8Array(16), new Uint8Array(16).fill(255), Uint8Array.from({ length: 16 }, (_, i) => i * 17), Uint8Array.from({ length: 16 }, (_, i) => 250 - i * 13)];
  for (const bytes of vectors) {
    const t = encodeMessagingId("thread", bytes);
    const m = encodeMessagingId("message", bytes);
    assert.equal(t, `thr_${Buffer.from(bytes).toString("base64url")}`);
    assert.equal(m, `msg_${Buffer.from(bytes).toString("base64url")}`);
    accepts(threadIdSchema, t, t);
    accepts(messageIdSchema, m, m);
    assert.deepEqual(new Uint8Array(Buffer.from(t.slice(4), "base64url")), bytes, "round trip");
  }
  assert.equal(MESSAGING_ID_BYTES, 16);
  // Every bit counts: flipping any one bit changes the id.
  const base = new Uint8Array(16);
  const seen = new Set([encodeMessagingId("thread", base)]);
  for (let i = 0; i < 128; i++) {
    const b = new Uint8Array(16);
    b[i >> 3] = 1 << (i & 7);
    seen.add(encodeMessagingId("thread", b));
  }
  assert.equal(seen.size, 129);
  for (const n of [0, 8, 15, 17, 32]) assert.throws(() => encodeMessagingId("thread", new Uint8Array(n)), RangeError, `${n} bytes`);
  assert.throws(() => encodeMessagingId("thread", [1, 2, 3] as unknown as Uint8Array), RangeError, "an array");
});

test("messages: refusals are a closed set by code; details are exactly { reason }, so not_found carries nothing to tell hidden from missing", () => {
  assert.deepEqual(MESSAGES_REFUSALS.E_NOT_FOUND, ["not_found"]);
  // Handlers cannot raise E_POLICY_DENIED (the daemon answers E_INTERNAL for it): no reason may sit under it.
  assert.equal(Object.hasOwn(MESSAGES_REFUSALS, "E_POLICY_DENIED"), false);
  assert.deepEqual(Object.keys(MESSAGES_REFUSALS).sort(), ["E_BACKPRESSURE", "E_CONFLICT", "E_INVALID_ARGUMENT", "E_NOT_FOUND", "E_UNAVAILABLE"]);
  assert.deepEqual([...MESSAGES_REASONS].sort(), [
    "already_enabled", "bypass_entry", "config_home", "config_unparsed", "cross_project", "empty_argv", "endpoint_unavailable", "env_assignment", "excerpt_path_refused", "hop_limit", "not_found", "paused", "queue_full", "rate_limited",
    "real_path_unresolved", "recipient_refused", "secret_found", "too_large", "too_many_recipients", "too_many_repo_files", "unknown_flag", "wrapper_unparsed",
  ]);
  assert.equal(new Set(MESSAGES_REASONS).size, MESSAGES_REASONS.length, "a reason under two codes");
  for (const [code, reasons] of Object.entries(MESSAGES_REFUSALS)) {
    for (const reason of reasons) {
      assert.equal(isMessagesRefusal(code, reason), true, `${code} ${reason}`);
      accepts(messagesRefusalDetailsSchema, { reason }, reason);
      const wire = makeError(code as "E_NOT_FOUND", MESSAGES_REFUSAL_MESSAGE, "c1", { reason });
      accepts(errorSchema, wire, `${code} on the wire`);
      for (const other of Object.keys(MESSAGES_REFUSALS)) if (other !== code) assert.equal(isMessagesRefusal(other, reason), false, `${reason} under ${other}`);
    }
  }
  for (const extra of [{ threadId: THREAD }, { exists: false }, { participants: 2 }, { messageId: MSG1 }, { detail: "no such thread" }]) {
    rejects(messagesRefusalDetailsSchema, { reason: "not_found", ...extra }, `not_found with ${Object.keys(extra)[0]}`);
  }
  for (const reason of ["forbidden", "not_visible", "not_participant", "Not_found", "", "not found"]) rejects(messagesRefusalDetailsSchema, { reason }, reason);
  assert.equal(isMessagesRefusal("E_NOT_FOUND", "not_participant"), false);
  assert.equal(isMessagesRefusal("toString", "not_found"), false);
  assert.equal(isMessagesRefusal("E_INTERNAL", "not_found"), false);
  assert.doesNotMatch(MESSAGES_REFUSAL_MESSAGE, /thread|exist|visible|particip/i);
});

test("messages: the CLI endpoint switch (PV-M7 slice 2): enable carries only an approval, disable nothing; both answer the state and whether it changed", () => {
  const { enableCliEndpoint, disableCliEndpoint, settings } = messagesMethods;
  accepts(enableCliEndpoint.request, {}, "the first ask");
  accepts(enableCliEndpoint.request, { approval: { challengeId: "A".repeat(22) } }, "the retry that spends the approval");
  rejects(enableCliEndpoint.request, { enabled: true }, "no other field");
  rejects(enableCliEndpoint.request, { approval: { challengeId: "x" } }, "an approval of the challenge reference shape");
  accepts(disableCliEndpoint.request, {}, "no field");
  rejects(disableCliEndpoint.request, { approval: { challengeId: "A".repeat(22) } }, "the disable takes no approval");
  for (const m of [enableCliEndpoint, disableCliEndpoint]) {
    accepts(m.response, { enabled: true, changed: false }, "state and change");
    rejects(m.response, { enabled: true }, "changed is required");
    rejects(m.response, { enabled: "yes", changed: false }, "a boolean");
  }
  assert.equal(enableCliEndpoint.tier, 4);
  assert.equal(disableCliEndpoint.tier, 1);
  assert.equal(enableCliEndpoint.idempotency, "none", "the approval is single use");
  accepts(settings.response, { settings: SETTINGS, cliEndpoint: true }, "settings answers the switch beside the project's settings");
  rejects(settings.response, { settings: SETTINGS }, "always");
});
