// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalize, type JsonValue } from "./canonical.js";
import { mapSqlite, runMigrations, withTransaction, type DatabaseSync, type Migration } from "./db.js";
import { AxisError } from "./errors.js";
import { applyPayloadPolicy, DEFAULT_PAYLOAD_ALLOWLIST } from "./payload-policy.js";
import { Redactor, isWellFormedString } from "./redact.js";

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
    actor: z.string().regex(ACTOR_PATTERN).refine(isWellFormedString),
    action: z.string().max(96).regex(ACTION_PATTERN).refine(isWellFormedString),
    // Lone surrogates would be rewritten by SQLite on the way in, so the stored form would stop matching its hash.
    target: z.string().min(1).max(1024).refine(isWellFormedString),
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
  | "unsupported_version"
  | "hash_mismatch"
  | "prev_hash_mismatch"
  | "truncated";

export type VerifyResult =
  | {
      readonly ok: true;
      readonly count: number;
      readonly head: ChainHead | null;
      /** Present (true) only when `limit` stopped the scan before the end: more events follow `head`. */
      readonly more?: true;
    }
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
  /** Start after this verified head instead of at genesis (incremental check). */
  readonly from?: ChainHead;
  /**
   * Check at most this many events after the start, so a caller can scan a long log in slices and yield between
   * them. When events remain the result is `ok: true` with `more: true` and the head reached so far; `expectedHead`
   * is compared only by the slice that reaches the end. A positive integer.
   */
  readonly limit?: number;
}

export interface AuditLogOptions {
  readonly redactor?: Redactor;
  /** Extra per-action payload keys, merged over `DEFAULT_PAYLOAD_ALLOWLIST`. */
  readonly payloadAllowlist?: Readonly<Record<string, readonly string[]>>;
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
        hash      TEXT NOT NULL UNIQUE,
        hash_version INTEGER NOT NULL DEFAULT 1
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
  hash_version: unknown;
}

function hashEvent(e: Omit<AuditEvent, "hash">): string {
  return createHash("sha256")
    .update(
      canonicalize({
        v: HASH_VERSION,
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

/**
 * Version of the hashed form, inside the hash input and stored per row. A
 * future field or algorithm change bumps it, and old rows keep verifying
 * under their own version. Only version 1 exists.
 */
export const HASH_VERSION = 1;

const COLUMNS = "seq, ts, actor, action, target, outcome, payload, prev_hash, hash, hash_version";

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
  readonly #allowlist: Readonly<Record<string, readonly string[]>>;

  constructor(db: DatabaseSync, options: AuditLogOptions = {}) {
    this.#db = db;
    this.#redactor = options.redactor ?? new Redactor();
    this.#now = options.now ?? (() => new Date());
    this.#allowlist = { ...DEFAULT_PAYLOAD_ALLOWLIST, ...options.payloadAllowlist };
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
    // Redact first, then keep only what the action's allowlist permits (ADR 0003 D5).
    const payload = applyPayloadPolicy(
      action,
      this.#redactor.redactValue(parsed.data.payload ?? null),
      this.#allowlist,
      (s) => this.#redactor.redactString(s),
    );
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
        .prepare(`INSERT INTO audit_events (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
          HASH_VERSION,
        );
      return event;
    });
  }

  /** True when this log writes through exactly this connection (identity, not path equality). */
  isBoundTo(db: DatabaseSync): boolean {
    return this.#db === db;
  }

  /**
   * Verify the chain and return its head as an anchor. Persist the anchor
   * OUTSIDE the database (see docs/packages.md) and pass it back as
   * `verify({ expectedHead })` at the next start: that is the only way to
   * detect deletion of the newest events (threat model G-11). Throws
   * `E_INTERNAL` if the chain is already broken, so a bad chain is never
   * anchored. Returns null for an empty log.
   *
   * With `since` (the previous anchor) only the events after it are checked,
   * starting from its hash, so the cost is proportional to what was appended
   * since. The anchor row's own hash is recomputed from its content, but rows
   * before it are not read, so an edit at or before the previous anchor is
   * caught only by the full form (and the external anchor) at the next start.
   * Run the full form (no argument) at startup.
   */
  checkpoint(since?: ChainHead): ChainHead | null {
    const result = this.verify(since ? { from: since } : {});
    if (!result.ok) {
      throw new AxisError("E_INTERNAL", "Audit chain failed verification; refusing to checkpoint it", {
        firstBadSeq: result.firstBadSeq,
        reason: result.reason,
      });
    }
    return result.head;
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
      if (!event || event === "unsupported") throw new AxisError("E_INTERNAL", "Audit row is malformed; run verify()");
      return event;
    });
  }

  /**
   * Recompute the chain. Detects edited fields (hash mismatch), deleted rows
   * (sequence gap), reordered rows (previous-hash mismatch) and, given
   * `expectedHead`, a deleted tail. Reports the first bad sequence number.
   * With `from` (a head verified earlier) it starts after that row instead of
   * at genesis, after checking the row still has that hash.
   */
  verify(options: VerifyOptions = {}): VerifyResult {
    return mapSqlite(() => this.#verify(options));
  }

  #verify(options: VerifyOptions): VerifyResult {
    const limit = options.limit;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new AxisError("E_INVALID_ARGUMENT", "limit must be a positive integer");
    }
    const from = options.from;
    let expectedSeq = (from?.seq ?? 0) + 1;
    let prevHash = from?.hash ?? GENESIS_HASH;
    let checked = 0;
    if (from) {
      const row = this.#db.prepare(`SELECT ${COLUMNS} FROM audit_events WHERE seq = ?`).get(from.seq) as unknown as Row | undefined;
      if (!row) {
        const h = this.head();
        // Later rows exist but the start row is gone: a deleted row in the middle, reported where it is missing.
        if (h !== null && h.seq > from.seq) return { ok: false, firstBadSeq: from.seq, reason: "seq_gap", checked };
        return { ok: false, firstBadSeq: (h?.seq ?? 0) + 1, reason: "truncated", checked };
      }
      // Do not trust the stored hash column: recompute it from the row's content, so an edit to the anchor row itself is caught.
      const anchorRow = parseRow(row);
      if (anchorRow === "unsupported") return { ok: false, firstBadSeq: from.seq, reason: "unsupported_version", checked };
      if (!anchorRow) return { ok: false, firstBadSeq: from.seq, reason: "malformed_row", checked };
      if (anchorRow.hash !== from.hash || hashEvent(anchorRow) !== from.hash) {
        return { ok: false, firstBadSeq: from.seq, reason: "hash_mismatch", checked };
      }
    }
    let more = false;
    // One row past the limit tells whether the slice ended before the log did.
    const rows = this.#db
      .prepare(`SELECT ${COLUMNS} FROM audit_events WHERE seq > ? ORDER BY seq${limit === undefined ? "" : " LIMIT ?"}`)
      .iterate(...(limit === undefined ? [from?.seq ?? 0] : [from?.seq ?? 0, limit + 1])) as Iterable<Row>;
    for (const row of rows) {
      if (limit !== undefined && checked >= limit) {
        more = true;
        break;
      }
      const event = parseRow(row);
      if (event === "unsupported") {
        return { ok: false, firstBadSeq: expectedSeq, reason: "unsupported_version", checked };
      }
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
    const head: ChainHead | null = expectedSeq > 1 ? { seq: expectedSeq - 1, hash: prevHash } : null;
    if (more) return { ok: true, count: head?.seq ?? 0, head, more: true };
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
    return { ok: true, count: head?.seq ?? 0, head };
  }
}

function parseRow(row: Row): AuditEvent | "unsupported" | null {
  const { seq, ts, actor, action, target, outcome, payload, prev_hash, hash, hash_version } = row;
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
    typeof hash !== "string" ||
    typeof hash_version !== "number"
  ) {
    return null;
  }
  if (hash_version !== HASH_VERSION) return "unsupported";
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
