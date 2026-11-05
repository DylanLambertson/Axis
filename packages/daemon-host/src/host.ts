// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AuditLog, AxisError, type ChainHead, type DatabaseSync, type InstanceLock, type Redactor } from "@axis/audit";
import { Journal, JournalIdempotencyStore } from "@axis/journal";
import { PROTOCOL_VERSION } from "@axis/protocol";
import type { HostConfig } from "./config.js";
import type { ControlClient } from "./control/client.js";
import { Disposables, type DisposeResult } from "./disposables.js";
import { CHALLENGE_PAYLOAD_ALLOWLIST } from "./gate/audit-sink.js";
import { REVIEW_PAYLOAD_ALLOWLIST } from "./handlers/review-audit.js";
import { ANCHOR_PAYLOAD_ALLOWLIST } from "./anchor/preflight.js";
import { DegradedStartError } from "./exit-codes.js";
import { summarizeError } from "./log/summarize-error.js";
import type { Logger } from "./log/logger.js";
import { checkCoverage, policySurface, RuleTablePolicy, InMemoryTrustRegistry, type PolicySurface } from "./policy/index.js";
import type { Clock } from "./ports/clock.js";
import type { StoragePort } from "./ports/storage.js";
import type { TrustRegistry } from "./ports/trust.js";
import type { ReconcileReport } from "./ports/worktrees.js";
import { AnchorManager, type AnchorGuard } from "./anchor/manager.js";
import { checkAnchor, type DegradedReason } from "./storage/anchor-check.js";
import { resolveGitOnce } from "./storage/git-path.js";
import { DEFAULT_RECONCILE_BUDGET_MS, runRecovery, type RecoveryOutcome } from "./storage/recovery.js";
import { createUptimeClock } from "./storage/uptime-clock.js";

/**
 * Ticket H2: storage and startup (design section 3, steps 3 to 10 and 12). `createDaemonHost(config, ports)` returns a
 * host that is started with `start()` and torn down with `stop()`. It has no Electron, no socket and no handlers: the
 * caller (the node entry, a test) supplies every OS-touching dependency, and later tickets add the handlers, the
 * anchor manager and the challenge manager on top of the `HostServices` it returns.
 */

/** The part of `ControlClient` startup uses. A real `ControlClient` over a `ChannelMux` satisfies it. */
export type HostControl = Pick<ControlClient, "send" | "anchorGet" | "anchorPut" | "onAnchorAck">;

/** Dependencies of the startup sequence. Everything that touches the operating system comes in here. */
export interface StartupPorts {
  readonly clock: Clock;
  readonly storage: StoragePort;
  readonly control: HostControl;
  /** The ONE process redactor (step 5). `parseHostConfig` already registered the host's own secrets with it. */
  readonly redactor: Redactor;
  readonly logger?: Logger;
  /** A copy of the environment, for the one git lookup. The host never reads `process.env`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The process working directory, excluded from the git lookup. Required: a forgotten one would silently drop the exclusion. */
  readonly cwd: string;
  /** Registered repository roots (design 5a); the list is read at startup and again whenever `excludeDirs()` is called. */
  readonly registeredRepoRoots?: () => readonly string[];
  /** Replace the default in-memory registry (tests). */
  readonly trust?: TrustRegistry;
  /** Compare git with the journal at startup (the worktrees port, ticket H8). Absent: skipped. */
  readonly reconcile?: (signal: AbortSignal) => Promise<ReconcileReport>;
}

export interface HostOptions {
  /** Refuse to run degraded: `start()` rejects with `DegradedStartError` (exit code 79) instead of sending `ready`. */
  readonly exitOnDegraded?: boolean;
  /** Timeout of `anchor.get` at startup (default 5000). */
  readonly anchorTimeoutMs?: number;
}

/** The reads of the journal, safe in every mode. A frozen facade of closures: no writer is reachable from it. */
export type JournalReader = Pick<Journal, "getWorkspace" | "listWorkspaces" | "getRun" | "listRuns" | "transitions">;
/** The reads of the audit log, safe in every mode (`axis.audit/1.list`, `verify`, `status`). A frozen facade too. */
export type AuditReader = Pick<AuditLog, "list" | "verify" | "head">;

function journalReader(j: Journal): JournalReader {
  return Object.freeze({
    getWorkspace: (id: string) => j.getWorkspace(id),
    listWorkspaces: (o?: Parameters<Journal["listWorkspaces"]>[0]) => j.listWorkspaces(o),
    getRun: (id: string) => j.getRun(id),
    listRuns: (o?: Parameters<Journal["listRuns"]>[0]) => j.listRuns(o),
    transitions: (e: "workspace" | "run", id: string) => j.transitions(e, id),
  });
}

function auditReader(a: AuditLog): AuditReader {
  return Object.freeze({
    list: (o?: Parameters<AuditLog["list"]>[0]) => a.list(o),
    verify: (o?: Parameters<AuditLog["verify"]>[0]) => a.verify(o),
    head: () => a.head(),
  });
}

/**
 * What startup built. Present on the object `start()` returns; later tickets build their handlers from it. It is for
 * the composition root only: handlers receive narrowed ports, never `HostServices` (`unsafe` in particular).
 *
 * Degraded mode is enforced here, not only advertised: `journal`, `audit`, `idempotency` and `unsafe` are `undefined`
 * (nothing can write), `policy` is built from the audit read methods and `axis.projects/1.list` only, and `served`
 * lists only those contracts.
 */
export interface HostServices {
  readonly journalRead: JournalReader;
  readonly auditRead: AuditReader;
  /** The writable journal. `undefined` when degraded. */
  readonly journal: Journal | undefined;
  /** The writable audit log. `undefined` when degraded. */
  readonly audit: AuditLog | undefined;
  /** `undefined` when degraded: nothing that writes runs, so the store is not opened and no key is touched. */
  readonly idempotency: JournalIdempotencyStore | undefined;
  /** The raw handle and lock (for `withTransaction` and shutdown). `undefined` when degraded. Never pass it to a handler. */
  readonly unsafe: { readonly db: DatabaseSync; readonly lock: InstanceLock } | undefined;
  readonly redactor: Redactor;
  readonly trust: TrustRegistry;
  readonly policy: RuleTablePolicy;
  readonly surface: PolicySurface;
  /** The one absolute git path (step 5a): pass it to `@axis/git-ops` and `@axis/worktrees`, never look again. */
  readonly gitPath: string;
  /** The directories git must never be taken from: the worktree root, the data directory, the cwd, registered repositories. */
  readonly excludeDirs: () => readonly string[];
  readonly degraded: DegradedReason | undefined;
  /** Contract ids the host serves now: all of `surface`, or only the audit and projects contracts when degraded. */
  readonly served: readonly string[];
  readonly recovery: RecoveryOutcome | undefined;
  /** Stall check, status and write notification for handlers and the audit sink. No put, no ack, no timer. */
  readonly anchors: AnchorGuard;
  /** The anchor the supervisor held at startup, the newest head this process put, and the highest acknowledged sequence. */
  readonly anchor: () => { readonly atStart: ChainHead | null; readonly put: ChainHead | null; readonly ackedSeq: number };
}

export interface DaemonHost {
  readonly state: "new" | "starting" | "ready" | "stopped";
  /** Run the startup sequence. Rejects with the typed startup error (see `exitCodeForStartupError`); nothing is left held. */
  start(): Promise<HostServices>;
  /** Dispose everything in reverse order: timers, listeners, the database handle, then the lock. Idempotent. */
  stop(): Promise<DisposeResult>;
}

/** Methods served in degraded mode (design 5.5): the audit read methods and `axis.projects/1.list`. */
const DEGRADED_METHODS: ReadonlySet<string> = new Set(["axis.audit/1.status", "axis.audit/1.list", "axis.audit/1.verify", "axis.projects/1.list"]);

/** The surface restricted to the degraded methods, so the policy denies everything else and coverage is checked on what is served. */
function degradedSurface(full: PolicySurface): PolicySurface {
  const keep = <T,>(o: Readonly<Record<string, T>>): Readonly<Record<string, T>> =>
    Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => DEGRADED_METHODS.has(k))));
  const registry: Record<string, Record<string, { readonly tier: number }>> = {};
  for (const [contract, methods] of Object.entries(full.registry)) {
    const picked = Object.fromEntries(Object.entries(methods).filter(([m]) => DEGRADED_METHODS.has(`${contract}.${m}`)));
    if (Object.keys(picked).length > 0) registry[contract] = picked;
  }
  return { registry, rules: keep(full.rules), planned: keep(full.planned) };
}

const STEP_ERRORS: ReadonlySet<string> = new Set(["E_CONFLICT", "E_INVALID_ARGUMENT", "E_POLICY_DENIED"]);
const UPTIME_TICK_MS = 60_000;

export function createDaemonHost(config: HostConfig, ports: StartupPorts, options: HostOptions = {}): DaemonHost {
  const disposables = new Disposables();
  let state: DaemonHost["state"] = "new";
  let started: Promise<HostServices> | undefined;
  let stopping = false;
  /** Aborted by `stop()`: cancels the waits of a start in progress (`anchor.get`, reconcile) instead of waiting them out. */
  const startup = new AbortController();
  /** Checked after every await: a `stop()` during `start()` ends the start before it can send `ready`. */
  const alive = (): void => {
    if (stopping) throw new AxisError("E_CANCELLED", "The host was stopped while starting", { reason: "stopping" });
  };

  const run = async (): Promise<HostServices> => {
    alive();
    ports.logger?.info("host.starting");
    // Step 3: directory and instance lock. Released after the database handle is closed (reverse order).
    const dir = await ports.storage.acquire(config.dataDir);
    disposables.add(() => dir.release(), "storage.lock");
    alive();
    // From here on a `E_CONFLICT`, `E_INVALID_ARGUMENT` or `E_POLICY_DENIED` is NOT a second daemon or a bad
    // directory (exit 75 and 78 belong to step 3): it is an internal failure of a later step (exit 70).
    try {
      return await afterLock(dir);
    } catch (error) {
      if (error instanceof AxisError && STEP_ERRORS.has(error.code) && !(error instanceof DegradedStartError)) {
        // Keep what the operator needs: the original closed code and reason, in the log and in the details.
        const original = summarizeError(error);
        ports.logger?.error("host.start_failed", { error });
        const reason = typeof error.detail["reason"] === "string" ? error.detail["reason"] : "none";
        throw new AxisError("E_INTERNAL", "Startup failed after the data directory was locked", {
          reason: "startup_step",
          cause: original.code ?? "unknown",
          causeReason: reason.slice(0, 64),
        });
      }
      throw error;
    }
  };

  const afterLock = async (dir: Awaited<ReturnType<StoragePort["acquire"]>>): Promise<HostServices> => {
    // Step 4: one database handle for the journal, the audit log and the idempotency store.
    const db = dir.openDatabase();
    disposables.add(() => db.close(), "storage.database");
    if (!dir.lock.guards(db)) throw new AxisError("E_INTERNAL", "The instance lock does not guard this database", { reason: "lock_database" });
    // Step 5 and 5a: the redactor is given; resolve git once.
    const excludeDirs = (): readonly string[] => [config.worktreeRoot, config.dataDir, ports.cwd, ...(ports.registeredRepoRoots?.() ?? [])];
    const gitPath = resolveGitOnce({ env: ports.env, platform: config.platform, excludeDirs: excludeDirs() });
    // Step 6: audit log and the anchor check (reads only).
    const audit = new AuditLog(db, {
      redactor: ports.redactor,
      now: () => new Date(ports.clock.now()),
      // The challenge rows keep their `method`; the anchor rows keep their one fixed field (a literal, never caller text); the review acknowledgement keeps its file id.
      payloadAllowlist: { ...CHALLENGE_PAYLOAD_ALLOWLIST, ...ANCHOR_PAYLOAD_ALLOWLIST, ...REVIEW_PAYLOAD_ALLOWLIST },
    });
    const check = await checkAnchor(audit, () => ports.control.anchorGet({ timeoutMs: options.anchorTimeoutMs ?? 5_000, signal: startup.signal }));
    alive();
    const degraded = check.degraded;
    if (degraded !== undefined) {
      ports.logger?.warn("host.degraded", { reason: degraded });
      if (options.exitOnDegraded === true) throw new DegradedStartError(degraded);
    }
    // Step 7: the journal (schema migration only; recovery writes, so it waits for a sound chain).
    const journal = Journal.open(db, { audit, now: () => new Date(ports.clock.now()) });
    let idempotency: JournalIdempotencyStore | undefined;
    let recovery: RecoveryOutcome | undefined;
    const anchors = new AnchorManager({
      clock: ports.clock,
      audit: degraded === undefined ? audit : { head: () => audit.head() },
      put: (h) => ports.control.anchorPut(h),
      baseline: check.anchor,
      writable: degraded === undefined,
      disposables,
      ...(config.limits.anchorMaxLagEvents === undefined ? {} : { maxLagEvents: config.limits.anchorMaxLagEvents }),
      ...(config.limits.anchorMaxAgeMs === undefined ? {} : { maxAgeMs: config.limits.anchorMaxAgeMs }),
      onTransition: (stalled) => void (stalled ? ports.logger?.warn("anchor.stalled") : ports.logger?.info("anchor.resumed")),
    });
    if (degraded === undefined) {
      disposables.add(ports.control.onAnchorAck((seq) => void anchors.ack(seq)), "anchor.ack");
      // Step 8: the durable store, on the uptime clock (never the wall clock, jumps bounded).
      const uptime = createUptimeClock(ports.clock);
      disposables.setInterval(() => void uptime.read(), UPTIME_TICK_MS, "uptime.tick");
      idempotency = JournalIdempotencyStore.open(db, { audit, redactor: ports.redactor, monotonic: () => uptime.read() });
      // Step 9: recovery, then anchor what recovery wrote.
      recovery = await runRecovery({
        lock: dir.lock,
        journal,
        idempotency,
        audit,
        reconcile: ports.reconcile,
        reconcileBudgetMs: config.limits.reconcileBudgetMs ?? DEFAULT_RECONCILE_BUDGET_MS,
        signal: startup.signal,
      });
      alive();
      // Anchor what recovery wrote (and the verified head, when the supervisor holds an older or no anchor).
      anchors.flush();
    }
    // Step 10: policy over the one surface (only the degraded methods when degraded), then the coverage check (a
    // mismatch throws: exit 70, no ready).
    const full = policySurface(config.contracts);
    const surface = degraded === undefined ? full : degradedSurface(full);
    const trust = ports.trust ?? new InMemoryTrustRegistry();
    const policy = new RuleTablePolicy(trust, surface.rules);
    checkCoverage(surface);
    const served = [...new Set(Object.keys(surface.registry).map((k) => k.slice(0, k.indexOf("/"))))];
    alive();
    // Step 12: ready. Signals (step 11) are installed by the caller with `installHostLifecycle` (H7).
    ports.control.send({ type: "ready", protocolVersion: PROTOCOL_VERSION, contracts: served, ...(degraded === undefined ? {} : { degraded }) });
    ports.logger?.info("host.ready");
    return Object.freeze({
      journalRead: journalReader(journal),
      auditRead: auditReader(audit),
      journal: degraded === undefined ? journal : undefined,
      audit: degraded === undefined ? audit : undefined,
      idempotency,
      unsafe: degraded === undefined ? Object.freeze({ db, lock: dir.lock }) : undefined,
      redactor: ports.redactor,
      trust,
      policy,
      surface,
      gitPath,
      excludeDirs,
      degraded,
      served,
      recovery,
      anchors: Object.freeze({ check: (t: number) => anchors.check(t), status: () => anchors.status(), noteWrite: () => anchors.noteWrite() }),
      anchor: () => Object.freeze({ atStart: check.anchor, put: anchors.put, ackedSeq: anchors.ackedSeq }),
    });
  };

  return {
    get state() {
      return state;
    },
    start(): Promise<HostServices> {
      if (stopping) return Promise.reject(new AxisError("E_CANCELLED", "The host was stopped", { reason: "stopping" }));
      if (started !== undefined) return Promise.reject(new AxisError("E_INTERNAL", "The host was already started"));
      state = "starting";
      started = run().then(
        (services) => {
          if (state === "starting") state = "ready";
          return services;
        },
        async (error: unknown) => {
          // Nothing stays held after a failed start: no lock, no handle, no timer, no listener.
          await disposables.dispose();
          state = "stopped";
          throw error;
        },
      );
      return started;
    },
    async stop(): Promise<DisposeResult> {
      stopping = true;
      startup.abort();
      state = "stopped";
      if (started !== undefined) await started.catch(() => undefined);
      return disposables.dispose();
    },
  };
}
