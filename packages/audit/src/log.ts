// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalize, type JsonValue } from "./canonical.js";
import { runMigrations, withTransaction, type DatabaseSync, type Migration } from "./db.js";
import { AxisError } from "./errors.js";
import { Redactor } from "./redact.js";

/** `prevHash` of the first event. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * Actions written in Phase 1a (user and daemon actions; ADR 0004 implication 5).
 * Phase 1b adds agent approvals and tool calls under `agent.*`. The set is
 * open: any dotted lower-case name is accepted, these are the ones the
 * product relies on.
 */
export const AuditActions = {
  worktreeCreate: "worktree.create",
  worktreeRemove: "worktree.remove",
  gitCommit: "git.commit",
  gitPush: "git.push",
  gitDiscard: "git.discard",
  tier4Challenge: "tier4.challenge",
  tier4Execute: "tier4.execute",
  policyDecision: "policy.decision",
  journalRecovery: "journal.recovery",
} as const;

export const ACTOR_PATTERN = /^(?:user|daemon|agent:[A-Za-z0-9._-]{1,64})$/;
export const ACTION_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;

export type AuditActor = "user" | "daemon" | `agent:${string}`;
export const AUDIT_OUTCOMES = ["success", "failure", "denied", "error"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

const inputSchema = z
  .object({
    actor: z.string().regex(ACTOR_PATTERN),
    action: z.string().max(96).regex(ACTION_PATTERN),
    target: z.string().min(1).max(1024),
    outcome: z.enum(AUDIT_OUTCOMES),
    payload: z.unknown().optional(),
  })
  .strict();

export interface AuditEventInput {
  readonly actor: AuditActor;
  readonly action: string;
  /** What the action was applied to, for example `worktree:<id>`. Redacted before storage. */
  readonly target: string;
  readonly outcome: AuditOutcome;
  /** Free-form detail. Deep-redacted before it is hashed or stored. */
  readonly payload?: unknown;
}

export interface AuditEvent {
  readonly seq: number;
  readonly ts: string;
  readonly actor: AuditActor;
  readonly action: string;
  readonly target: string;
  readonly outcome: AuditOutcome;
  readonly payload: JsonValue;
  readonly prevHash: string;
  readonly hash: string;
}

/** The writing side, as consumers (such as the journal) see it. */
export interface AuditSink {
  append(input: AuditEventInput): AuditEvent;
}

export interface ChainHead {
  readonly seq: number;
  readonly hash: string;
}

export type VerifyFailureReason =
  | "malformed_row"
  | "seq_gap"
  | "hash_mismatch"
  | "prev_hash_mismatch"
  | "truncated";

export type VerifyResult =
  | { readonly ok: true; readonly count: number; readonly head: ChainHead | null }
  | {
      readonly ok: false;
      /** The first sequence number at which the chain stops being valid. */
      readonly firstBadSeq: number;
      readonly reason: VerifyFailureReason;
      readonly checked: number;
    };

export interface VerifyOptions {
  /**
   * A head recorded earlier (for example in a backup or the OS keychain). A
   * chain alone cannot reveal that its newest events were deleted; comparing
   * against a remembered head can.
   */
  readonly expectedHead?: ChainHead;
}

export interface AuditLogOptions {
  readonly redactor?: Redactor;
  readonly now?: () => Date;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE audit_events (
        seq       INTEGER PRIMARY KEY,
        ts        TEXT NOT NULL,
        actor     TEXT NOT NULL,
        action    TEXT NOT NULL,
        target    TEXT NOT NULL,
        outcome   TEXT NOT NULL,
        payload   TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash      TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
        BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
      CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
        BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
    `,
  },
];

export const AUDIT_SCHEMA_VERSION = MIGRATIONS.length;

interface Row {
  seq: unknown;
  ts: unknown;
  actor: unknown;
  action: unknown;
  target: unknown;
  outcome: unknown;
  payload: unknown;
  prev_hash: unknown;
  hash: unknown;
}

function hashEvent(e: Omit<AuditEvent, "hash">): string {
  return createHash("sha256")
    .update(
      canonicalize({
        seq: e.seq,
        ts: e.ts,
        actor: e.actor,
        action: e.action,
        target: e.target,
        outcome: e.outcome,
        payload: e.payload,
        prevHash: e.prevHash,
      }),
    )
    .digest("hex");
}

const COLUMNS = "seq, ts, actor, action, target, outcome, payload, prev_hash, hash";

/**
 * Append-only, hash-chained audit log in the `audit_events` table.
 *
 * Writers are serialised: `append` is synchronous on one connection (so
 * in-process calls cannot interleave) and takes `BEGIN IMMEDIATE`, so
 * several processes sharing the file queue on SQLite's write lock and each
 * reads the real head under that lock. The table also rejects UPDATE and
 * DELETE with triggers. That is defence in depth, not a security boundary:
 * the chain gives local tamper evidence against anyone who edits the file
 * without recomputing every later hash (ADR 0003 D5).
 */
export class AuditLog implements AuditSink {
  readonly #db: DatabaseSync;
  readonly #redactor: Redactor;
  readonly #now: () => Date;

  constructor(db: DatabaseSync, options: AuditLogOptions = {}) {
    this.#db = db;
    this.#redactor = options.redactor ?? new Redactor();
    this.#now = options.now ?? (() => new Date());
    runMigrations(db, "audit", MIGRATIONS);
  }

  get redactor(): Redactor {
    return this.#redactor;
  }

  append(input: AuditEventInput): AuditEvent {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) {
      // Zod issues can echo input values, so only the paths are reported.
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))].join(", ");
      throw new AxisError("E_INVALID_ARGUMENT", `Invalid audit event: ${fields}`);
    }
    const { actor, action, target, outcome } = parsed.data;
    const redactedTarget = this.#redactor.redactString(target);
    const payload = this.#redactor.redactValue(parsed.data.payload ?? null);
    const ts = this.#now().toISOString();

    return withTransaction(this.#db, () => {
      const head = this.#db.prepare("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1").get() as
        | { seq: number; hash: string }
        | undefined;
      const unsealed = {
        seq: (head?.seq ?? 0) + 1,
        ts,
        actor: actor as AuditActor,
        action,
        target: redactedTarget,
        outcome,
        payload,
        prevHash: head?.hash ?? GENESIS_HASH,
      };
      const event: AuditEvent = { ...unsealed, hash: hashEvent(unsealed) };
      this.#db
        .prepare(`INSERT INTO audit_events (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          event.seq,
          event.ts,
          event.actor,
          event.action,
          event.target,
          event.outcome,
          canonicalize(event.payload),
          event.prevHash,
          event.hash,
        );
      return event;
    });
  }

  head(): ChainHead | null {
    const row = this.#db.prepare("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1").get() as
      | { seq: number; hash: string }
      | undefined;
    return row ? { seq: row.seq, hash: row.hash } : null;
  }

  /** Events with `seq > afterSeq`, oldest first. */
  list(options: { readonly afterSeq?: number; readonly limit?: number } = {}): AuditEvent[] {
    const rows = this.#db
      .prepare(`SELECT ${COLUMNS} FROM audit_events WHERE seq > ? ORDER BY seq LIMIT ?`)
      .all(options.afterSeq ?? 0, options.limit ?? 1000) as unknown as Row[];
    return rows.map((row) => {
      const event = parseRow(row);
      if (!event) throw new AxisError("E_INTERNAL", "Audit row is malformed; run verify()");
      return event;
    });
  }

  /**
   * Recompute the whole chain. Detects edited fields (hash mismatch), deleted
   * rows (sequence gap), reordered rows (previous-hash mismatch) and, given
   * `expectedHead`, a deleted tail. Reports the first bad sequence number.
   */
  verify(options: VerifyOptions = {}): VerifyResult {
    let expectedSeq = 1;
    let prevHash = GENESIS_HASH;
    let checked = 0;
    const rows = this.#db.prepare(`SELECT ${COLUMNS} FROM audit_events ORDER BY seq`).iterate() as Iterable<Row>;
    for (const row of rows) {
      const event = parseRow(row);
      if (!event) {
        const seq = typeof row.seq === "number" ? row.seq : expectedSeq;
        return { ok: false, firstBadSeq: seq, reason: "malformed_row", checked };
      }
      if (event.seq !== expectedSeq) {
        return { ok: false, firstBadSeq: expectedSeq, reason: "seq_gap", checked };
      }
      if (hashEvent(event) !== event.hash) {
        return { ok: false, firstBadSeq: event.seq, reason: "hash_mismatch", checked };
      }
      if (event.prevHash !== prevHash) {
        return { ok: false, firstBadSeq: event.seq, reason: "prev_hash_mismatch", checked };
      }
      prevHash = event.hash;
      expectedSeq++;
      checked++;
    }
    const head: ChainHead | null = checked > 0 ? { seq: checked, hash: prevHash } : null;
    const expected = options.expectedHead;
    if (expected && (!head || head.seq < expected.seq)) {
      return { ok: false, firstBadSeq: (head?.seq ?? 0) + 1, reason: "truncated", checked };
    }
    if (expected && head) {
      const anchor = this.#db.prepare("SELECT hash FROM audit_events WHERE seq = ?").get(expected.seq) as
        | { hash: string }
        | undefined;
      if (anchor?.hash !== expected.hash) {
        return { ok: false, firstBadSeq: expected.seq, reason: "hash_mismatch", checked };
      }
    }
    return { ok: true, count: checked, head };
  }
}

function parseRow(row: Row): AuditEvent | null {
  const { seq, ts, actor, action, target, outcome, payload, prev_hash, hash } = row;
  if (
    typeof seq !== "number" ||
    !Number.isInteger(seq) ||
    typeof ts !== "string" ||
    typeof actor !== "string" ||
    typeof action !== "string" ||
    typeof target !== "string" ||
    typeof outcome !== "string" ||
    typeof payload !== "string" ||
    typeof prev_hash !== "string" ||
    typeof hash !== "string"
  ) {
    return null;
  }
  let parsedPayload: JsonValue;
  try {
    parsedPayload = JSON.parse(payload) as JsonValue;
  } catch {
    return null;
  }
  return {
    seq,
    ts,
    actor: actor as AuditActor,
    action,
    target,
    outcome: outcome as AuditOutcome,
    payload: parsedPayload,
    prevHash: prev_hash,
    hash,
  };
}
