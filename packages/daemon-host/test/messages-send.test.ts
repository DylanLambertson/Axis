// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_HOP, messageSchema, threadIdSchema, messageIdSchema } from "@axis/protocol";
import { USER, agent, auditRows, messagesRig, outcome, plugin, sendReq, type MessagesRig } from "./messages-rig.js";

// axis.messages/1 send (ticket PV-M3 slice 1): the send policy at accept, the project of a thread, participation, hop.

function setup(t: { after(fn: () => void): void }, limits?: NonNullable<Parameters<typeof messagesRig>[0]>["limits"]): MessagesRig {
  const r = messagesRig(limits === undefined ? {} : { limits });
  t.after(() => r.close());
  return r;
}
const svc = (r: MessagesRig) => r.binding.service;

test("the user opens a thread with an agent: the daemon fills project, seq, sender, hop and ids; the body is stored raw", async (t) => {
  const r = setup(t);
  const { message, replayed } = await svc(r).send(USER, sendReq([{ agent: "a1" }], "hi\u001b]52;c;x\u0007 \\u{1b}"));
  assert.equal(replayed, false);
  assert.ok(messageSchema.safeParse(message).success);
  assert.deepEqual([message.projectId, message.seq, message.sender, message.hop, message.inReplyTo], ["p1", 1, { kind: "user", verified: true }, 0, null]);
  assert.deepEqual(message.expanded, [{ kind: "agent", agentId: "a1" }]);
  assert.ok(threadIdSchema.safeParse(message.threadId).success && messageIdSchema.safeParse(message.messageId).success);
  assert.deepEqual(r.drawn, [16, 16], "a thread id and a message id, 16 random bytes each");
  // Escaped on the way out (ESC, BEL, and the typed backslash), stored as the sender wrote it.
  assert.equal(message.body.text, "hi\\u{1b}]52;c;x\\u{7} \\\\u{1b}");
  assert.equal(r.journal.messages.message(message.messageId)?.body, "hi\u001b]52;c;x\u0007 \\u{1b}");
  assert.deepEqual(r.journal.messages.participants(message.threadId).map((p) => p.principal), ["user", "agent:a1"]);
});

test("a CLI endpoint sender stays unverified on the wire and in the audit row; the sender comes from the caller only", async (t) => {
  const r = setup(t);
  const { message } = await svc(r).send(agent("c1", { verified: false, runId: "run-c1" }), sendReq([{ user: true }], "from the endpoint"));
  assert.deepEqual(message.sender, { kind: "agent", agentId: "c1", runId: "run-c1", verified: false });
  const row = auditRows(r).find((e) => e.action === "message.send");
  assert.deepEqual([row?.actor, row?.payload["verified"], row?.payload["callerId"]], ["agent:c1", false, "c1"]);
  const composer = (await svc(r).send(agent("a1", { runId: null }), sendReq([{ user: true }]))).message;
  assert.deepEqual(composer.sender, { kind: "agent", agentId: "a1", runId: null, verified: true });
});

test("ids are random, unique and say nothing: a thousand sends give a thousand distinct ids", async (t) => {
  const r = setup(t);
  const ids = new Set<string>();
  let thread: string | undefined;
  for (let i = 0; i < 200; i++) {
    const { message } = await svc(r).send(USER, sendReq([{ agent: "a1" }], `m${i}`, thread === undefined ? {} : { threadId: thread }));
    thread ??= message.threadId;
    ids.add(message.messageId);
  }
  assert.equal(ids.size, 200);
  assert.equal(new Set([...ids].map((id) => id.slice(4, 10))).size > 150, true, "no shared prefix: not a counter");
});

test("send policy: the agent's group, cross-group settings and pairs, accepts-from, self and other projects", async (t) => {
  const r = setup(t);
  const s = svc(r);
  const settings = r.binding.settings;
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ agent: "a2" }]))), "ok", "own group");
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ user: true }]))), "ok", "the user");
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ agent: "b1" }]))), "E_CONFLICT/recipient_refused", "another group, cross-group off");
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ agent: "a1" }]))), "E_CONFLICT/recipient_refused", "itself");
  assert.equal(await outcome(() => s.send(USER, sendReq([{ user: true }]))), "E_CONFLICT/recipient_refused", "the user to itself");
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ agent: "x1" }]))), "E_CONFLICT/recipient_refused", "another project, to an agent");
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ agent: "ghost" }]))), "E_CONFLICT/recipient_refused", "unknown, same answer");
  assert.equal(await outcome(() => s.send(USER, sendReq([{ agent: "a1" }, { agent: "x1" }]))), "E_CONFLICT/cross_project", "the user, spanning projects");
  assert.equal(await outcome(() => s.send(USER, sendReq([{ agent: "a1" }, { agent: "ghost" }]))), "E_CONFLICT/recipient_refused");
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ agent: "c1" }]))), "E_CONFLICT/recipient_refused", "a CLI agent accepts from none");
  settings.updateSettings(USER, { setting: "crossGroupPair", projectId: "p1", groups: ["g2", "g1"], value: true });
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ agent: "b1" }]))), "E_CONFLICT/recipient_refused", "b1 still accepts from its group only");
  settings.updateSettings(USER, { setting: "acceptsFrom", agentId: "b1", value: "project" });
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ agent: "b1" }]))), "ok", "pair on and b1 accepts from the project");
  settings.updateSettings(USER, { setting: "crossGroupPair", projectId: "p1", groups: ["g1", "g2"], value: false });
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ agent: "b1" }]))), "E_CONFLICT/recipient_refused", "pair off");
  settings.updateSettings(USER, { setting: "crossGroup", projectId: "p1", value: true });
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ agent: "b1" }]))), "ok", "cross-group on");
  settings.updateSettings(USER, { setting: "acceptsFrom", agentId: "a2", value: "none" });
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ agent: "a2" }]))), "E_CONFLICT/recipient_refused", "accepts from none");
  assert.equal(await outcome(() => s.send(USER, sendReq([{ agent: "a2" }]))), "ok", "the user is not an agent sender");
  assert.equal(await outcome(() => s.send(agent("ghost"), sendReq([{ user: true }]))), "E_CONFLICT/recipient_refused", "an unknown sender");
  assert.equal(await outcome(() => s.send(plugin("acme.bot"), sendReq([{ user: true }]))), "E_CONFLICT/recipient_refused", "a plugin cannot open a thread");
});

test("groups expand at accept, without the sender; any refused member refuses the whole send; broadcast is bounded", async (t) => {
  const r = setup(t, { queuePerRecipient: 200 });
  const s = svc(r);
  const { message } = await s.send(USER, sendReq([{ group: "g1" }]));
  assert.deepEqual(message.expanded.map((p) => (p.kind === "agent" ? p.agentId : p.kind)), ["a1", "a2", "c1"]);
  assert.deepEqual(message.recipients, [{ group: "g1" }], "recorded as named");
  // a1 to its own group: c1 accepts from none, so nothing is sent at all.
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ group: "g1" }]))), "E_CONFLICT/recipient_refused");
  r.groups.set("g1", { groupId: "g1", projectId: "p1", members: ["a1", "a2"] });
  const own = await s.send(agent("a1"), sendReq([{ group: "g1" }]));
  assert.deepEqual(own.message.expanded, [{ kind: "agent", agentId: "a2" }], "the sender is not its own recipient");
  r.groups.set("solo", { groupId: "solo", projectId: "p1", members: ["a1"] });
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ group: "solo" }]))), "E_CONFLICT/recipient_refused", "an empty expansion");
  assert.equal(await outcome(() => s.send(USER, sendReq([{ group: "gx" }, { agent: "a1" }]))), "E_CONFLICT/cross_project");
  const big = Array.from({ length: 17 }, (_, i) => `z${i}`);
  for (const id of big) r.agents.set(id, { agentId: id, projectId: "p1", groupId: "big", kind: "composer" });
  r.groups.set("big", { groupId: "big", projectId: "p1", members: big });
  assert.equal(await outcome(() => s.send(USER, sendReq([{ group: "big" }]))), "E_INVALID_ARGUMENT/too_many_recipients");
});

test("posting needs participation; every recipient passes the policy again (NS1); new recipients join from that message", async (t) => {
  const r = setup(t);
  const s = svc(r);
  r.binding.settings.updateSettings(USER, { setting: "crossGroup", projectId: "p1", value: true });
  r.binding.settings.updateSettings(USER, { setting: "acceptsFrom", agentId: "b1", value: "project" });
  r.binding.settings.updateSettings(USER, { setting: "acceptsFrom", agentId: "a1", value: "project" });
  const { message: first } = await s.send(agent("a1"), sendReq([{ agent: "b1" }]));
  const threadId = first.threadId;
  assert.equal(await outcome(() => s.send(agent("a2"), sendReq([{ agent: "a1" }], "x", { threadId }))), "E_NOT_FOUND/not_found", "a2 is no participant");
  assert.equal(await outcome(() => s.send(agent("b1"), sendReq([{ agent: "a1" }], "x", { threadId }))), "ok");
  // The user turns cross-group off: b1 stays a participant but a1 may no longer address it, inside the thread too.
  r.binding.settings.updateSettings(USER, { setting: "crossGroup", projectId: "p1", value: false });
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ agent: "b1" }], "x", { threadId }))), "E_CONFLICT/recipient_refused");
  // An agent of another project, named inside an existing thread: refused (cross_project only to the user).
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ agent: "x1" }], "x", { threadId }))), "E_CONFLICT/recipient_refused");
  assert.equal(await outcome(() => s.send(USER, sendReq([{ agent: "x1" }], "x", { threadId }))), "E_CONFLICT/cross_project");
  assert.equal(await outcome(() => s.send(USER, sendReq([{ group: "gx" }], "x", { threadId }))), "E_CONFLICT/cross_project");
  // a1 adds a2 (its group): a2 joins and reads from that message on, not the history.
  const { message: third } = await s.send(agent("a1"), sendReq([{ agent: "a2" }], "welcome", { threadId }));
  const a2 = r.journal.messages.participant(threadId, "agent:a2");
  assert.equal(a2?.joinedSeq, third.seq - 1);
  assert.deepEqual(s.thread(agent("a2"), { threadId }).messages.map((m) => m.seq), [third.seq]);
  // Nobody addresses itself inside a thread either (the new-thread path refuses it earlier, so this is its own check).
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ agent: "a1" }], "x", { threadId }))), "E_CONFLICT/recipient_refused");
  assert.equal(await outcome(() => s.send(USER, sendReq([{ user: true }], "x", { threadId }))), "E_CONFLICT/recipient_refused");
  // The user posts into any thread of the project and joins it.
  assert.equal(await outcome(() => s.send(USER, sendReq([{ agent: "a1" }], "note", { threadId }))), "ok");
  assert.ok(r.journal.messages.participant(threadId, "user") !== undefined);
});

test("inReplyTo names a message of the same thread the sender can read, or the send is not_found", async (t) => {
  const r = setup(t);
  const s = svc(r);
  const one = (await s.send(USER, sendReq([{ agent: "a1" }], "to a1"))).message;
  const other = (await s.send(USER, sendReq([{ agent: "a2" }], "to a2"))).message;
  const th = one.threadId;
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ user: true }], "re", { threadId: th, inReplyTo: one.messageId }))), "ok");
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ user: true }], "re", { threadId: th, inReplyTo: other.messageId }))), "E_NOT_FOUND/not_found", "another thread");
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ user: true }], "re", { inReplyTo: one.messageId }))), "E_NOT_FOUND/not_found", "no thread");
  // a2 joins later and cannot reply to a message it never saw.
  const late = (await s.send(USER, sendReq([{ agent: "a2" }], "join", { threadId: th }))).message;
  assert.equal(await outcome(() => s.send(agent("a2"), sendReq([{ user: true }], "re", { threadId: th, inReplyTo: one.messageId }))), "E_NOT_FOUND/not_found");
  assert.equal(await outcome(() => s.send(agent("a2"), sendReq([{ user: true }], "re", { threadId: th, inReplyTo: late.messageId }))), "ok");
});

test("hop: 0 for the user, one past what the run received and what it replies to; refused past MAX_HOP or when forged", async (t) => {
  const r = setup(t);
  const s = svc(r);
  assert.equal((await s.send(agent("a1", { receivedHop: 3 }), sendReq([{ agent: "a2" }]))).message.hop, 4);
  const deep = (await s.send(agent("a1", { receivedHop: MAX_HOP - 1 }), sendReq([{ agent: "a2" }]))).message;
  assert.equal(deep.hop, MAX_HOP);
  // a2 replies with nothing received on record: the reply is still one past the message it answers, so past the cap.
  assert.equal(await outcome(() => s.send(agent("a2"), sendReq([{ agent: "a1" }], "re", { threadId: deep.threadId, inReplyTo: deep.messageId }))), "E_CONFLICT/hop_limit");
  for (const forged of [MAX_HOP, MAX_HOP + 1, -1, 1.5, Number.NaN, 2 ** 60]) {
    assert.equal(await outcome(() => s.send(agent("a1", { receivedHop: forged }), sendReq([{ agent: "a2" }]))), "E_CONFLICT/hop_limit", String(forged));
  }
  const userReply = (await s.send(USER, sendReq([{ agent: "a1" }], "stop", { threadId: deep.threadId, inReplyTo: deep.messageId }))).message;
  assert.equal(userReply.hop, 0, "the user's message never carries a hop");
});

test("every refusal is audited with ids and a closed reason; no row carries the body", async (t) => {
  const r = setup(t);
  const s = svc(r);
  const canary = "canary-7f3a9-body-text";
  const { message } = await s.send(agent("a1", { runId: "run-9" }), sendReq([{ agent: "a2" }], canary));
  await outcome(() => s.send(agent("a1"), sendReq([{ agent: "b1" }], canary)));
  const rows = auditRows(r).filter((e) => e.action.startsWith("message."));
  assert.deepEqual(rows.map((e) => [e.action, e.actor]), [["message.send", "agent:a1"], ["message.send.refused", "agent:a1"]]);
  assert.deepEqual(rows[0]?.payload, { callerKind: "agent", callerId: "a1", runId: "run-9", verified: true, messageId: message.messageId, threadId: message.threadId, projectId: "p1", newThread: true, recipientCount: 1, expandedCount: 1, bodyLength: canary.length, refsCount: 0, hop: 1 });
  assert.equal(rows[1]?.payload["reason"], "recipient_refused");
  const dump = JSON.stringify(r.db.prepare("SELECT * FROM audit_events").all());
  assert.equal(dump.includes(canary), false, "no audit row holds the text");
  assert.equal(/[0-9a-f]{64}/.test(JSON.stringify(rows)), false, "no hash of a body");
});

test("the secret scan refuses; warn applies only when every recipient is a composer agent or the user; excerpts are refused", async (t) => {
  const r = setup(t);
  const s = svc(r);
  r.scanResult = 1;
  assert.equal(await outcome(() => s.send(USER, sendReq([{ agent: "a1" }]))), "E_CONFLICT/secret_found");
  r.binding.settings.updateSettings(USER, { setting: "secretScan", projectId: "p1", value: "warn" });
  assert.equal(await outcome(() => s.send(USER, sendReq([{ agent: "a1" }]))), "ok", "warn, a composer recipient");
  assert.equal(await outcome(() => s.send(USER, sendReq([{ agent: "c1" }]))), "E_CONFLICT/secret_found", "warn never covers a CLI agent");
  r.scanResult = "throw";
  assert.equal(await outcome(() => s.send(USER, sendReq([{ agent: "a1" }]))), "E_CONFLICT/secret_found", "a scan that cannot finish refuses");
  r.scanResult = 0;
  const excerpt = { type: "excerpt" as const, workspaceId: "w1", path: "src/a.ts", startLine: 1, endLine: 2 };
  assert.equal(await outcome(() => s.send(USER, sendReq([{ agent: "a1" }], "x", { refs: [excerpt] }))), "E_CONFLICT/excerpt_path_refused");
  // A request the contract refuses (a bidi character in a path) is refused by the service too, whoever calls it.
  const bidi = { type: "file" as const, workspaceId: "w1", path: "src/\u202eevil.ts" };
  await assert.rejects(s.send(USER, sendReq([{ agent: "a1" }], "x", { refs: [bidi] })), { name: "InvalidMessageRequest" });
  const file = { type: "file" as const, workspaceId: "w1", path: "src/a b.ts" };
  const { message } = await s.send(USER, sendReq([{ agent: "a1" }], "x", { refs: [file, { type: "pr", number: 7 }] }));
  assert.deepEqual(message.refs, [{ type: "file", workspaceId: "w1", displayPath: "src/a b.ts" }, { type: "pr", number: 7 }], "a path leaves only as display text");
  assert.ok(!auditRows(r).some((e) => JSON.stringify(e).includes("generic-secret")), "no finding text in the audit");
});
