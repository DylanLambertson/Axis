// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomUUID } from "node:crypto";
import {
  AuditActions,
  AuditLog,
  AxisError,
  InstanceLock,
  canonicalize,
  runMigrations,
  withTransaction,
  type DatabaseSync,
  type JsonValue,
  type Redactor,
} from "@axis/audit";
import { JOURNAL_MIGRATIONS } from "./schema.js";
import { RESTART_REASON } from "./states.js";
import { parts, positive } from "./idempotency-keys.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const INTERRUPTED_TTL_MS = 7 * DAY_MS;
const MAX_TTL_MS = 365 * DAY_MS;
const HOUR_MS = 60 * 60 * 1000;
/** An actor below this many unevictable rows is never refused by the table-wide rule (the daemon's default in-flight limit). */
const PENDING_FLOOR = 16;
/** How long a wall clock far ahead of the monotonic clock must hold steady before expiry follows it. */
const CONFIRM_MS = HOUR_MS;
const JITTER_MS = 5 * 60_000;

/** A replayed result is freshly parsed, so it is plain mutable JSON (what the daemon's interface expects). */
export type StoredJson = null | boolean | number | string | StoredJson[] | { [key: string]: StoredJson };

export type UnknownReason = "interrupted" | "result-not-stored" | "failed-after-start";

/** Structurally the same as `@axis/daemon`'s `IdempotencyKey` (this package does not depend on the daemon). */
export interface StoreKey {
  readonly actorId: string;
  readonly workspaceId: string;
  readonly contract: string;
  readonly version: number;
  readonly method: string;
  readonly key: string;
}

/** Structurally the same as `@axis/daemon`'s `IdempotencyBegin`. */
export type StoreBegin =
  | { readonly state: "new" }
  | { readonly state: "replay"; readonly result: StoredJson; readonly origin: string }
  | { readonly state: "conflict" }
  | { readonly state: "unknown"; readonly reason: UnknownReason }
  | { readonly state: "in-progress" }
  | { readonly state: "exhausted" };

export interface IdempotencyStoreOptions {
  /** Must be bound to the same `DatabaseSync` handle (checked), so recovery commits with its audit event. */
  readonly audit: AuditLog;
  /**
   * The process redactor (with the vault's secrets registered). A result is stored only if redaction changes
   * nothing, so no secret-derived text is ever written; otherwise only the outcome is kept (`result-not-stored`).
   */
  readonly redactor: Redactor;
  readonly now?: () => number;
  /** Monotonic milliseconds (default `performance.now`); expiry follows a wall clock far ahead only after it holds steady on this. */
  readonly monotonic?: () => number;
  /** Replay window for a settled key, measured from when it settled. Default 24 h. Also bounds `result-not-stored`. */
  readonly ttlMs?: number;
  /** How long an `interrupted` unknown key is remembered (never evicted before). Default 7 days. */
  readonly interruptedTtlMs?: number;
  /** Rows across all callers. Default 10 000. */
  readonly maxEntries?: number;
  /** Rows one actor may hold in one workspace. Default 1 000. */
  readonly maxPerActor?: number;
  /**
   * Rows that cannot be evicted (`in-progress` and `unknown`) one actor may hold across all its workspaces. A
   * caller over it gets `exhausted`; nobody else is affected. Default `maxEntries / 20` (at least 1).
   */
  readonly maxPendingPerActor?: number;
  /** The same, for one actor in one workspace. Default half of `maxPendingPerActor` (at least 1). */
  readonly maxPendingPerWorkspace?: number;
  /** Canonical-JSON bytes of one stored result. Default 64 KiB. */
  readonly maxResultBytes?: number;
  /** Stored result bytes across all rows. Default 32 MiB. */
  readonly maxTotalBytes?: number;
  /** Stored result bytes one actor may hold in one workspace. Default `maxTotalBytes / 8`. */
  readonly maxShareBytes?: number;
  /** Minimum time between expiry sweeps. Default one minute. */
  readonly sweepEveryMs?: number;
  readonly bootId?: () => string;
}

interface Row {
  request_hash: string;
  state: "in-progress" | "completed" | "unknown";
  boot_id: string;
  unknown_reason: UnknownReason | null;
  result: string | null;
  origin: string;
  expires_at: number;
}

const WHERE = "actor_id = ? AND workspace_id = ? AND contract = ? AND version = ? AND method = ? AND key = ?";

/**
 * The daemon's durable idempotency store, in the journal's own database (ADR 0005 D9). `@axis/daemon` only sees
 * its `IdempotencyStore` interface; this class has no daemon import.
 *
 * - A key is `in-progress` from `begin` until `complete` or `abandon`. A row left `in-progress` by an earlier
 *   boot (the process died mid-call) is read as `unknown` and never re-run: the caller must use a new key.
 *   `recover(lock)` converts such rows eagerly and audits the count.
 * - Keys are scoped by actor, workspace, contract, version and method. Only `completed` rows are ever evicted;
 *   `in-progress` and `unknown` rows are never evicted (an unknown key coming back as `new` would re-run a
 *   possibly done side effect), and `unknown` rows expire only by TTL (7 days when interrupted, else 24 h).
 *   Quotas: rows and result bytes per actor and workspace (it evicts its own oldest completed rows, else
 *   `exhausted` / `result-not-stored`), then rows and bytes overall (the heaviest holder's oldest completed
 *   rows go first, so one caller cannot starve the rest). Rows that cannot be evicted (`in-progress`, `unknown`)
 *   are capped per actor (across workspaces) and per actor and workspace: over its cap that actor alone gets
 *   `exhausted`, so cancelling or timing out writes cannot lock other callers out.
 * - Every write is one `withTransaction` on the shared handle, so a kill leaves the old row or the new one.
 * - If `complete` cannot be stored, the following `abandon` keeps the key as `unknown` instead of freeing it;
 *   `markUnknown` does the same when the handler succeeded but the call then failed.
 * - Time is wall clock (it has to survive a restart), guarded by the monotonic clock: one trusted time starts each boot
 *   from a saved value and follows a reading only within an hour of where uptime says it should be; a reading
 *   further off, ahead or behind, moves nothing until that offset has held steady for an hour. Rows are created,
 *   expire and are deleted by the trusted time. Small steps back inside a boot are ignored. `now` must return
 *   integer epoch milliseconds. Exact limits: docs/packages.md.
 * - `complete` must not be called inside an outer transaction (it would not be durable on return).
 */
export class JournalIdempotencyStore {
  readonly #db: DatabaseSync;
  readonly #audit: AuditLog;
  readonly #redactor: Redactor;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #interruptedTtlMs: number;
  readonly #maxShareBytes: number;
  readonly #maxEntries: number;
  readonly #maxPerActor: number;
  readonly #maxPending: number;
  readonly #maxPendingWorkspace: number;
  readonly #maxResultBytes: number;
  readonly #maxTotalBytes: number;
  readonly #sweepEveryMs: number;
  readonly #boot: string;
  readonly #poisoned = new Set<string>();
  #lastSweep: number;
  #clock = 0;
  /** The time rows are deleted by: it follows a forward jump only as the monotonic clock allows (see `#time`). */
  #trusted = 0;
  #saved = 0;
  /** Set while the latest reading is further ahead than the monotonic clock allows and has not yet held steady. */
  #unconfirmed = false;
  readonly #monotonic: () => number;
  #mono0: number;
  #base: number;
  #candidate: { offset: number; since: number; fromRow: number } | undefined;

  private constructor(db: DatabaseSync, o: IdempotencyStoreOptions) {
    this.#db = db;
    this.#audit = o.audit;
    this.#redactor = o.redactor;
    this.#now = o.now ?? Date.now;
    this.#ttlMs = positive(o.ttlMs ?? DAY_MS, "ttlMs", MAX_TTL_MS);
    this.#interruptedTtlMs = positive(o.interruptedTtlMs ?? Math.max(INTERRUPTED_TTL_MS, this.#ttlMs), "interruptedTtlMs", MAX_TTL_MS);
    this.#maxEntries = positive(o.maxEntries ?? 10_000, "maxEntries");
    this.#maxPerActor = positive(o.maxPerActor ?? 1_000, "maxPerActor");
    this.#maxPending = positive(o.maxPendingPerActor ?? Math.max(1, Math.floor(this.#maxEntries / 20)), "maxPendingPerActor");
    this.#maxPendingWorkspace = positive(o.maxPendingPerWorkspace ?? Math.max(1, Math.floor(this.#maxPending / 2)), "maxPendingPerWorkspace");
    this.#maxResultBytes = Math.min(positive(o.maxResultBytes ?? 64 * 1024, "maxResultBytes"), 1_000_000);
    this.#maxTotalBytes = positive(o.maxTotalBytes ?? 32 * 1024 * 1024, "maxTotalBytes");
    this.#maxShareBytes = positive(o.maxShareBytes ?? Math.max(1, Math.floor(this.#maxTotalBytes / 8)), "maxShareBytes");
    this.#sweepEveryMs = positive(o.sweepEveryMs ?? 60_000, "sweepEveryMs");
    this.#boot = (o.bootId ?? randomUUID)();
    // The clock starts from the saved trusted time (not from row timestamps, which may carry a wrong reading) and
    // may then move only as fast as the monotonic clock does (see `#time`).
    this.#monotonic = o.monotonic ?? ((): number => performance.now());
    this.#mono0 = this.#monotonic();
    const saved = db.prepare("SELECT trusted_ms AS t FROM daemon_idempotency_clock WHERE id = 1").get() as { t: number | bigint } | undefined;
    this.#base = saved ? Number(saved.t) : this.#reading();
    this.#clock = this.#trusted = this.#base;
    this.#lastSweep = this.#trusted;
    this.#save();
  }

  /** Persist the trusted time (rate limited by the caller). It only ever holds a time the monotonic gate has accepted. */
  #save(): void {
    this.#db
      .prepare("INSERT INTO daemon_idempotency_clock (id, trusted_ms) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET trusted_ms = excluded.trusted_ms")
      .run(this.#trusted);
    this.#saved = this.#trusted;
  }

  /** The newest row at the moment a suspect offset first appears: rows added after it were made at the suspect time. */
  #maxRow(): number {
    return Number((this.#db.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM daemon_idempotency").get() as { n: number | bigint }).n);
  }

  #reading(): number {
    const raw = this.#now();
    if (!Number.isSafeInteger(raw) || raw < 0) throw new AxisError("E_INTERNAL", "The idempotency clock must return integer epoch milliseconds");
    return raw;
  }

  /**
   * Integer epoch ms that never goes backwards by jitter, and sets `#trusted`: the one time rows are created at,
   * expire at and are deleted by (so an expiry is never further than the longest TTL past it).
   *
   * The wall clock must survive a restart, but it can be wrong. `implied` is where it should read if it only ran
   * forward with uptime from the saved trusted time. A reading within an hour of it, either side, is trusted. A
   * reading further off (a wrong clock at boot, a spike, a restored snapshot) is not: trusted time advances at the
   * monotonic rate until that offset has held steady for `CONFIRM_MS` of monotonic time, then it is accepted. So a
   * clock that is wrong for minutes shortens or frees no key, however many calls are made meanwhile. When a forward
   * offset is accepted, the rows made during the wait are moved forward by it (a real long downtime must not
   * shorten them). A clock that is wrong for more than an hour is accepted as it is: see docs/packages.md.
   * Small steps back are ignored.
   */
  #time(): number {
    const raw = this.#reading();
    const mono = this.#monotonic();
    const prev = this.#clock;
    const t = raw < prev - HOUR_MS ? raw : Math.max(prev, raw);
    const implied = Math.floor(this.#base + (mono - this.#mono0)); // whole milliseconds: the columns are integers
    if (Math.abs(t - implied) <= HOUR_MS) {
      this.#unconfirmed = false;
      this.#candidate = undefined;
      this.#trusted = Math.max(this.#trusted, t);
    } else {
      const offset = t - mono;
      if (this.#candidate === undefined || Math.abs(offset - this.#candidate.offset) > JITTER_MS) {
        this.#candidate = { offset, since: mono, fromRow: this.#maxRow() };
      }
      if (mono - this.#candidate.since >= CONFIRM_MS) {
        const delta = t - implied;
        if (delta > 0) {
          this.#db
            .prepare("UPDATE daemon_idempotency SET created_at = created_at + ?, expires_at = expires_at + ? WHERE rowid > ?")
            .run(delta, delta, this.#candidate.fromRow);
        }
        this.#base = t;
        this.#mono0 = mono;
        this.#trusted = t;
        this.#unconfirmed = false;
        this.#candidate = undefined;
        this.#save();
      } else {
        this.#unconfirmed = true;
        this.#trusted = Math.max(this.#trusted, implied);
      }
    }
    this.#clock = t;
    if (this.#trusted - this.#saved >= this.#sweepEveryMs) this.#save();
    return this.#trusted;
  }

  /** Migrate the journal schema (idempotent) and return a store. Call `recover(lock)` on daemon start. */
  static open(db: DatabaseSync, options: IdempotencyStoreOptions): JournalIdempotencyStore {
    if (!(options.audit instanceof AuditLog) || !options.audit.isBoundTo(db)) {
      throw new AxisError("E_INTERNAL", "The audit log must use the same database handle as the idempotency store");
    }
    runMigrations(db, "journal", JOURNAL_MIGRATIONS);
    return new JournalIdempotencyStore(db, options);
  }

  get size(): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM daemon_idempotency").get() as { n: number | bigint }).n);
  }

  begin(key: StoreKey, payloadHash: string): StoreBegin {
    const k = parts(key);
    if (typeof payloadHash !== "string" || payloadHash.length === 0 || payloadHash.length > 128) {
      throw new AxisError("E_INVALID_ARGUMENT", "A request hash must be 1 to 128 characters");
    }
    return withTransaction(this.#db, (): StoreBegin => {
      const x = this.#time();
      this.#sweep(x);
      let row = this.#db.prepare(`SELECT * FROM daemon_idempotency WHERE ${WHERE}`).get(...k) as unknown as Row | undefined;
      if (row && row.state !== "in-progress" && row.expires_at <= this.#trusted) {
        this.#db.prepare(`DELETE FROM daemon_idempotency WHERE ${WHERE}`).run(...k);
        row = undefined;
      }
      if (row?.state === "in-progress" && row.boot_id !== this.#boot) {
        // The process that began this call is gone. The side effect may or may not have happened.
        this.#db
          .prepare(`UPDATE daemon_idempotency SET state = 'unknown', unknown_reason = 'interrupted', expires_at = ? WHERE ${WHERE}`)
          .run(x + this.#interruptedTtlMs, ...k);
        row = { ...row, state: "unknown", unknown_reason: "interrupted" };
      }
      if (row) {
        if (row.request_hash !== payloadHash) return { state: "conflict" };
        if (row.state === "in-progress") return { state: "in-progress" };
        if (row.state === "unknown") return { state: "unknown", reason: row.unknown_reason ?? "interrupted" };
        return { state: "replay", result: JSON.parse(row.result ?? "null") as StoredJson, origin: row.origin };
      }
      if (this.#pendingExceeded(k[0], k[1])) return { state: "exhausted" };
      if (this.#count("WHERE actor_id = ? AND workspace_id = ?", k[0], k[1]) >= this.#maxPerActor && !this.#evictOldest(k[0], k[1])) {
        return { state: "exhausted" };
      }
      if (this.#count("") >= this.#maxEntries && !this.#evictOldest(undefined, undefined, "rows")) return { state: "exhausted" };
      this.#db
        .prepare(
          "INSERT INTO daemon_idempotency (actor_id, workspace_id, contract, version, method, key, request_hash, state, boot_id, created_at, expires_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, 'in-progress', ?, ?, ?)",
        )
        .run(...k, payloadHash, this.#boot, x, x + this.#ttlMs);
      return { state: "new" };
    });
  }

  /** The handler succeeded: keep its (redacted-unchanged, bounded) result for replay. Durable before it returns. */
  complete(key: StoreKey, result: JsonValue, origin: string): void {
    const k = parts(key);
    const id = JSON.stringify(k);
    try {
      if (this.#db.isTransaction) throw new AxisError("E_INTERNAL", "complete must not run inside an outer transaction");
      withTransaction(this.#db, () => {
        const x = this.#time();
        const stored = this.#storable(result);
        const fits = stored.text !== undefined && this.#makeRoom(k[0], k[1], stored.bytes);
        const res = fits
          ? this.#db
              .prepare(
                `UPDATE daemon_idempotency SET state = 'completed', result = ?, result_bytes = ?, origin = ?, expires_at = ? WHERE ${WHERE} AND state = 'in-progress' AND boot_id = ?`,
              )
              .run(stored.text ?? "", stored.bytes, origin.slice(0, 256), x + this.#ttlMs, ...k, this.#boot)
          : this.#db
              .prepare(
                `UPDATE daemon_idempotency SET state = 'unknown', unknown_reason = 'result-not-stored', origin = ?, expires_at = ? WHERE ${WHERE} AND state = 'in-progress' AND boot_id = ?`,
              )
              .run(origin.slice(0, 256), x + this.#ttlMs, ...k, this.#boot);
        if (Number(res.changes) !== 1) throw new AxisError("E_INTERNAL", "The idempotency key is not in progress");
      });
    } catch (error) {
      this.#poisoned.add(id);
      throw error;
    }
  }

  /** The call failed or was cancelled: free the key, unless its success could not be recorded (then it stays `unknown`). */
  abandon(key: StoreKey): void {
    const k = parts(key);
    const id = JSON.stringify(k);
    withTransaction(this.#db, () => {
      if (this.#poisoned.delete(id)) {
        this.#toUnknown(k);
        return;
      }
      this.#db.prepare(`DELETE FROM daemon_idempotency WHERE ${WHERE} AND state = 'in-progress' AND boot_id = ?`).run(...k, this.#boot);
    });
  }

  /**
   * The handler ran and returned, but the call still ended in an error (the approval gate or the response check
   * failed afterwards). The side effect happened: keep the key `unknown` instead of freeing it.
   */
  markUnknown(key: StoreKey): void {
    const k = parts(key);
    withTransaction(this.#db, () => this.#toUnknown(k));
  }

  /** The handler started and the call did not record a success: the cause is `failed-after-start`, kept like `interrupted`. */
  #toUnknown(k: ReturnType<typeof parts>): void {
    this.#db
      .prepare(
        `UPDATE daemon_idempotency SET state = 'unknown', unknown_reason = 'failed-after-start', expires_at = ? WHERE ${WHERE} AND state = 'in-progress' AND boot_id = ?`,
      )
      .run(this.#time() + this.#interruptedTtlMs, ...k, this.#boot);
  }

  /**
   * On daemon start, with the held instance lock: every call an earlier boot left in progress becomes `unknown`
   * (one transaction, one audit event). Converges: a second call changes nothing and writes nothing.
   */
  recover(lock: InstanceLock): { readonly interrupted: number } {
    if (!InstanceLock.is(lock)) {
      throw new AxisError("E_INVALID_ARGUMENT", "Recovery requires an instance lock from acquireInstanceLock");
    }
    if (!lock.held) throw new AxisError("E_CONFLICT", "Recovery requires the held single-instance lock");
    if (!lock.guards(this.#db)) {
      throw new AxisError("E_INVALID_ARGUMENT", "The instance lock does not guard this database's directory");
    }
    return withTransaction(this.#db, () => {
      const x = this.#time();
      this.#sweep(x, true);
      const res = this.#db
        .prepare(
          "UPDATE daemon_idempotency SET state = 'unknown', unknown_reason = 'interrupted', expires_at = ? WHERE state = 'in-progress' AND boot_id <> ?",
        )
        .run(x + this.#interruptedTtlMs, this.#boot);
      const interrupted = Number(res.changes);
      if (interrupted > 0) {
        this.#audit.append({
          actor: "daemon",
          action: AuditActions.journalRecovery,
          target: "idempotency:recovery",
          outcome: "success",
          payload: { from: "in-progress", to: "unknown", reason: RESTART_REASON, kind: "idempotency", count: interrupted },
        });
      }
      return { interrupted };
    });
  }

  /** The text to store, or undefined when it must not be (not plain JSON, changed by redaction, or too big). */
  #storable(result: JsonValue): { text: string | undefined; bytes: number } {
    try {
      const canonical = canonicalize(result);
      if (canonicalize(this.#redactor.redactValue(result)) !== canonical) return { text: undefined, bytes: 0 };
      const bytes = Buffer.byteLength(canonical, "utf8");
      // The text that was checked is the text that is stored (a getter cannot change it between the two).
      return bytes > this.#maxResultBytes ? { text: undefined, bytes } : { text: canonical, bytes };
    } catch {
      return { text: undefined, bytes: 0 };
    }
  }

  /**
   * Free result bytes for one more result: first within this caller's share (its own oldest completed rows),
   * then overall (the heaviest holder's). False if completed rows cannot make enough room.
   */
  #makeRoom(actorId: string, workspaceId: string, bytes: number): boolean {
    if (bytes > this.#maxShareBytes || bytes > this.#maxTotalBytes) return false;
    const sum = (where: string, ...args: string[]): number =>
      Number((this.#db.prepare(`SELECT COALESCE(SUM(result_bytes), 0) AS n FROM daemon_idempotency ${where}`).get(...args) as { n: number | bigint }).n);
    while (sum("WHERE actor_id = ? AND workspace_id = ?", actorId, workspaceId) + bytes > this.#maxShareBytes) {
      if (!this.#evictOldest(actorId, workspaceId)) return false;
    }
    while (sum("") + bytes > this.#maxTotalBytes) {
      if (!this.#evictOldest(undefined, undefined, "bytes")) return false;
    }
    return true;
  }

  /**
   * `in-progress` and `unknown` rows cannot be evicted, so a caller (a client that cancels its writes, or keeps
   * timing out) could fill the table with them. Each actor gets a cap across its workspaces and one per workspace;
   * over either, that actor alone is refused. Overall, once unevictable rows reach half the table, an actor
   * holding at least `PENDING_FLOOR` of them is refused; one below it still can, so a legitimate caller keeps a floor.
   */
  #pendingExceeded(actorId: string, workspaceId: string): boolean {
    const pending = "state <> 'completed'";
    const mine = this.#count(`WHERE actor_id = ? AND ${pending}`, actorId);
    if (mine >= this.#maxPending) return true;
    if (this.#count(`WHERE actor_id = ? AND workspace_id = ? AND ${pending}`, actorId, workspaceId) >= this.#maxPendingWorkspace) return true;
    // Over the floor, an actor stops once such rows are half the table; below it an actor always may begin.
    return mine >= Math.min(PENDING_FLOOR, this.#maxPending) && this.#count(`WHERE ${pending}`) >= Math.max(1, Math.floor(this.#maxEntries / 2));
  }

  #count(where: string, ...args: string[]): number {
    const row = this.#db.prepare(`SELECT COUNT(*) AS n FROM daemon_idempotency ${where}`).get(...args) as { n: number | bigint };
    return Number(row.n);
  }

  /**
   * Drop one `completed` row, the oldest of the given caller, or (no caller) of the caller holding the most
   * completed rows (`rows`, for the row limit) or result bytes (`bytes`, for the byte limit). Never `unknown`
   * or `in-progress`. False if there was none to drop.
   */
  #evictOldest(actorId?: string, workspaceId?: string, by: "rows" | "bytes" = "rows"): boolean {
    let a = actorId;
    if (a === undefined) {
      // The holder is the actor across all its workspaces, so spreading rows over workspaces does not hide it.
      const heavy = this.#db
        .prepare(
          "SELECT actor_id FROM daemon_idempotency WHERE state = 'completed' " +
            `GROUP BY actor_id ORDER BY ${by === "rows" ? "COUNT(*)" : "SUM(result_bytes)"} DESC, MIN(created_at) LIMIT 1`,
        )
        .get() as { actor_id: string } | undefined;
      if (!heavy) return false;
      a = heavy.actor_id;
    }
    const inWorkspace = workspaceId === undefined ? "" : "AND workspace_id = ? ";
    const res = this.#db
      .prepare(
        "DELETE FROM daemon_idempotency WHERE rowid = (SELECT rowid FROM daemon_idempotency " +
          `WHERE actor_id = ? ${inWorkspace}AND state = 'completed' ORDER BY created_at, rowid LIMIT 1)`,
      )
      .run(...(workspaceId === undefined ? [a] : [a, workspaceId]));
    return Number(res.changes) === 1;
  }

  /** `t` is the trusted time (see `#time`): rows expire by it, never by a reading that has not been confirmed. */
  #sweep(t: number, force = false): void {
    if (!force && t >= this.#lastSweep && t - this.#lastSweep < this.#sweepEveryMs) return; // a clock step back sweeps at once
    this.#lastSweep = t;
    this.#db.prepare("DELETE FROM daemon_idempotency WHERE state <> 'in-progress' AND expires_at <= ?").run(t);
    if (this.#unconfirmed) return;
    // An expiry further ahead than the longest TTL allows came from a bad clock reading: bring it back.
    const latest = t + Math.max(this.#ttlMs, this.#interruptedTtlMs);
    this.#db.prepare("UPDATE daemon_idempotency SET expires_at = ? WHERE state <> 'in-progress' AND expires_at > ?").run(latest, latest);
  }
}
