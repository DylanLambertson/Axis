// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.messages/1 (PV-M1): body bounds, the display rules and escaping, message and thread invariants, the reply caps,
// settings, Pause and Resume.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BODY_CHARS,
  MAX_BODY_DISPLAY,
  MAX_EXCERPT_DISPLAY,
  MAX_EXCERPT_LINES,
  MAX_HOP,
  MAX_TAINT_HOP,
  MAX_READ_MESSAGES,
  MAX_RECIPIENTS,
  MAX_THREAD_PARTICIPANTS,
  MAX_THREADS_LIST,
  REFUSED_MESSAGE_TEXT,
  encodeMessagingId,
  messageBodyTextSchema,
  excerptTextSchema,
  toMessageText,
} from "../src/index.js";
import { MSG1, MSG2, THREAD, THREAD2, agentReply, settings, summary, userMessage } from "./samples-messages.js";
import { accepts, rejects, schemaOf } from "./suite.js";

const req = (m: string) => schemaOf("axis.messages", m, "request");
const res = (m: string) => schemaOf("axis.messages", m, "response");
const send = (over: Record<string, unknown> = {}) => ({ recipients: [{ user: true }], body: { format: "text", text: "hi" }, ...over });
const msg = (over: Record<string, unknown> = {}, base: object = agentReply) => ({ ...structuredClone(base), ...over });
const sendRes = (m: object) => ({ message: m, replayed: false });

/** Terminal and display attacks: OSC 52 clipboard, OSC 8 link, title, cursor, CR overwrite, C1 CSI, bidi, zero-width, invisible, lone surrogate. */
const HOSTILE = ["\u001b]52;c;aGk=\u0007", "\u001b]8;;https://x.example\u001b\\", "\u001b]0;title\u0007", "\u001b[2J", "a\rb", "\u009b31m", "\u202e", "\u2066", "\u200b", "\ufeff", "\u2028", "\u034f", "\ufe0f", "\u{e0041}", "\ud800", "\u0000", "\u007f"];

test("send: the body is plain text of 1 to 16,384 units, well-formed; recipients 1 to 16, unique", () => {
  accepts(req("send"), send({ body: { format: "text", text: "x".repeat(MAX_BODY_CHARS) } }), "at the cap");
  rejects(req("send"), send({ body: { format: "text", text: "x".repeat(MAX_BODY_CHARS + 1) } }), "over the cap");
  rejects(req("send"), send({ body: { format: "text", text: "" } }), "empty");
  rejects(req("send"), send({ body: { format: "text", text: "a\ud800b" } }), "lone surrogate");
  rejects(req("send"), send({ body: { format: "text", text: "a\udc00" } }), "lone low surrogate");
  // Controls and bidi are accepted on the way in: the daemon stores the text and escapes it on every way out.
  accepts(req("send"), send({ body: { format: "text", text: "\u001b]52;c;x\u0007 \u202e" } }), "raw controls in");
  const agents = (n: number) => Array.from({ length: n }, (_, i) => ({ agent: `agent-${i}` }));
  accepts(req("send"), send({ recipients: agents(MAX_RECIPIENTS) }), "16 recipients");
  rejects(req("send"), send({ recipients: agents(MAX_RECIPIENTS + 1) }), "17 recipients");
  rejects(req("send"), send({ recipients: [] }), "no recipient");
  rejects(req("send"), send({ recipients: [{ agent: "a" }, { agent: "a" }] }), "duplicate agent");
  rejects(req("send"), send({ recipients: [{ user: true }, { user: true }] }), "duplicate user");
  accepts(req("send"), send({ recipients: [{ agent: "g" }, { group: "g" }] }), "an agent and a group of the same id are different");
  rejects(req("send"), send({ recipients: [{ user: false }] }), "user false");
  rejects(req("send"), send({ recipients: [{ agent: "a", group: "g" }] }), "two targets in one recipient");
  rejects(req("send"), send({ recipients: [{ agent: "-rf" }] }), "option-like id");
  rejects(req("send"), send({ recipients: [{ project: "proj-2" }] }), "a project as a recipient");
  rejects(req("send"), send({ inReplyTo: THREAD }), "a thread id as inReplyTo");
});

test("send: refs are bounded data; excerpts name a repository-relative path and a bounded line range", () => {
  const ex = (over: Record<string, unknown> = {}) => ({ type: "excerpt", workspaceId: "ws-a", path: "src/a.ts", startLine: 1, endLine: 1, ...over });
  accepts(req("send"), send({ refs: [ex({ endLine: MAX_EXCERPT_LINES })] }), "widest range");
  rejects(req("send"), send({ refs: [ex({ endLine: MAX_EXCERPT_LINES + 1 })] }), "range too wide");
  rejects(req("send"), send({ refs: [ex({ startLine: 5, endLine: 4 })] }), "backwards range");
  rejects(req("send"), send({ refs: [ex({ startLine: 0 })] }), "line 0");
  for (const path of ["/etc/passwd", "../x", "a/../b", ".git/config", "C:/x", "-x", ":(glob)*", "a\\b", "a\u202eb"]) rejects(req("send"), send({ refs: [ex({ path })] }), `excerpt path ${path}`);
  rejects(req("send"), send({ refs: [{ type: "file", workspaceId: "ws-a", path: "../../.ssh/id" }] }), "file ref escaping");
  accepts(req("send"), send({ refs: Array.from({ length: 4 }, () => ex()) }), "4 excerpts");
  rejects(req("send"), send({ refs: Array.from({ length: 5 }, () => ex()) }), "5 excerpts");
  accepts(req("send"), send({ refs: Array.from({ length: 16 }, (_, i) => ({ type: "pr", number: i + 1 })) }), "16 refs");
  rejects(req("send"), send({ refs: Array.from({ length: 17 }, (_, i) => ({ type: "pr", number: i + 1 })) }), "17 refs");
  for (const r of [{ type: "excerpt", workspaceId: "ws-a", path: "a", startLine: 1, endLine: 1, text: "forged copy" }, { type: "url", url: "https://x.example" }, { type: "pr", number: 0 }, { type: "commit", sha: "abc" }, { type: "commit", sha: "A".repeat(40) }]) {
    rejects(req("send"), send({ refs: [r] }), `ref ${JSON.stringify(r)}`);
  }
});

test("toMessageText: every hostile character becomes an inert escape that passes the response schema, tab and newline stay", () => {
  for (const h of HOSTILE) {
    const { text, truncated } = toMessageText(`a${h}b`, MAX_BODY_DISPLAY);
    assert.equal(truncated, false);
    accepts(messageBodyTextSchema, text, JSON.stringify(h));
    assert.equal(REFUSED_MESSAGE_TEXT.test(text), false, JSON.stringify(h));
    assert.match(text, /\\u\{[0-9a-f]+\}/, `${JSON.stringify(h)} was not escaped`);
    rejects(messageBodyTextSchema, `a${h}b`, `raw ${JSON.stringify(h)} in a response`);
  }
  assert.equal(toMessageText("a\n\tb", 100).text, "a\n\tb");
  assert.equal(toMessageText("\u001b]52", 100).text, "\\u{1b}]52");
  // A typed escape cannot pass for a real one: the backslash itself is escaped.
  assert.equal(toMessageText("\\u{1b}", 100).text, "\\\\u{1b}");
  assert.equal(toMessageText("😀 é", 100).text, "😀 é");
});

test("toMessageText: the worst 16,384-unit body fits the response cap uncut; a cut lands on an escape boundary", () => {
  for (const unit of ["\ud800", "\u202e", "\u0000", "\u{e0041}", "\\"]) {
    const raw = unit.repeat(Math.floor(MAX_BODY_CHARS / unit.length));
    const out = toMessageText(raw, MAX_BODY_DISPLAY);
    assert.equal(out.truncated, false, JSON.stringify(unit));
    accepts(messageBodyTextSchema, out.text, `worst body of ${JSON.stringify(unit)}`);
  }
  const cut = toMessageText("abc\u202ed", 10);
  assert.deepEqual(cut, { text: "abc", truncated: true });
  const exact = toMessageText("ab\u202e", 10);
  assert.deepEqual(exact, { text: "ab\\u{202e}", truncated: false });
  const ex = toMessageText("\u0000".repeat(MAX_EXCERPT_DISPLAY), MAX_EXCERPT_DISPLAY);
  assert.equal(ex.truncated, true);
  accepts(excerptTextSchema, ex.text, "a cut excerpt");
  assert.ok(ex.text.length <= MAX_EXCERPT_DISPLAY && ex.text.endsWith("}"));
  assert.throws(() => toMessageText("x", 9), RangeError);
  assert.throws(() => toMessageText(1 as unknown as string, 100), TypeError);
});

test("message: a response refuses unescaped text, a forged sender and broken invariants", () => {
  const r = res("send");
  accepts(r, sendRes(msg()), "as built");
  rejects(r, sendRes(msg({ body: { format: "text", text: "a\u001b]8;;x\u0007b" } })), "raw OSC 8 body");
  rejects(r, sendRes(msg({ body: { format: "text", text: "x".repeat(MAX_BODY_DISPLAY + 1) } })), "body over the escaped cap");
  rejects(r, sendRes(msg({ body: { format: "text", text: "" } })), "empty body");
  // On a hop-0 base, so only the sender rule can refuse it.
  accepts(r, sendRes(msg({}, userMessage)), "the user base");
  rejects(r, sendRes(msg({ sender: { kind: "user", verified: false } }, userMessage)), "unverified user");
  rejects(r, sendRes(msg({ sender: { kind: "system", verified: false } }, userMessage)), "unverified system, hop 0");
  rejects(r, sendRes(msg({ sender: { kind: "plugin", pluginId: "acme.notes", verified: false } })), "unverified plugin");
  rejects(r, sendRes(msg({ sender: { kind: "system", verified: false } })), "unverified system");
  rejects(r, sendRes(msg({ sender: { kind: "agent", agentId: "agent-a", runId: "run-1" } })), "agent without verified");
  rejects(r, sendRes(msg({ sender: { kind: "user", verified: true, agentId: "agent-a" } })), "user with an agent id");
  rejects(r, sendRes(msg({ sender: { kind: "daemon", verified: true } })), "unknown sender kind");
  rejects(r, sendRes(msg({ hop: 1 }, userMessage)), "a user message with hop 1");
  assert.equal(MAX_HOP, 8, "the design hop cap (IAC section 7.3)");
  assert.equal(MAX_HOP, MAX_TAINT_HOP, "one hop cap for messages and the taint core");
  accepts(r, sendRes(msg({ hop: 8 })), "hop at the cap");
  rejects(r, sendRes(msg({ hop: 9 })), "hop over the cap");
  rejects(r, sendRes(msg({ inReplyTo: MSG2 })), "a reply to itself");
  rejects(r, sendRes(msg({ expanded: [] })), "nobody delivered to");
  rejects(r, sendRes(msg({ expanded: [{ kind: "user" }, { kind: "user" }] })), "duplicate expansion");
  rejects(r, sendRes(msg({ expanded: Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => ({ kind: "agent", agentId: `a${i}` })) })), "17 after expansion");
  rejects(r, sendRes(msg({ refs: [{ type: "file", workspaceId: "ws-a", path: "src/app.ts" }] })), "a raw path echoed");
  rejects(r, sendRes(msg({ refs: [{ type: "file", workspaceId: "ws-a", displayPath: "a\u202eb" }] })), "bidi in a display path");
  const excerpt = (text: string) => ({ type: "excerpt", workspaceId: "ws-a", displayPath: "a", startLine: 1, endLine: 1, text, truncated: true });
  accepts(r, sendRes(msg({ refs: [excerpt("x".repeat(MAX_EXCERPT_DISPLAY))] })), "excerpt at the cap");
  rejects(r, sendRes(msg({ refs: [excerpt("x".repeat(MAX_EXCERPT_DISPLAY + 1))] })), "excerpt over the cap");
  rejects(r, sendRes(msg({ refs: [excerpt("a\rb")] })), "raw CR in an excerpt");
  rejects(r, sendRes(msg({ refs: [excerpt("x".repeat(MAX_EXCERPT_DISPLAY / 2)), excerpt("x".repeat(MAX_EXCERPT_DISPLAY / 2 + 1))] })), "excerpts together over the cap");
  accepts(r, sendRes(msg({ body: { format: "text", text: "x".repeat(MAX_BODY_DISPLAY) }, refs: [excerpt("x".repeat(MAX_EXCERPT_DISPLAY))] })), "the largest body and excerpt together");
});

test("thread: only the requested thread's messages, in order, with a consistent cursor", () => {
  const r = res("thread");
  const ok = { thread: structuredClone(summary), messages: [msg({}, userMessage), msg()], nextSeq: 3, complete: true };
  accepts(r, ok, "as built");
  rejects(r, { ...ok, messages: [msg({}, userMessage), msg({ threadId: THREAD2 })] }, "a message of another thread");
  rejects(r, { ...ok, messages: [msg({}, userMessage), msg({ projectId: "proj-2" })] }, "a message of another project");
  rejects(r, { ...ok, messages: [msg(), msg({}, userMessage)], nextSeq: 1 }, "out of order");
  rejects(r, { ...ok, messages: [msg({}, userMessage), msg({ seq: 1, messageId: encodeMessagingId("message", new Uint8Array(16)) })], nextSeq: 1 }, "repeated seq");
  rejects(r, { ...ok, nextSeq: 2 }, "cursor not at the last message");
  rejects(r, { ...ok, messages: [], nextSeq: 4 }, "cursor past the thread");
  accepts(r, { ...ok, messages: [], nextSeq: 3 }, "nothing new");
  rejects(r, { ...ok, thread: { ...structuredClone(summary), participants: [] } }, "no participant");
  rejects(r, { ...ok, thread: { ...structuredClone(summary), participants: [{ kind: "user" }, { kind: "user" }] } }, "duplicate participant");
  const many = Array.from({ length: MAX_THREAD_PARTICIPANTS + 1 }, (_, i) => ({ kind: "agent", agentId: `a${i}` }));
  rejects(r, { ...ok, thread: { ...structuredClone(summary), participants: many } }, "65 participants");
  rejects(req("thread"), { threadId: THREAD, limit: MAX_READ_MESSAGES + 1 }, "limit over the cap");
  rejects(req("thread"), { threadId: THREAD, afterSeq: -1 }, "negative cursor");
});

test("read: messages of the caller's threads, each thread in order, no message twice; a cursor only within a thread", () => {
  rejects(res("read"), { messages: [msg(), msg()], more: false }, "a message twice");
  accepts(res("read"), { messages: [msg({ threadId: THREAD2, seq: 9 }), msg({}, userMessage)], more: false }, "two threads interleaved, each in order");
  rejects(res("read"), { messages: [msg({ seq: 9 }), msg({ seq: 3, messageId: MSG1 })], more: false }, "one thread out of order");
  rejects(req("read"), { afterSeq: 3 }, "a cursor without a thread");
  accepts(req("read"), {}, "the whole inbox");
  rejects(req("read"), { limit: MAX_READ_MESSAGES + 1 }, "limit over the cap");
});

test("threads and markRead: unique, most recent first; markRead names one thread and a positive seq", () => {
  const t = (id: string, lastAt: string) => ({ ...structuredClone(summary), threadId: id, lastAt });
  accepts(res("threads"), { threads: [t(THREAD, "2026-11-20T10:00:05.000Z"), t(THREAD2, "2026-11-20T10:00:01.000Z")] }, "newest first");
  rejects(res("threads"), { threads: [t(THREAD, "2026-11-20T10:00:01.000Z"), t(THREAD2, "2026-11-20T10:00:05.000Z")] }, "oldest first");
  rejects(res("threads"), { threads: [t(THREAD, "2026-11-20T10:00:05.000Z"), t(THREAD, "2026-11-20T10:00:01.000Z")] }, "a thread twice");
  rejects(req("threads"), { limit: MAX_THREADS_LIST + 1 }, "limit over the cap");
  rejects(req("markRead"), { threadId: THREAD, throughSeq: 0 }, "seq 0");
  rejects(req("markRead"), { threadId: THREAD }, "no seq");
  rejects(req("markRead"), { threadId: THREAD, throughSeq: 3, agentId: "agent-b" }, "marking for someone else");
  rejects(res("markRead"), { threadId: MSG1, readThrough: 3, unread: 0 }, "a message id as the thread");
});

test("pause and resume: one scope; the reply says the state it leaves", () => {
  rejects(req("pause"), { scope: { project: "p", group: "g" } }, "two scopes");
  rejects(req("pause"), { scope: {} }, "no scope");
  rejects(req("pause"), { scope: { thread: THREAD } }, "a thread scope");
  rejects(req("pause"), {}, "no scope field");
  rejects(res("pause"), { scope: { project: "p" }, paused: false, changed: true }, "pause that leaves it running");
  rejects(res("resume"), { scope: { project: "p" }, paused: true, changed: true }, "resume that leaves it paused");
});

test("settings: closed values, one change per update, a composer never has an endpoint", () => {
  const s = (over: Record<string, unknown>) => ({ settings: { ...structuredClone(settings), ...over } });
  accepts(res("settings"), s({}), "as built");
  rejects(res("settings"), s({ agents: [{ agentId: "agent-a", kind: "composer", acceptsFrom: "group", cliMessaging: true, muted: false }] }), "composer with an endpoint");
  rejects(res("settings"), s({ crossGroupPairs: [["g1", "g2"], ["g2", "g1"]] }), "a pair twice, reversed");
  rejects(res("settings"), s({ crossGroupPairs: [["g1", "g1"]] }), "a group paired with itself");
  rejects(res("settings"), s({ retentionDays: 0 }), "retention 0");
  rejects(res("settings"), s({ retentionDays: 366 }), "retention over a year");
  rejects(res("settings"), s({ secretScan: "off" }), "scan off");
  rejects(res("settings"), s({ paused: { project: false, groups: ["g", "g"], agents: [] } }), "a group paused twice");
  rejects(res("settings"), s({ agents: [settings.agents[0], settings.agents[0]] }), "an agent twice");
  const u = req("updateSettings");
  accepts(u, { setting: "crossGroup", projectId: "proj-1", value: true }, "cross group");
  accepts(u, { setting: "cliMessaging", agentId: "agent-c", value: true }, "enable a CLI agent");
  accepts(u, { setting: "secretScan", projectId: "proj-1", value: "warn" }, "warn");
  rejects(u, { setting: "acceptsFrom", agentId: "agent-c", value: "everyone" }, "unknown accepts-from");
  rejects(u, { setting: "acceptsFrom", projectId: "proj-1", value: "project" }, "agent setting on a project");
  rejects(u, { setting: "crossGroup", projectId: "proj-1", value: true, agentId: "a" }, "two targets");
  rejects(u, { setting: "taint", agentId: "agent-c", value: false }, "the taint rule is not a setting (M-2)");
  rejects(u, { setting: "crossGroupPair", projectId: "proj-1", groups: ["g1"], value: true }, "a pair of one");
  rejects(u, { setting: "retentionDays", projectId: "proj-1", value: 1.5 }, "fractional days");
});
