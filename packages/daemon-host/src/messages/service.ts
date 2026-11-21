// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { MessageRecords, ThreadRecord } from "@axis/journal";
import {
  MAX_READ_MESSAGES,
  MAX_RECIPIENTS,
  MAX_THREADS_LIST,
  MAX_THREAD_PARTICIPANTS,
  encodeMessagingId,
  principalKey,
  principalSchema,
  type MessagesRequest,
  type MessagesResponse,
  type Principal,
} from "@axis/protocol";
import { MESSAGE_AUDIT, row, who, type MessageAuditSink } from "./audit.js";
import { MINUTE_MS, TotalCounter, WindowCounter, checkLimits, type MessagingLimits } from "./limits.js";
import {
  DEFAULT_PROJECT_SETTINGS,
  MessageRefusal,
  NOT_FOUND,
  callerKey,
  defaultAgentSettings,
  expandRecipients,
  hopOf,
  mayAddress,
  newThreadProject,
  projectSettingsSchema,
  recipientPaused,
  refuse,
  senderEntry,
  senderPaused,
  type AgentEntry,
  type MessageCaller,
  type MessagingDirectory,
  type PolicyContext,
} from "./policy.js";
import { StoredRecordError, checked, pageByText, principalOf, toWire } from "./wire.js";

/**
 * The message service of `axis.messages/1` (ticket PV-M3 slice 1; docs/design/inter-agent-communication.md sections 2,
 * 4, 7 and 8; docs/design/messages-contract.md). Every method takes the caller as its binding attested it, never from a
 * payload. Sends and reads by anyone but the user pass rate limits first; then every decision and the write happen in
 * one journal transaction with their audit row, so a setting cannot change between the check and the append.
 *
 * NO EXISTENCE ORACLE (section 4.2). Every method that names a thread resolves it through `#resolve`, which always runs
 * the same two lookups (the thread, the caller's participation) whether or not the thread exists, and refuses an
 * unknown and a hidden thread on one path: the same audit row (`message.read.refused` or `message.send.refused` with
 * the requested id and `not_found`), the same `MessageRefusal`. A message named by `inReplyTo` follows the same rule.
 *
 * DELIVERY is slice 2. `deliverable` is its hook: it runs the send policy and Pause again against the settings of the
 * moment, so a message accepted under a setting the user has since turned off is not delivered (gate line 14).
 */

export interface MessageServiceDeps {
  /** The journal's message records (`journal.messages`). */
  readonly store: MessageRecords;
  readonly directory: MessagingDirectory;
  /** The host's audit log, in the journal's database (rows commit with the message). */
  readonly audit: MessageAuditSink;
  /** Called after each audit row (the anchor guard's `noteWrite`). */
  readonly noteWrite?: () => void;
  /** The daemon's CSPRNG (`randomBytes`): every thread and message id is 16 of its bytes. */
  readonly random: { bytes(n: number): Uint8Array };
  readonly monotonic: () => number;
  /** The secret scan of a body (section 8.2): the findings, or a throw when it cannot scan it all (then it refuses). */
  readonly scan: (text: string) => Promise<readonly unknown[]>;
  readonly limits?: Partial<MessagingLimits>;
}

export interface MessageService {
  send(caller: MessageCaller, req: MessagesRequest<"send">): Promise<MessagesResponse<"send">>;
  thread(caller: MessageCaller, req: MessagesRequest<"thread">): MessagesResponse<"thread">;
  threads(caller: MessageCaller, req: MessagesRequest<"threads">): MessagesResponse<"threads">;
  read(caller: MessageCaller, req: MessagesRequest<"read">): MessagesResponse<"read">;
  markRead(caller: MessageCaller, req: MessagesRequest<"markRead">): MessagesResponse<"markRead">;
  /** Slice 2's delivery check: null when `recipient` may still receive `messageId` now, else the refusal reason. */
  deliverable(messageId: string, recipient: Principal): string | null;
  /** The policy context of a project with its current settings (also used by the settings service). */
  context(projectId: string): PolicyContext;
}

export function createMessageService(deps: MessageServiceDeps): MessageService {
  const { store, directory } = deps;
  const limits = checkLimits(deps.limits);
  const now = deps.monotonic;
  const sendRate = new WindowCounter(limits.sendsPerMinute, MINUTE_MS, limits.maxTrackedKeys, now);
  const runTotal = new TotalCounter(limits.sendsPerRun, limits.maxTrackedKeys);
  const projectRate = new WindowCounter(limits.projectSendsPerMinute, MINUTE_MS, limits.maxTrackedKeys, now);
  const readRate = new WindowCounter(limits.readsPerMinute, MINUTE_MS, limits.maxTrackedKeys, now);
  // A rate refusal is audited once per caller and minute (section 8.1, aggregated), so a flood cannot grow the audit log.
  const rateAudit = new WindowCounter(1, MINUTE_MS, limits.maxTrackedKeys, now);

  const audit = (input: Parameters<MessageAuditSink["append"]>[0]): void => {
    deps.audit.append(input);
    deps.noteWrite?.();
  };
  const rateLimited = (): never => refuse("E_BACKPRESSURE", "rate_limited");

  function context(projectId: string): PolicyContext {
    const stored = store.settings(projectId);
    const parsed = stored === undefined ? { success: true as const, data: DEFAULT_PROJECT_SETTINGS } : projectSettingsSchema.safeParse(stored);
    if (!parsed.success) throw new StoredRecordError();
    return { projectId, settings: parsed.data, directory, agentSettings: (a: AgentEntry) => store.agentSettings(a.agentId) ?? defaultAgentSettings(a) };
  }

  /** One path for an unknown and a hidden thread (see the class comment): both lookups always run. */
  function resolve(caller: MessageCaller, key: string, threadId: string): { thread: ThreadRecord; joinedSeq: number } {
    const thread = store.thread(threadId);
    const part = store.participant(threadId, key);
    if (thread === undefined || (caller.kind !== "user" && part === undefined)) return NOT_FOUND();
    return { thread, joinedSeq: caller.kind === "user" ? 0 : (part?.joinedSeq ?? 0) };
  }

  /** Run a read; a refusal is audited as `message.read.refused` with the requested thread id and the reason, never text. */
  function reading<T>(caller: MessageCaller, method: string, threadId: string | undefined, fn: () => T): T {
    try {
      if (caller.kind !== "user" && !readRate.take(callerKey(caller))) rateLimited();
      return fn();
    } catch (e) {
      if (e instanceof MessageRefusal && (e.reason !== "rate_limited" || rateAudit.take(`read:${callerKey(caller)}`))) audit(row(caller, MESSAGE_AUDIT.readRefused, `thread:${threadId ?? "inbox"}`, "denied", { ...who(caller), method, reason: e.reason, ...(threadId === undefined ? {} : { threadId }) }));
      throw e;
    }
  }

  function summary(thread: ThreadRecord, key: string) {
    const participants = store.participants(thread.id).map((p) => principalOf(p.principal));
    if (participants.some((p) => p === undefined)) throw new StoredRecordError();
    return {
      threadId: thread.id,
      projectId: thread.projectId,
      createdAt: thread.createdAt,
      lastSeq: thread.lastSeq,
      lastAt: thread.lastAt,
      unread: store.unread(thread.id, key),
      participants: participants as Principal[],
    };
  }

  function accept(caller: MessageCaller, req: MessagesRequest<"send">, findings: number): MessagesResponse<"send"> {
    const key = callerKey(caller);
    let projectId: string;
    let thread: ThreadRecord | undefined;
    let joinedSeq = 0;
    if (req.threadId !== undefined) {
      ({ thread, joinedSeq } = resolve(caller, key, req.threadId));
      projectId = thread.projectId;
    } else {
      projectId = newThreadProject(caller, req.recipients, directory);
    }
    const ctx = context(projectId);
    const sender = senderEntry(caller, ctx);
    if (senderPaused(caller, sender, ctx.settings)) refuse("E_CONFLICT", "paused");
    if (caller.kind !== "user" && !projectRate.take(projectId)) rateLimited();
    let replyHop: number | undefined;
    if (req.inReplyTo !== undefined) {
      const target = thread === undefined ? undefined : store.message(req.inReplyTo);
      if (target === undefined || thread === undefined || target.threadId !== thread.id || !store.visible(target.id, key, joinedSeq)) return NOT_FOUND();
      replyHop = target.hop;
    }
    const hop = hopOf(caller, replyHop);
    const expanded = expandRecipients(caller, sender, req.recipients, ctx, MAX_RECIPIENTS);
    if (findings !== 0) {
      // M-6: `warn` only when every recipient is a composer agent or the user; a message to a CLI agent always refuses.
      const warnable = ctx.settings.secretScan === "warn" && findings > 0 && expanded.every((p) => p.kind === "user" || (p.kind === "agent" && directory.agent(p.agentId)?.kind === "composer"));
      if (!warnable) refuse("E_CONFLICT", "secret_found");
    }
    if (thread !== undefined && thread.lastSeq >= limits.messagesPerThread) refuse("E_INVALID_ARGUMENT", "too_large");
    if (thread === undefined && store.threadCount(projectId) >= limits.threadsPerProject) refuse("E_BACKPRESSURE", "queue_full");
    const present = new Set(thread === undefined ? [] : store.participants(thread.id).map((p) => p.principal));
    const join = [key, ...expanded.map(principalKey)].filter((k, i, all) => !present.has(k) && all.indexOf(k) === i);
    if (present.size + join.length > MAX_THREAD_PARTICIPANTS) refuse("E_INVALID_ARGUMENT", "too_many_recipients");
    const counted = caller.kind !== "user";
    if (counted) {
      for (const p of expanded) {
        const to = principalKey(p);
        if (store.queued(to) >= limits.queuePerRecipient || store.queued(to, key) >= limits.queuePerSender) refuse("E_BACKPRESSURE", "queue_full");
      }
    }
    const threadId = thread?.id ?? encodeMessagingId("thread", deps.random.bytes(16));
    const messageId = encodeMessagingId("message", deps.random.bytes(16));
    const senderWire =
      caller.kind === "user"
        ? { kind: "user", verified: true }
        : caller.kind === "agent"
          ? { kind: "agent", agentId: caller.agentId, runId: caller.runId, verified: caller.verified }
          : { kind: "plugin", pluginId: caller.pluginId, verified: true };
    const rec = store.append({
      thread: thread === undefined ? { create: true, id: threadId, projectId } : { create: false, id: threadId },
      join,
      message: { id: messageId, sender: senderWire, senderKey: key, recipients: req.recipients, expanded, body: req.body.text, refs: req.refs ?? [], inReplyTo: req.inReplyTo ?? null, hop },
      to: expanded.map((p) => ({ principal: principalKey(p), counted })),
    });
    const message = toWire(rec, projectId);
    audit(
      row(caller, MESSAGE_AUDIT.send, `thread:${threadId}`, "success", {
        ...who(caller),
        messageId,
        threadId,
        projectId,
        newThread: thread === undefined,
        recipientCount: req.recipients.length,
        expandedCount: expanded.length,
        bodyLength: req.body.text.length,
        refsCount: req.refs?.length ?? 0,
        hop,
      }),
    );
    return { message, replayed: false };
  }

  return {
    context,

    async send(caller, raw) {
      const req = checked("send", raw);
      const key = callerKey(caller);
      const refused = (reason: string, e: unknown): never => {
        if (reason === "rate_limited" && !rateAudit.take(`send:${key}`)) throw e;
        audit(row(caller, MESSAGE_AUDIT.sendRefused, `thread:${req.threadId ?? "new"}`, "denied", { ...who(caller), reason, ...(req.threadId === undefined ? {} : { threadId: req.threadId }) }));
        throw e;
      };
      try {
        if (caller.kind !== "user" && (!sendRate.take(key) || (caller.kind === "agent" && caller.runId !== null && !runTotal.take(caller.runId)))) rateLimited();
        // Excerpts need the review path's containment and the path refusals (a later slice): refused until then.
        if ((req.refs ?? []).some((r) => r.type === "excerpt")) refuse("E_CONFLICT", "excerpt_path_refused");
      } catch (e) {
        if (e instanceof MessageRefusal) refused(e.reason, e);
        throw e;
      }
      let findings: number;
      try {
        findings = (await deps.scan(req.body.text)).length;
      } catch {
        findings = -1; // could not scan it all: refused in either mode
      }
      try {
        return store.transact(() => accept(caller, req, findings));
      } catch (e) {
        if (e instanceof MessageRefusal) refused(e.reason, e);
        throw e;
      }
    },

    thread(caller, raw) {
      const req = checked("thread", raw);
      return reading(caller, "thread", req.threadId, () => {
        const key = callerKey(caller);
        const { thread, joinedSeq } = resolve(caller, key, req.threadId);
        const afterSeq = req.afterSeq ?? 0;
        const limit = Math.min(req.limit ?? MAX_READ_MESSAGES, MAX_READ_MESSAGES);
        const page = pageByText(store.visibleAfter(thread.id, key, joinedSeq, afterSeq, limit).map((m) => toWire(m, thread.projectId)));
        const last = page.messages[page.messages.length - 1];
        const nextSeq = last === undefined ? Math.min(afterSeq, thread.lastSeq) : last.seq;
        const complete = store.visibleAfter(thread.id, key, joinedSeq, nextSeq, 1).length === 0;
        return { thread: summary(thread, key), messages: page.messages, nextSeq, complete };
      });
    },

    threads(caller, raw) {
      const req = checked("threads", raw);
      return reading(caller, "threads", undefined, () => {
        const key = callerKey(caller);
        const limit = Math.min(req.limit ?? MAX_THREADS_LIST, MAX_THREADS_LIST);
        const filter = req.projectId === undefined ? {} : { projectId: req.projectId };
        const rows = caller.kind === "user" ? store.threads({ ...filter, limit }) : store.threads({ ...filter, principal: key, limit });
        return { threads: rows.map((t) => summary(t, key)) };
      });
    },

    read(caller, raw) {
      const req = checked("read", raw);
      return reading(caller, "read", req.threadId, () => {
        const key = callerKey(caller);
        if (req.threadId !== undefined) resolve(caller, key, req.threadId);
        const limit = Math.min(req.limit ?? MAX_READ_MESSAGES, MAX_READ_MESSAGES);
        const recs = store.inbox(key, { ...(req.threadId === undefined ? {} : { threadId: req.threadId, afterSeq: req.afterSeq ?? 0 }), limit: limit + 1 });
        const projectOf = new Map<string, string>();
        const toProject = (id: string): string => {
          const known = projectOf.get(id) ?? store.thread(id)?.projectId;
          if (known === undefined) throw new StoredRecordError();
          projectOf.set(id, known);
          return known;
        };
        const page = pageByText(recs.slice(0, limit).map((m) => toWire(m, toProject(m.threadId))));
        return { messages: page.messages, more: recs.length > limit || page.cut };
      });
    },

    markRead(caller, raw) {
      const req = checked("markRead", raw);
      return reading(caller, "markRead", req.threadId, () => {
        const key = callerKey(caller);
        const { thread } = resolve(caller, key, req.threadId);
        const readThrough = store.markRead(thread.id, key, Math.min(req.throughSeq, thread.lastSeq));
        return { threadId: thread.id, readThrough, unread: store.unread(thread.id, key) };
      });
    },

    deliverable(messageId, recipient) {
      const m = store.message(messageId);
      const thread = m === undefined ? undefined : store.thread(m.threadId);
      if (m === undefined || thread === undefined) return "not_found";
      // Only a recipient the message was addressed to at accept time (its recorded expansion) can receive it.
      const to = principalKey(recipient);
      if (!Array.isArray(m.expanded) || !m.expanded.some((p) => principalSchema.safeParse(p).success && principalKey(p as Principal) === to)) return "not_found";
      const ctx = context(thread.projectId);
      const s = m.sender as { kind?: string; agentId?: string; runId?: string | null; verified?: boolean; pluginId?: string };
      const caller: MessageCaller | undefined =
        s.kind === "user" ? { kind: "user" } : s.kind === "agent" && typeof s.agentId === "string" ? { kind: "agent", agentId: s.agentId, runId: s.runId ?? null, verified: s.verified === true, receivedHop: 0 } : s.kind === "plugin" && typeof s.pluginId === "string" ? { kind: "plugin", pluginId: s.pluginId, receivedHop: 0 } : undefined;
      if (caller === undefined) return "recipient_refused";
      let sender: AgentEntry | undefined;
      try {
        sender = senderEntry(caller, ctx);
      } catch (e) {
        return e instanceof MessageRefusal ? e.reason : "recipient_refused";
      }
      if (senderPaused(caller, sender, ctx.settings) || recipientPaused(recipient, ctx)) return "paused";
      return mayAddress(caller, sender, recipient, ctx);
    },
  };
}
