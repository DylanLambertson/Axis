// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_BODY_CHARS, encodeMessagingId, messagesMethods } from "@axis/protocol";
import { USER, agent, auditRows, messagesRig, outcome, sendReq, type MessagesRig } from "./messages-rig.js";

// axis.messages/1 reads (ticket PV-M3 slice 1, inter-agent-communication.md section 4.2): participant-only reads, the
// user reads every thread, and a hidden thread answers exactly like a missing one.

function setup(t: { after(fn: () => void): void }, limits?: NonNullable<Parameters<typeof messagesRig>[0]>["limits"]): MessagesRig {
  const r = messagesRig(limits === undefined ? {} : { limits });
  t.after(() => r.close());
  return r;
}

test("participant-only reads: a non-participant gets not_found on every method; threads lists only its own; the user sees all", async (t) => {
  const r = setup(t);
  const s = r.binding.service;
  const mine = (await s.send(USER, sendReq([{ agent: "a1" }], "for a1"))).message;
  const theirs = (await s.send(USER, sendReq([{ agent: "b1" }], "for b1"))).message;
  const a1 = agent("a1");
  assert.deepEqual(s.threads(a1, {}).threads.map((x) => x.threadId), [mine.threadId]);
  assert.deepEqual(new Set(s.threads(USER, {}).threads.map((x) => x.threadId)), new Set([mine.threadId, theirs.threadId]));
  assert.deepEqual(s.threads(USER, { projectId: "p2" }).threads, [], "a filter, not authority");
  for (const call of [
    () => s.thread(a1, { threadId: theirs.threadId }),
    () => s.read(a1, { threadId: theirs.threadId }),
    () => s.markRead(a1, { threadId: theirs.threadId, throughSeq: 1 }),
    () => s.send(a1, sendReq([{ user: true }], "x", { threadId: theirs.threadId })),
  ]) assert.equal(await outcome(call), "E_NOT_FOUND/not_found");
  assert.deepEqual(s.read(a1, {}).messages.map((m) => m.messageId), [mine.messageId], "the inbox holds only what is addressed to a1");
  assert.equal(s.thread(USER, { threadId: theirs.threadId }).messages.length, 1, "the user reads every thread");
  assert.ok(messagesMethods.threads.response.safeParse(s.threads(USER, {})).success);
});

/** Record every store and audit call the service makes while `fn` runs, by name and argument shape (no values). */
async function trace(r: MessagesRig, fn: () => unknown): Promise<string[]> {
  const calls: string[] = [];
  const store = r.journal.messages as unknown as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(store))) {
    const f = store[name];
    if (name === "constructor" || typeof f !== "function") continue;
    saved.set(name, f);
    store[name] = (...args: unknown[]) => (calls.push(`${name}(${args.map((a) => typeof a).join(",")})`), (f as (...a: unknown[]) => unknown).apply(r.journal.messages, args));
  }
  const append = r.audit.append.bind(r.audit);
  r.audit.append = ((e: Parameters<typeof append>[0]) => (calls.push(`audit(${e.action},${Object.keys(e.payload as object).sort().join(",")})`), append(e))) as typeof r.audit.append;
  try {
    await outcome(fn);
  } finally {
    for (const [name, f] of saved) store[name] = f;
    r.audit.append = append;
  }
  return calls;
}

test("no existence oracle: a hidden thread and a missing id take the same path, answer the same and audit the same", async (t) => {
  const r = setup(t);
  const s = r.binding.service;
  const hidden = (await s.send(USER, sendReq([{ agent: "b1" }], "secret plan"))).message;
  const missing = encodeMessagingId("thread", randomBytes(16));
  const a1 = agent("a1");
  for (const [name, call] of [
    ["thread", (id: string) => () => s.thread(a1, { threadId: id })],
    ["read", (id: string) => () => s.read(a1, { threadId: id })],
    ["markRead", (id: string) => () => s.markRead(a1, { threadId: id, throughSeq: 1 })],
    ["send", (id: string) => () => s.send(a1, sendReq([{ user: true }], "x", { threadId: id }))],
  ] as const) {
    const errors: unknown[] = [];
    for (const id of [hidden.threadId, missing]) {
      try {
        await call(id)();
      } catch (e) {
        errors.push({ ...(e as object), name: (e as Error).name, message: (e as Error).message });
      }
    }
    assert.deepEqual(errors[0], errors[1], `${name}: the same refusal`);
    assert.deepEqual(await trace(r, call(hidden.threadId)), await trace(r, call(missing)), `${name}: the same store lookups and audit row`);
  }
  const refused = auditRows(r).filter((e) => e.action === "message.read.refused" || e.action === "message.send.refused");
  const shape = (e: (typeof refused)[number]) => ({ ...e, target: "", payload: { ...e.payload, threadId: "" } });
  assert.deepEqual(shape(refused[0]!), shape(refused[1]!), "rows differ only in the requested id");
  assert.equal(refused[0]?.payload["threadId"], hidden.threadId, "the requested id is recorded (section 4.2)");
  assert.equal(refused[0]?.payload["reason"], "not_found");
});

test("id guessing: random well-formed ids, and the ids of other threads' messages, all answer not_found", async (t) => {
  const r = setup(t);
  const s = r.binding.service;
  const real = (await s.send(USER, sendReq([{ agent: "b1" }]))).message;
  const a1 = agent("a1");
  for (let i = 0; i < 50; i++) assert.equal(await outcome(() => s.thread(a1, { threadId: encodeMessagingId("thread", randomBytes(16)) })), "E_NOT_FOUND/not_found");
  // A message id where a thread id goes is refused by the contract before any lookup.
  assert.throws(() => s.thread(a1, { threadId: real.messageId }), { name: "InvalidMessageRequest" });
});

test("paging: the message cap, the text cap (one message always fits), the cursor past the end and complete", async (t) => {
  const r = setup(t);
  const s = r.binding.service;
  const widest = "\u202e".repeat(MAX_BODY_CHARS); // escapes to 8 units each: a body at its display maximum
  const first = (await s.send(USER, sendReq([{ agent: "a1" }], widest))).message;
  const threadId = first.threadId;
  await s.send(USER, sendReq([{ agent: "a1" }], widest, { threadId }));
  for (let i = 0; i < 40; i++) await s.send(USER, sendReq([{ agent: "a1" }], `small ${i}`, { threadId }));
  const p1 = s.thread(USER, { threadId });
  assert.deepEqual([p1.messages.map((m) => m.seq), p1.nextSeq, p1.complete], [[1], 1, false], "the second wide body does not fit beside the first");
  const p2 = s.thread(USER, { threadId, afterSeq: p1.nextSeq });
  assert.deepEqual([p2.messages.length, p2.messages[0]?.seq, p2.complete], [32, 2, false], "the message cap");
  const p3 = s.thread(USER, { threadId, afterSeq: p2.nextSeq, limit: 32 });
  assert.deepEqual([p3.messages.length, p3.nextSeq, p3.complete], [9, 42, true]);
  const past = s.thread(USER, { threadId, afterSeq: 9_999 });
  assert.deepEqual([past.messages.length, past.nextSeq, past.complete], [0, 42, true], "a cursor past the end is an empty page");
  for (const page of [p1, p2, p3, past]) assert.ok(messagesMethods.thread.response.safeParse(page).success);
  const inbox = s.read(agent("a1"), {});
  assert.deepEqual([inbox.messages.length, inbox.more], [1, true]);
  assert.ok(messagesMethods.read.response.safeParse(inbox).success);
});

test("markRead moves the caller's own cursor forward only, clamps at the thread's end and drives unread and the inbox", async (t) => {
  const r = setup(t);
  const s = r.binding.service;
  const m1 = (await s.send(USER, sendReq([{ agent: "a1" }], "one"))).message;
  const threadId = m1.threadId;
  await s.send(USER, sendReq([{ agent: "a1" }], "two", { threadId }));
  const a1 = agent("a1");
  assert.deepEqual(s.markRead(a1, { threadId, throughSeq: 1 }), { threadId, readThrough: 1, unread: 1 });
  assert.deepEqual(s.markRead(a1, { threadId, throughSeq: 1_000 }), { threadId, readThrough: 2, unread: 0 }, "clamped at lastSeq");
  assert.deepEqual(s.markRead(a1, { threadId, throughSeq: 1 }), { threadId, readThrough: 2, unread: 0 }, "never back");
  assert.deepEqual(s.read(a1, {}).messages, []);
  assert.equal(s.threads(USER, {}).threads[0]?.unread, 0, "the user's own cursor is separate and nothing was addressed to it");
});

test("quotas: per-sender and per-recipient queues refuse when full and never drop; the user is never queued out", async (t) => {
  const r = setup(t, { queuePerSender: 2, queuePerRecipient: 3 });
  const s = r.binding.service;
  r.binding.settings.updateSettings(USER, { setting: "crossGroup", projectId: "p1", value: true });
  r.binding.settings.updateSettings(USER, { setting: "acceptsFrom", agentId: "a2", value: "project" });
  const user = (await s.send(USER, sendReq([{ agent: "a2" }], "from the user"))).message;
  for (let i = 0; i < 2; i++) assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ agent: "a2" }]))), "ok");
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ agent: "a2" }]))), "E_BACKPRESSURE/queue_full", "a1's quota");
  assert.equal(await outcome(() => s.send(agent("b1"), sendReq([{ agent: "a2" }]))), "ok", "another sender still fits");
  assert.equal(await outcome(() => s.send(agent("b1"), sendReq([{ agent: "a2" }]))), "E_BACKPRESSURE/queue_full", "the recipient's queue");
  assert.equal(await outcome(() => s.send(USER, sendReq([{ agent: "a2" }]))), "ok", "the user is never refused for a full queue");
  const inbox = s.read(agent("a2"), {}).messages;
  assert.equal(inbox[0]?.messageId, user.messageId, "nothing queued was dropped, the user's first");
  assert.equal(inbox.length, 5);
  for (const m of inbox) s.markRead(agent("a2"), { threadId: m.threadId, throughSeq: m.seq });
  assert.equal(await outcome(() => s.send(agent("a1"), sendReq([{ agent: "a2" }]))), "ok", "read messages free the quota");
});

test("limits: sends per minute, per run and per project, reads per minute, thread and project size", async (t) => {
  const r = setup(t, { sendsPerMinute: 3, sendsPerRun: 4, projectSendsPerMinute: 5, readsPerMinute: 2, messagesPerThread: 3, threadsPerProject: 6 });
  const s = r.binding.service;
  const a1 = agent("a1", { runId: "run-1" });
  for (let i = 0; i < 3; i++) assert.equal(await outcome(() => s.send(a1, sendReq([{ user: true }]))), "ok");
  assert.equal(await outcome(() => s.send(a1, sendReq([{ user: true }]))), "E_BACKPRESSURE/rate_limited", "per sender and minute");
  assert.equal(await outcome(() => s.send(a1, sendReq([{ user: true }]))), "E_BACKPRESSURE/rate_limited", "again, in the same minute: not audited again");
  for (let i = 0; i < 2; i++) assert.equal(await outcome(() => s.send(agent("a2"), sendReq([{ user: true }]))), "ok");
  assert.equal(await outcome(() => s.send(agent("b1"), sendReq([{ user: true }]))), "E_BACKPRESSURE/rate_limited", "per project and minute");
  r.clock.advance(60_000);
  assert.equal(await outcome(() => s.send(a1, sendReq([{ user: true }]))), "ok", "a new minute");
  r.clock.advance(60_000);
  assert.equal(await outcome(() => s.send(a1, sendReq([{ user: true }]))), "E_BACKPRESSURE/rate_limited", "per run: a fifth send of run-1");
  assert.equal(await outcome(() => s.send(agent("a1", { runId: "run-2" }), sendReq([{ user: true }]))), "E_BACKPRESSURE/queue_full", "a new run, but six threads in the project");
  const own = s.threads(USER, {}).threads[0]!;
  for (let i = 0; i < 2; i++) await s.send(USER, sendReq([{ agent: "b1" }], "more", { threadId: own.threadId }));
  assert.equal(await outcome(() => s.send(USER, sendReq([{ agent: "b1" }], "more", { threadId: own.threadId }))), "E_INVALID_ARGUMENT/too_large", "a full thread");
  const b1 = agent("b1");
  for (let i = 0; i < 2; i++) s.threads(b1, {});
  assert.equal(await outcome(() => s.threads(b1, {})), "E_BACKPRESSURE/rate_limited", "reads per minute");
  for (let i = 0; i < 10; i++) s.threads(USER, {});
  assert.equal(await outcome(() => s.threads(b1, {})), "E_BACKPRESSURE/rate_limited");
  const limited = auditRows(r).filter((e) => e.payload["reason"] === "rate_limited").map((e) => `${e.action}:${e.actor}`);
  assert.deepEqual(limited.sort(), ["message.read.refused:agent:b1", "message.send.refused:agent:a1", "message.send.refused:agent:a1", "message.send.refused:agent:b1"], "one row per caller and minute (a1 in two minutes), never one per attempt");
});

test("a thread holds at most 64 participants", async (t) => {
  const r = setup(t);
  const s = r.binding.service;
  const ids = Array.from({ length: 70 }, (_, i) => `m${i}`);
  for (const id of ids) r.agents.set(id, { agentId: id, projectId: "p1", groupId: null, kind: "composer" });
  const threadId = (await s.send(USER, sendReq(ids.slice(0, 16).map((agent) => ({ agent }))))).message.threadId;
  for (let k = 16; k < 63; k += 16) await s.send(USER, sendReq(ids.slice(k, Math.min(k + 16, 63)).map((agent) => ({ agent })), "x", { threadId }));
  assert.equal(r.journal.messages.participants(threadId).length, 64, "the user and 63 agents");
  assert.equal(await outcome(() => s.send(USER, sendReq([{ agent: "m63" }], "x", { threadId }))), "E_INVALID_ARGUMENT/too_many_recipients");
  assert.equal(await outcome(() => s.send(USER, sendReq([{ agent: "m0" }], "x", { threadId }))), "ok", "existing participants still receive");
});

test("concurrent posts and reads: every message gets its own seq, in order, and each read is a consistent prefix", async (t) => {
  const r = setup(t);
  const s = r.binding.service;
  const threadId = (await s.send(USER, sendReq([{ agent: "a1" }], "start"))).message.threadId;
  const reads: number[][] = [];
  await Promise.all(
    Array.from({ length: 60 }, (_, i) =>
      i % 3 === 0
        ? Promise.resolve().then(() => reads.push(s.thread(USER, { threadId }).messages.map((m) => m.seq)))
        : s.send(i % 2 === 0 ? USER : agent("a1"), sendReq([i % 2 === 0 ? { agent: "a1" } : { user: true }], `m${i}`, { threadId })),
    ),
  );
  const all = s.thread(USER, { threadId, limit: 32 });
  const seqs = [all, s.thread(USER, { threadId, afterSeq: all.nextSeq })].flatMap((p) => p.messages.map((m) => m.seq));
  assert.deepEqual(seqs, Array.from({ length: 41 }, (_, i) => i + 1));
  for (const page of reads) assert.deepEqual(page, page.map((_, i) => i + 1), "no gap, no duplicate");
});

test("restart: threads, participants, cursors and settings survive reopening the journal; a reader resumes where it was", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "axis-msg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "journal.db");
  const r1 = messagesRig({ path });
  const m = (await r1.binding.service.send(USER, sendReq([{ agent: "a1" }], "persist"))).message;
  await r1.binding.service.send(USER, sendReq([{ agent: "a1" }], "two", { threadId: m.threadId }));
  r1.binding.service.markRead(agent("a1"), { threadId: m.threadId, throughSeq: 1 });
  r1.binding.settings.updateSettings(USER, { setting: "crossGroup", projectId: "p1", value: true });
  r1.close();
  const r2 = messagesRig({ path });
  t.after(() => r2.close());
  const s = r2.binding.service;
  assert.deepEqual(s.read(agent("a1"), {}).messages.map((x) => x.seq), [2]);
  assert.equal(await outcome(() => s.thread(agent("a2"), { threadId: m.threadId })), "E_NOT_FOUND/not_found", "participation survives too");
  assert.equal(r2.binding.settings.settings(USER, { projectId: "p1" }).settings.crossGroup, true);
});
