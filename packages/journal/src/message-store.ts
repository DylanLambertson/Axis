// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError, withTransaction, type DatabaseSync } from "@axis/audit";
import { DeliveryRecords } from "./delivery-store.js";

/**
 * Message records of `axis.messages/1` (schema version 9, ticket PV-M3; docs/design/inter-agent-communication.md sections
 * 2, 4.2 and 7). A data layer only: who may send, read or post is the daemon host's message service, which calls this
 * store with principals it took from an attested identity. Every query that names a principal is bound by parameters,
 * never by building SQL from a value, and every list is bounded by the caller's `limit`.
 *
 * Principals are the keys of `principalKey` in `@axis/protocol`: `user`, `agent:<id>`, `plugin:<id>`.
 */

export interface ThreadRecord {
  readonly id: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly lastSeq: number;
  readonly lastAt: string;
}
export interface ParticipantRecord {
  readonly principal: string;
  /** The thread's last sequence when the principal joined: it reads later messages and those addressed to it. */
  readonly joinedSeq: number;
}
export interface MessageRecord {
  readonly id: string;
  readonly threadId: string;
  readonly seq: number;
  /** JSON as stored; the service checks it against the protocol schema before it leaves. */
  readonly sender: unknown;
  readonly senderKey: string;
  readonly recipients: unknown;
  readonly expanded: unknown;
  /** The sender's raw text. Escaped on every way out (`toMessageText`), never stored escaped. */
  readonly body: string;
  readonly refs: unknown;
  readonly inReplyTo: string | null;
  readonly hop: number;
  readonly createdAt: string;
}
export interface AppendMessage {
  /** A new thread (with its project), or a post into an existing one. */
  readonly thread: { readonly create: true; readonly id: string; readonly projectId: string } | { readonly create: false; readonly id: string };
  /** Principals that join with this message, in order (the sender first for a new thread). */
  readonly join: readonly string[];
  readonly message: {
    readonly id: string;
    readonly sender: unknown;
    readonly senderKey: string;
    readonly recipients: unknown;
    readonly expanded: unknown;
    readonly body: string;
    readonly refs: unknown;
    readonly inReplyTo: string | null;
    readonly hop: number;
  };
  /** Who the message is addressed to, and whether it counts against that recipient's queue quotas. */
  readonly to: readonly { readonly principal: string; readonly counted: boolean }[];
}
export interface AgentMessagingSettings {
  readonly acceptsFrom: "none" | "group" | "project";
  readonly cliMessaging: boolean;
  readonly muted: boolean;
}

/** Most participants a thread holds (the table's `ord` check): `MAX_THREAD_PARTICIPANTS` in `@axis/protocol`. */
export const MAX_STORED_PARTICIPANTS = 64;

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v);
const int = (v: unknown): number => Number(v);

function toThread(r: Row): ThreadRecord {
  return { id: str(r["id"]), projectId: str(r["project_id"]), createdAt: str(r["created_at"]), lastSeq: int(r["last_seq"]), lastAt: str(r["last_at"]) };
}
function parse(text: unknown): unknown {
  try {
    return JSON.parse(str(text)) as unknown;
  } catch {
    return undefined;
  }
}
function toMessage(r: Row): MessageRecord {
  return {
    id: str(r["id"]),
    threadId: str(r["thread_id"]),
    seq: int(r["seq"]),
    sender: parse(r["sender"]),
    senderKey: str(r["sender_key"]),
    recipients: parse(r["recipients"]),
    expanded: parse(r["expanded"]),
    body: str(r["body"]),
    refs: parse(r["refs"]),
    inReplyTo: r["in_reply_to"] === null ? null : str(r["in_reply_to"]),
    hop: int(r["hop"]),
    createdAt: str(r["created_at"]),
  };
}
const bound = (n: number): number => {
  if (!Number.isSafeInteger(n) || n < 1 || n > 1000) throw new AxisError("E_INVALID_ARGUMENT", "A list limit is out of range", { reason: "limit" });
  return n;
};

const MESSAGE_COLUMNS = "m.id, m.thread_id, m.seq, m.sender, m.sender_key, m.recipients, m.expanded, m.body, m.refs, m.in_reply_to, m.hop, m.created_at";
/** A message the principal can read: after it joined, or addressed to it (section 4.2). */
const VISIBLE = "(m.seq > ? OR EXISTS (SELECT 1 FROM message_recipients r WHERE r.principal = ? AND r.message_id = m.id))";

export class MessageRecords {
  readonly #db: DatabaseSync;
  readonly #ts: () => string;
  /** Delivery into runs (schema version 10). */
  readonly deliveries: DeliveryRecords;

  constructor(db: DatabaseSync, ts: () => string) {
    this.#db = db;
    this.#ts = ts;
    this.deliveries = new DeliveryRecords(db, ts);
  }

  thread(id: string): ThreadRecord | undefined {
    const r = this.#db.prepare("SELECT id, project_id, created_at, last_seq, last_at FROM message_threads WHERE id = ?").get(id) as Row | undefined;
    return r === undefined ? undefined : toThread(r);
  }

  /**
   * The thread as one participant sees it, in ONE participant-scoped lookup: undefined both for a thread that does not
   * exist and for one the principal is not in, so the two are the same miss (no existence oracle, section 4.2).
   */
  threadFor(threadId: string, principal: string): (ThreadRecord & { readonly joinedSeq: number }) | undefined {
    const r = this.#db
      .prepare("SELECT t.id, t.project_id, t.created_at, t.last_seq, t.last_at, p.joined_seq FROM message_threads t JOIN message_participants p ON p.thread_id = t.id WHERE t.id = ? AND p.principal = ?")
      .get(threadId, principal) as Row | undefined;
    return r === undefined ? undefined : { ...toThread(r), joinedSeq: int(r["joined_seq"]) };
  }

  participant(threadId: string, principal: string): ParticipantRecord | undefined {
    const r = this.#db.prepare("SELECT principal, joined_seq FROM message_participants WHERE thread_id = ? AND principal = ?").get(threadId, principal) as Row | undefined;
    return r === undefined ? undefined : { principal: str(r["principal"]), joinedSeq: int(r["joined_seq"]) };
  }

  participants(threadId: string): ParticipantRecord[] {
    const rows = this.#db.prepare("SELECT principal, joined_seq FROM message_participants WHERE thread_id = ? ORDER BY ord LIMIT ?").all(threadId, MAX_STORED_PARTICIPANTS) as Row[];
    return rows.map((r) => ({ principal: str(r["principal"]), joinedSeq: int(r["joined_seq"]) }));
  }

  message(id: string): MessageRecord | undefined {
    const r = this.#db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM agent_messages m WHERE m.id = ?`).get(id) as Row | undefined;
    return r === undefined ? undefined : toMessage(r);
  }

  /** True when Axis already posted a system message in reply to this one (a delivery notice). Rare: scans unindexed. */
  systemReplied(messageId: string): boolean {
    return this.#db.prepare("SELECT 1 FROM agent_messages WHERE in_reply_to = ? AND sender_key = 'system' LIMIT 1").get(messageId) !== undefined;
  }

  /** True when the principal can read this message of its thread (`joinedSeq` is its own; 0 reads every message). */
  visible(messageId: string, principal: string, joinedSeq: number): boolean {
    return this.#db.prepare(`SELECT 1 FROM agent_messages m WHERE m.id = ? AND ${VISIBLE}`).get(messageId, joinedSeq, principal) !== undefined;
  }

  /** Append one message in one transaction: the thread (if new), who joins, the message and who it is addressed to. */
  append(input: AppendMessage): MessageRecord {
    return withTransaction(this.#db, () => {
      const ts = this.#ts();
      if (input.thread.create) {
        this.#db.prepare("INSERT INTO message_threads (id, project_id, created_at, last_seq, last_at) VALUES (?, ?, ?, 0, ?)").run(input.thread.id, input.thread.projectId, ts, ts);
      }
      const thread = this.thread(input.thread.id);
      if (thread === undefined) throw new AxisError("E_NOT_FOUND", "The thread does not exist", { reason: "not_found" });
      const count = int((this.#db.prepare("SELECT count(*) AS n FROM message_participants WHERE thread_id = ?").get(thread.id) as Row)["n"]);
      const join = this.#db.prepare("INSERT INTO message_participants (thread_id, principal, joined_seq, ord) VALUES (?, ?, ?, ?)");
      input.join.forEach((p, i) => join.run(thread.id, p, thread.lastSeq, count + i));
      const m = input.message;
      const seq = thread.lastSeq + 1;
      this.#db
        .prepare("INSERT INTO agent_messages (id, thread_id, seq, sender, sender_key, recipients, expanded, body, refs, in_reply_to, hop, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(m.id, thread.id, seq, JSON.stringify(m.sender), m.senderKey, JSON.stringify(m.recipients), JSON.stringify(m.expanded), m.body, JSON.stringify(m.refs), m.inReplyTo, m.hop, ts);
      const to = this.#db.prepare("INSERT INTO message_recipients (principal, message_id, thread_id, seq, sender_key, counted) VALUES (?, ?, ?, ?, ?, ?)");
      for (const r of input.to) to.run(r.principal, m.id, thread.id, seq, m.senderKey, r.counted ? 1 : 0);
      return this.message(m.id) as MessageRecord;
    });
  }

  /** Messages of a thread the principal can read after `afterSeq`, oldest first, at most `limit`. */
  visibleAfter(threadId: string, principal: string, joinedSeq: number, afterSeq: number, limit: number): MessageRecord[] {
    const rows = this.#db
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM agent_messages m WHERE m.thread_id = ? AND m.seq > ? AND ${VISIBLE} ORDER BY m.seq LIMIT ?`)
      .all(threadId, afterSeq, joinedSeq, principal, bound(limit)) as Row[];
    return rows.map(toMessage);
  }

  /** Threads, most recent activity first: every thread (`principal` undefined, the user's view) or the principal's own. */
  threads(options: { readonly principal?: string; readonly projectId?: string; readonly limit: number }): ThreadRecord[] {
    const cols = "t.id, t.project_id, t.created_at, t.last_seq, t.last_at";
    const where: string[] = [];
    const args: (string | number)[] = [];
    let from = "message_threads t";
    if (options.principal !== undefined) {
      from += " JOIN message_participants p ON p.thread_id = t.id";
      where.push("p.principal = ?");
      args.push(options.principal);
    }
    if (options.projectId !== undefined) {
      where.push("t.project_id = ?");
      args.push(options.projectId);
    }
    const sql = `SELECT ${cols} FROM ${from}${where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`} ORDER BY t.last_at DESC, t.id LIMIT ?`;
    return (this.#db.prepare(sql).all(...args, bound(options.limit)) as Row[]).map(toThread);
  }

  /** Threads of a project (a bound on journal growth). */
  threadCount(projectId: string): number {
    return int((this.#db.prepare("SELECT count(*) AS n FROM message_threads WHERE project_id = ?").get(projectId) as Row)["n"]);
  }

  readThrough(threadId: string, principal: string): number {
    const r = this.#db.prepare("SELECT read_through FROM message_cursors WHERE thread_id = ? AND principal = ?").get(threadId, principal) as Row | undefined;
    return r === undefined ? 0 : int(r["read_through"]);
  }

  /** Move the principal's read cursor of a thread forward to `throughSeq` (never back). Returns the cursor. */
  markRead(threadId: string, principal: string, throughSeq: number): number {
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) throw new AxisError("E_INVALID_ARGUMENT", "A read cursor is out of range", { reason: "cursor" });
    this.#db
      .prepare("INSERT INTO message_cursors (thread_id, principal, read_through) VALUES (?, ?, ?) ON CONFLICT (thread_id, principal) DO UPDATE SET read_through = max(read_through, excluded.read_through)")
      .run(threadId, principal, throughSeq);
    return this.readThrough(threadId, principal);
  }

  /** Messages of a thread addressed to the principal and after its read cursor. */
  unread(threadId: string, principal: string): number {
    const sql = "SELECT count(*) AS n FROM message_recipients r WHERE r.principal = ? AND r.thread_id = ? AND r.seq > coalesce((SELECT read_through FROM message_cursors c WHERE c.thread_id = r.thread_id AND c.principal = r.principal), 0)";
    return int((this.#db.prepare(sql).get(principal, threadId) as Row)["n"]);
  }

  /** The principal's unread messages that count against its queue (section 7.2), all of them or from one sender. */
  queued(principal: string, senderKey?: string): number {
    const sql = `SELECT count(*) AS n FROM message_recipients r WHERE r.principal = ? AND r.counted = 1${senderKey === undefined ? "" : " AND r.sender_key = ?"} AND r.seq > coalesce((SELECT read_through FROM message_cursors c WHERE c.thread_id = r.thread_id AND c.principal = r.principal), 0)`;
    const args = senderKey === undefined ? [principal] : [principal, senderKey];
    return int((this.#db.prepare(sql).get(...args) as Row)["n"]);
  }

  /** The principal's inbox: messages addressed to it after its cursor (and after `afterSeq` in one thread), oldest first. */
  inbox(principal: string, options: { readonly threadId?: string; readonly afterSeq?: number; readonly limit: number }): MessageRecord[] {
    const args: (string | number)[] = [principal];
    let filter = "";
    if (options.threadId !== undefined) {
      filter = " AND r.thread_id = ? AND r.seq > ?";
      args.push(options.threadId, options.afterSeq ?? 0);
    }
    const sql = `SELECT ${MESSAGE_COLUMNS} FROM message_recipients r JOIN agent_messages m ON m.id = r.message_id WHERE r.principal = ?${filter} AND r.seq > coalesce((SELECT read_through FROM message_cursors c WHERE c.thread_id = r.thread_id AND c.principal = r.principal), 0) ORDER BY m.rowid LIMIT ?`;
    return (this.#db.prepare(sql).all(...args, bound(options.limit)) as Row[]).map(toMessage);
  }

  /** A project's settings as stored JSON (the service validates it), or undefined for the defaults. */
  settings(projectId: string): unknown {
    const r = this.#db.prepare("SELECT body FROM messaging_settings WHERE project_id = ?").get(projectId) as Row | undefined;
    return r === undefined ? undefined : parse(r["body"]);
  }

  setSettings(projectId: string, body: unknown): void {
    this.#db.prepare("INSERT INTO messaging_settings (project_id, body) VALUES (?, ?) ON CONFLICT (project_id) DO UPDATE SET body = excluded.body").run(projectId, JSON.stringify(body));
  }

  agentSettings(agentId: string): AgentMessagingSettings | undefined {
    const r = this.#db.prepare("SELECT accepts_from, cli_messaging, muted FROM messaging_agent_settings WHERE agent_id = ?").get(agentId) as Row | undefined;
    if (r === undefined) return undefined;
    return { acceptsFrom: str(r["accepts_from"]) as AgentMessagingSettings["acceptsFrom"], cliMessaging: int(r["cli_messaging"]) === 1, muted: int(r["muted"]) === 1 };
  }

  setAgentSettings(agentId: string, s: AgentMessagingSettings): void {
    this.#db
      .prepare("INSERT INTO messaging_agent_settings (agent_id, accepts_from, cli_messaging, muted) VALUES (?, ?, ?, ?) ON CONFLICT (agent_id) DO UPDATE SET accepts_from = excluded.accepts_from, cli_messaging = excluded.cli_messaging, muted = excluded.muted")
      .run(agentId, s.acceptsFrom, s.cliMessaging ? 1 : 0, s.muted ? 1 : 0);
  }

  /** Run `fn` in one transaction of the journal's database (an append with its audit row, a settings change with its row). */
  transact<T>(fn: () => T): T {
    return withTransaction(this.#db, fn);
  }
}
