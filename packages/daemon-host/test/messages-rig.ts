// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import { AuditLog, openDatabase, type DatabaseSync } from "@axis/audit";
import { Journal } from "@axis/journal";
import type { MessagesRequest } from "@axis/protocol";
import {
  MESSAGES_PAYLOAD_ALLOWLIST,
  MessageRefusal,
  createMessagingBinding,
  type AgentEntry,
  type GroupEntry,
  type MessageCaller,
  type MessagingBinding,
  type MessagingDirectory,
  type MessagingLimits,
} from "../src/index.js";
import { fakeClock } from "./helpers.js";

/**
 * A message service over a real journal and audit log (in-memory SQLite) with a directory the test controls. Projects
 * p1 and p2; in p1 group g1 holds composer agents a1 and a2 and CLI agent c1, group g2 holds composer b1; in p2 group gx
 * holds x1.
 */
export interface MessagesRig {
  readonly db: DatabaseSync;
  readonly journal: Journal;
  readonly audit: AuditLog;
  readonly binding: MessagingBinding;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly agents: Map<string, AgentEntry>;
  readonly groups: Map<string, GroupEntry>;
  /** Every id byte source call, so a test sees that ids come from 16 random bytes each. */
  readonly drawn: number[];
  /** What the next scan reports: a number of findings, or "throw". */
  scanResult: number | "throw";
  close(): void;
}

export const USER: MessageCaller = Object.freeze({ kind: "user" });
export const agent = (agentId: string, over: Partial<{ runId: string | null; receivedHop: number; verified: boolean }> = {}): MessageCaller => ({
  kind: "agent",
  agentId,
  runId: over.runId === undefined ? `run-${agentId}` : over.runId,
  verified: over.verified ?? true,
  receivedHop: over.receivedHop ?? 0,
});
export const plugin = (pluginId: string): MessageCaller => ({ kind: "plugin", pluginId, receivedHop: 0 });

export function messagesRig(options: { limits?: Partial<MessagingLimits>; path?: string; db?: DatabaseSync } = {}): MessagesRig {
  const db = options.db ?? openDatabase(options.path ?? ":memory:");
  const audit = new AuditLog(db, { payloadAllowlist: MESSAGES_PAYLOAD_ALLOWLIST });
  const journal = Journal.open(db, { audit });
  for (const [id, path] of [["p1", "/repo/one"], ["p2", "/repo/two"]] as const) {
    if (journal.getProject(id) === undefined) journal.registerProject({ id, path, displayName: id, trusted: false, actor: "user" });
  }
  const agents = new Map<string, AgentEntry>();
  const groups = new Map<string, GroupEntry>();
  const add = (agentId: string, projectId: string, groupId: string | null, kind: "composer" | "cli" = "composer"): void => {
    agents.set(agentId, { agentId, projectId, groupId, kind });
    if (groupId !== null) {
      const g = groups.get(groupId) ?? { groupId, projectId, members: [] };
      groups.set(groupId, { ...g, members: [...g.members, agentId] });
    }
  };
  add("a1", "p1", "g1");
  add("a2", "p1", "g1");
  add("c1", "p1", "g1", "cli");
  add("b1", "p1", "g2");
  add("x1", "p2", "gx");
  const directory: MessagingDirectory = {
    project: (id) => journal.getProject(id) !== undefined,
    agent: (id) => agents.get(id),
    group: (id) => groups.get(id),
    agents: (projectId) => [...agents.values()].filter((a) => a.projectId === projectId),
  };
  const clock = fakeClock();
  const drawn: number[] = [];
  const rig: MessagesRig = {
    db,
    journal,
    audit,
    clock,
    agents,
    groups,
    drawn,
    scanResult: 0,
    binding: undefined as never,
    close: () => db.close(),
  };
  (rig as { binding: MessagingBinding }).binding = createMessagingBinding({
    holdsSecret: () => false,
    journal,
    audit,
    random: { bytes: (n) => (drawn.push(n), randomBytes(n)) },
    monotonic: () => clock.monotonic(),
    scan: async (text) => {
      if (rig.scanResult === "throw") throw new Error(`scanner failed on ${text}`);
      return Array.from({ length: rig.scanResult }, () => ({ rule: "generic-secret-assignment" }));
    },
    directory,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  return rig;
}

export const body = (text: string) => ({ format: "text" as const, text });
export const sendReq = (recipients: MessagesRequest<"send">["recipients"], text = "hello", over: Partial<MessagesRequest<"send">> = {}): MessagesRequest<"send"> => ({ recipients, body: body(text), ...over });

/** The refusal `fn` throws, as `code/reason`, or "ok". */
export async function outcome(fn: () => unknown): Promise<string> {
  try {
    await fn();
    return "ok";
  } catch (e) {
    if (e instanceof MessageRefusal) return `${e.code}/${e.reason}`;
    throw e;
  }
}

/** Every audit row the log holds, oldest first. */
export function auditRows(r: MessagesRig): { action: string; actor: string; target: string; payload: Record<string, unknown> }[] {
  return r.audit.list({ limit: 1000 }).map((e) => ({ action: e.action, actor: e.actor, target: e.target, payload: (e.payload ?? {}) as Record<string, unknown> }));
}
