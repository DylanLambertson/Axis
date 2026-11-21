// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.messages/1 (PV-M1): the worst reply each cap allows still passes the protocol's message walk. Every id, name and
// path is at its schema maximum and every list at its cap, so a daemon that pages by the contract's caps never builds a
// reply its own response schema refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_EXCERPTS,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGE_NODES,
  MAX_MESSAGE_TEXT,
  MAX_READ_MESSAGES,
  MAX_READ_TEXT,
  MAX_RECIPIENTS,
  MAX_REFS,
  MAX_THREAD_PARTICIPANTS,
  MAX_THREADS_LIST,
  encodeMessagingId,
  inspectMessage,
} from "../src/index.js";
import { accepts, rejects, schemaOf } from "./suite.js";

const res = (m: string) => schemaOf("axis.messages", m, "response");
/** Room left for the response envelope around the result (id, type, contract): the result alone must fit in less. */
const RESERVE = { maxBytes: MAX_MESSAGE_BYTES - 16_384, maxNodes: MAX_MESSAGE_NODES - 64 };
const fitsWithReserve = (v: unknown): boolean => inspectMessage(v, RESERVE).ok;

/** A 64-character journal id ending in `n`, and a 259-character plugin id (four 64-character labels) ending in `n`. */
const longId = (c: string, n: number) => c.repeat(62) + String(n).padStart(2, "0");
const longPlugin = (n: number) => ["p", "q", "r"].map((c) => c.repeat(64)).join(".") + "." + longId("s", n);
const PROJECT = longId("p", 0);
const THREAD_ID = encodeMessagingId("thread", new Uint8Array(16).fill(1));
const id16 = (k: number) => Uint8Array.from({ length: 16 }, (_, j) => (k * 17 + j) & 255);
const at = (k: number) => new Date(Date.UTC(2026, 10, 20, 12) - k * 1000).toISOString();
/** Wide CJK text: 3 UTF-8 bytes per unit, the most a unit costs. */
const wide = (n: number) => "一".repeat(n);

const PER_MESSAGE = MAX_READ_TEXT / MAX_READ_MESSAGES;
const PATH = 256;

/** A message at every cap: plugin-sized expansions, 16 group recipients, 16 refs (4 excerpts), the longest ids. */
function worstMessage(i: number, units = PER_MESSAGE): Record<string, unknown> {
  const pathRef = (type: "file" | "excerpt") =>
    type === "file"
      ? { type, workspaceId: longId("w", i), displayPath: wide(PATH) }
      : { type, workspaceId: longId("w", i), displayPath: wide(PATH), startLine: 1_000_000_000, endLine: 1_000_001_999, text: "", truncated: true };
  return {
    messageId: encodeMessagingId("message", id16(i)),
    threadId: THREAD_ID,
    projectId: PROJECT,
    seq: Number.MAX_SAFE_INTEGER - MAX_READ_MESSAGES + i,
    sender: { kind: "agent", agentId: longId("a", i), runId: longId("r", i), verified: false },
    recipients: Array.from({ length: MAX_RECIPIENTS }, (_, j) => ({ group: longId("g", j) })),
    expanded: Array.from({ length: MAX_RECIPIENTS }, (_, j) => ({ kind: "plugin", pluginId: longPlugin(j) })),
    body: { format: "text", text: wide(units - MAX_REFS * PATH) },
    refs: [...Array.from({ length: MAX_EXCERPTS }, () => pathRef("excerpt")), ...Array.from({ length: MAX_REFS - MAX_EXCERPTS }, () => pathRef("file"))],
    inReplyTo: encodeMessagingId("message", new Uint8Array(16).fill(255)),
    hop: 8,
    createdAt: at(MAX_READ_MESSAGES - i),
  };
}

function worstSummary(k: number, lastSeq = Number.MAX_SAFE_INTEGER): Record<string, unknown> {
  return {
    threadId: k === 0 ? THREAD_ID : encodeMessagingId("thread", id16(k)),
    projectId: PROJECT,
    createdAt: at(10_000),
    lastSeq,
    lastAt: at(k),
    unread: Number.MAX_SAFE_INTEGER,
    participants: Array.from({ length: MAX_THREAD_PARTICIPANTS }, (_, j) => ({ kind: "plugin", pluginId: longPlugin(j) })),
  };
}

const worstMessages = () => Array.from({ length: MAX_READ_MESSAGES }, (_, i) => worstMessage(i));

test("the reply caps: one message at its largest fits a reply, and the caps are what the walk budget was computed for", () => {
  assert.equal(MAX_READ_TEXT, MAX_MESSAGE_TEXT, "a reader always makes progress, and no reply carries more");
  assert.equal(MAX_READ_MESSAGES, 32);
  assert.equal(MAX_THREADS_LIST, 32);
  assert.ok(Number.isInteger(PER_MESSAGE) && PER_MESSAGE > MAX_REFS * PATH);
});

test("read and thread: the worst reply at every cap passes the walk with room for the envelope", () => {
  const read = { messages: worstMessages(), more: true };
  assert.ok(fitsWithReserve(read), "worst read reply within the walk minus the envelope reserve");
  accepts(res("read"), read, "worst read reply");
  const last = Number.MAX_SAFE_INTEGER - 1;
  const thread = { thread: worstSummary(0), messages: worstMessages(), nextSeq: last, complete: false };
  assert.ok(fitsWithReserve(thread), "worst thread reply within the walk minus the envelope reserve");
  accepts(res("thread"), thread, "worst thread reply");
});

test("read and thread: one more message, or one more unit of text, is refused", () => {
  const more = [...worstMessages(), worstMessage(MAX_READ_MESSAGES)];
  (more[MAX_READ_MESSAGES] as { seq: number }).seq = Number.MAX_SAFE_INTEGER;
  rejects(res("read"), { messages: more, more: true }, "one message over the cap");
  const over = worstMessages();
  over[0] = worstMessage(0, PER_MESSAGE + 1);
  rejects(res("read"), { messages: over, more: true }, "one unit over the reply text cap");
});

test("threads: the worst list (every thread at 64 longest participants) passes the walk; one more thread is refused", () => {
  const list = { threads: Array.from({ length: MAX_THREADS_LIST }, (_, k) => worstSummary(k)) };
  assert.ok(fitsWithReserve(list), "worst threads reply within the walk minus the envelope reserve");
  accepts(res("threads"), list, "worst threads reply");
  const over = { threads: Array.from({ length: MAX_THREADS_LIST + 1 }, (_, k) => worstSummary(k)) };
  rejects(res("threads"), over, "one thread over the cap");
});
