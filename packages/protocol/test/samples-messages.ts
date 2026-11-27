// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Fixed vectors of axis.messages/1 (PV-M1). Ids are fixed, made-up values in the opaque id format.
import type { Sample } from "./suite.js";

export const T0 = "2026-11-20T10:00:00.000Z";
export const T1 = "2026-11-20T10:00:05.000Z";
export const THREAD = "thr_AbCdEfGhIjKlMnOpQrStUw";
export const THREAD2 = "thr_ZyXwVuTsRqPoNmLkJiHgFQ";
export const MSG1 = "msg_0123456789abcdefghijkA";
export const MSG2 = "msg_ABCDEFGHIJKLMNOPQRSTUg";

export const userMessage = {
  messageId: MSG1,
  threadId: THREAD,
  projectId: "proj-1",
  seq: 1,
  sender: { kind: "user", verified: true },
  recipients: [{ agent: "agent-a" }, { group: "group-1" }],
  expanded: [{ kind: "agent", agentId: "agent-a" }, { kind: "agent", agentId: "agent-b" }],
  body: { format: "text", text: "Please look at the failing test.\n\tThanks" },
  refs: [{ type: "commit", sha: "a".repeat(40) }, { type: "pr", number: 12 }],
  inReplyTo: null,
  hop: 0,
  createdAt: T0,
};

export const agentReply = {
  messageId: MSG2,
  threadId: THREAD,
  projectId: "proj-1",
  seq: 3,
  sender: { kind: "agent", agentId: "agent-a", runId: "run-1", verified: false },
  recipients: [{ user: true }],
  expanded: [{ kind: "user" }],
  body: { format: "text", text: "Escaped: \\u{1b}]52;c;\\u{7} and \\\\ kept" },
  refs: [
    { type: "file", workspaceId: "ws-a", displayPath: "src/app.ts" },
    { type: "excerpt", workspaceId: "ws-a", displayPath: "src/app.ts", startLine: 3, endLine: 5, text: "const a = 1;\n", truncated: false },
    { type: "run", runId: "run-1" },
    { type: "task", taskId: "task-1" },
    { type: "page", pageId: "page-1" },
  ],
  inReplyTo: MSG1,
  hop: 1,
  createdAt: T1,
};

export const summary = {
  threadId: THREAD,
  projectId: "proj-1",
  createdAt: T0,
  lastSeq: 3,
  lastAt: T1,
  unread: 1,
  participants: [{ kind: "user" }, { kind: "agent", agentId: "agent-a" }, { kind: "plugin", pluginId: "acme.notes" }],
};

export const settings = {
  projectId: "proj-1",
  crossGroup: false,
  crossGroupPairs: [["group-1", "group-2"]],
  secretScan: "refuse",
  retentionDays: 30,
  paused: { project: false, groups: ["group-3"], agents: ["agent-c"] },
  agents: [
    { agentId: "agent-a", kind: "composer", acceptsFrom: "group", cliMessaging: false, muted: false },
    { agentId: "agent-c", kind: "cli", acceptsFrom: "none", cliMessaging: true, muted: true },
  ],
};

/** Nullable or free-choice leaves a hostile variant may legitimately set (null, or another boolean). */
const NULLABLE = /^null at (message\.|messages\.\d+\.)(inReplyTo|sender\.runId)$/;

const M = "axis.messages";
export const MESSAGES_SAMPLES: readonly Sample[] = [
  {
    contract: M, method: "send", side: "request", name: "new thread",
    value: { recipients: [{ agent: "agent-a" }, { group: "group-1" }, { user: true }], body: { format: "text", text: "hello\n\tworld" }, refs: [{ type: "excerpt", workspaceId: "ws-a", path: "src/app.ts", startLine: 1, endLine: 10 }, { type: "file", workspaceId: "ws-a", path: "README.md" }] },
  },
  { contract: M, method: "send", side: "request", name: "reply in thread", value: { threadId: THREAD, recipients: [{ user: true }], body: { format: "text", text: "ok" }, inReplyTo: MSG1 } },
  { contract: M, method: "send", side: "response", name: "user message", value: { message: userMessage, replayed: false } },
  { contract: M, method: "send", side: "response", name: "endpoint reply", value: { message: agentReply, replayed: true }, toleratedPattern: NULLABLE },
  { contract: M, method: "thread", side: "request", name: "thread", value: { threadId: THREAD, afterSeq: 0, limit: 32 } },
  { contract: M, method: "thread", side: "response", name: "thread", value: { thread: summary, messages: [structuredClone(userMessage), structuredClone(agentReply)], nextSeq: 3, complete: true }, toleratedPattern: NULLABLE },
  { contract: M, method: "threads", side: "request", name: "threads", value: { projectId: "proj-1", limit: 32 } },
  { contract: M, method: "threads", side: "response", name: "threads", value: { threads: [summary, { ...structuredClone(summary), threadId: THREAD2, lastAt: T0, unread: 0 }] } },
  { contract: M, method: "read", side: "request", name: "read in thread", value: { threadId: THREAD, afterSeq: 2, limit: 10 } },
  { contract: M, method: "read", side: "response", name: "inbox", value: { messages: [structuredClone(userMessage), structuredClone(agentReply)], more: false }, toleratedPattern: NULLABLE },
  { contract: M, method: "markRead", side: "request", name: "markRead", value: { threadId: THREAD, throughSeq: 3 } },
  { contract: M, method: "markRead", side: "response", name: "markRead", value: { threadId: THREAD, readThrough: 3, unread: 0 } },
  { contract: M, method: "pause", side: "request", name: "project", value: { scope: { project: "proj-1" } } },
  { contract: M, method: "pause", side: "response", name: "group", value: { scope: { group: "group-1" }, paused: true, changed: true } },
  { contract: M, method: "resume", side: "request", name: "agent", value: { scope: { agent: "agent-a" } } },
  { contract: M, method: "resume", side: "response", name: "agent", value: { scope: { agent: "agent-a" }, paused: false, changed: false } },
  { contract: M, method: "settings", side: "request", name: "settings", value: { projectId: "proj-1" } },
  { contract: M, method: "settings", side: "response", name: "settings", value: { settings } },
  { contract: M, method: "updateSettings", side: "request", name: "pair", value: { setting: "crossGroupPair", projectId: "proj-1", groups: ["group-1", "group-2"], value: true } },
  { contract: M, method: "updateSettings", side: "request", name: "accepts from", value: { setting: "acceptsFrom", agentId: "agent-c", value: "project" } },
  { contract: M, method: "updateSettings", side: "response", name: "changed", value: { settings, changed: true } },
];
