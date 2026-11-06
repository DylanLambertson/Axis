// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { mkdirSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { AxisError, withTransaction, type InstanceLock } from "@axis/audit";
import { Daemon, EventHub, MemoryIdempotencyStore, protocolRegistry, type ContractRegistry, type ElectronPortLike, type ShutdownOptions } from "@axis/daemon";
import type { GitRunner } from "@axis/git-ops";
import type { MockProviderOptions, RunBudgetLimits } from "@axis/providers";
import { EVENTS_CONTRACT, EVENTS_VERSION, PROJECTS_CONTRACT, PROJECTS_VERSION, PROVIDERS_CONTRACT, PROVIDERS_VERSION, APPROVALS_CONTRACT, APPROVALS_VERSION, REVIEW_CONTRACT, REVIEW_VERSION, WORKTREES_CONTRACT, WORKTREES_VERSION, lookupMethod } from "@axis/protocol";
import { createSecretScanner, type ScanMode } from "@axis/secret-scan";
import { anchorPreflight } from "./anchor/preflight.js";
import { createAgentBinding, type AgentBinding } from "./bindings/agent.js";
import { createGitOperations, createGitPort } from "./bindings/git.js";
import { createCommitPreparer, createReviewService } from "./bindings/review.js";
import { createTempIndexProvider } from "./bindings/review-tempindex.js";
import { createRunsBinding, type RunsBinding } from "./bindings/runs.js";
import type { RunSnapshotterFactory } from "./bindings/snapshot.js";
import { createWorktreesBinding, type WorktreesBinding } from "./bindings/worktrees.js";
import { createActiveRunForwarder, createAuditSeal, createRunsClock, settleComposer, daemonAuditSink, handleProjectsRegister, recordingRegistrar } from "./compose-parts.js";
import type { HostConfig } from "./config.js";
import { createAttestationVerifier } from "./control/attestation.js";
import type { ControlClient } from "./control/client.js";
import { createConnectLimiter } from "./control/connect-limiter.js";
import { createConnectRouter } from "./control/connect-router.js";
import type { DisposeResult, ListenerTarget } from "./disposables.js";
import { createEventSources } from "./events/sources.js";
import { createChallengeAuditSink } from "./gate/audit-sink.js";
import { createRunTrustMinter } from "./gate/run-trust.js";
import { createWorktreesApprovals, type WorktreesApprovals } from "./gate/worktrees-confirm.js";
import { createComposerService, type ComposerService } from "./composer/service.js";
import type { ToolCaps } from "./composer/loop.js";
import { createApprovalsHandlers } from "./handlers/approvals.js";
import { createHandlerRegistrar, registerAuditHandlers, type HandlerRegistrar } from "./handlers/anchor-guard.js";
import { registerCliRunsHandlers } from "./handlers/cli-runs.js";
import { registerComposerRunsHandlers } from "./handlers/composer-runs.js";
import { PushedBases } from "./handlers/git-common.js";
import { createSshResolver, unavailableSshResolver, type SshSpawn } from "./bindings/ssh-resolver.js";
import { loadPushedBases, savePushedBases } from "./storage/pushed-bases-file.js";
import { registerGitHandlers } from "./handlers/git.js";
import { createProjectsHandlers } from "./handlers/projects.js";
import { createProvidersHandlers } from "./handlers/providers.js";
import { createReviewHandlers } from "./handlers/review.js";
import { createReviewAuditSink } from "./handlers/review-audit.js";
import { ReviewedTrees } from "./handlers/review-store.js";
import { createWorktreesHandlers } from "./handlers/worktrees.js";
import { createDaemonHost, type DaemonHost, type HostOptions, type HostServices, type StartupPorts } from "./host.js";
import { installHostLifecycle, type LifecycleHandle, type LifecycleOptions } from "./lifecycle.js";
import type { Logger } from "./log/logger.js";
import { checkCoverage } from "./policy/coverage.js";
import type { PtyPort } from "./ports/pty.js";
import type { ChannelMux } from "./transport/mux.js";

/**
 * The composition root (ticket H12, design section 3 steps 10 and 11, plan section 1 and questions 18 and 19). It is the one
 * place that builds the `Daemon` and every binding, and it hands handler code ONLY the `HandlerRegistrar` (never the
 * `Daemon`, the raw `register`, the database or the discard minter; the run trust minter goes to the cli-runs handlers alone, TRU-2).
 *
 * What it guarantees, and what fails closed:
 * - It REFUSES TO BE BUILT without a pty port and a pty git runner (`pty_required`, exit 78, before a lock or a file exists):
 *   `commit-tree` and `push` run in the `pty` git context and the runs binding spawns in it, so a host that could not reach
 *   it would serve `axis.git/1` and `axis.cli-runs/1` and fail on first use. A missing snapshotter factory is refused too
 *   (`snapshotter_required`): it is called once after storage with the host's one `gitPath`, and a result without `before` and
 *   `after` fails startup before `ready` (ticket H13, docs/design/git-snapshot.md section 8).
 * - ONE `ProjectMutex` (the one of the worktrees binding) reaches the worktrees, git and runs handlers. The worktrees binding is
 *   built first with a forwarder that answers `true` ("a run may be active", never `false`) until the runs binding is bound.
 * - `createApprovals` gets `anchorPreflight(services.anchors)` as `preflight`, so a stalled anchor refuses tier 3 and above
 *   before a challenge or a dialog. The registrar guards every tier 3 method structurally as well.
 * - The startup reconcile is the worktrees service's: every workspace is `needs attention` until it has completed.
 * - Every served method has a handler and every handler is a served method (`checkCoverage` `also: handlers`), or startup fails.
 * - A degraded host (design 5.5) registers only the audit reads and `axis.projects/1.list`, over a registry that holds nothing else.
 * - `installHostLifecycle` runs before `ready`; the final anchor is flushed and awaited (bounded) once nothing can still write; an unacknowledged one exits 1.
 */
export interface ComposeOptions {
  readonly config: HostConfig;
  readonly control: ControlClient;
  /** The mux the control client speaks over (child process and web hosts); a connect that names a `cid` needs it. */
  readonly mux?: ChannelMux;
  /**
   * Where a `connect` that carries a transferred port arrives (Electron: `adaptParentPort(...).onPort`). Each message goes to the
   * connect router (limiter first, then `daemon.accept`); the listener is removed when the connect listener goes, at shutdown step 3.
   */
  readonly portSource?: { onPort(handler: (data: unknown, port: ElectronPortLike) => void): () => void };
  readonly ports: Omit<StartupPorts, "control" | "reconcile" | "afterStorage" | "beforeReady">;
  readonly host?: HostOptions;
  /** The Axis pty process: spawns CLI runs. REQUIRED. */
  readonly pty: PtyPort | undefined;
  /** The `pty` git context runner (commit-tree and push run where the credentials and signing are). REQUIRED. */
  readonly ptyGitRunner: GitRunner | undefined;
  /** GIT-SNAP-1 around a run: production passes `gitSnapshotRunSnapshotter` (`@axis/git-snapshot`, question 10). REQUIRED. */
  readonly snapshotter: RunSnapshotterFactory | undefined;
  /**
   * Starts the `ssh -G` of the push destination resolver (H9-base-ssh): `shell: false`, stdin closed, exactly the given `env`. This
   * package starts no process itself (staging allowlist), so the embedder supplies it. Absent, a push over ssh refuses its scan
   * base (`E_INVALID_ARGUMENT`) instead of keying the host as written; path remotes are unaffected.
   */
  readonly sshSpawn?: SshSpawn;
  /** `refuse` by default; `warn` is the user setting (question 15). */
  readonly scanMode?: ScanMode;
  /** `axis.git.runHooks` (affects push only; decision B2). Default false. */
  readonly runHooks?: boolean;
  /** Where signals and crashes are listened for: the composition caller passes the real `process`. */
  readonly process: ListenerTarget;
  readonly exit: LifecycleOptions["exit"];
  readonly shutdown?: ShutdownOptions;
  readonly finalizeTimeoutMs?: number;
  /** TEST ONLY: contract ids whose handlers are not registered. Startup must then fail the coverage check (it can only make the host refuse). */
  readonly withholdHandlers?: ReadonlySet<string>;
  /** How long the final anchor waits for its acknowledgement (default 1500). A longer wait than `finalizeTimeoutMs` only turns a slow acknowledgement into exit 1. */
  readonly finalAnchorWaitMs?: number;
  /**
   * TEST ONLY: receives the two audit writers the composition seals at the final anchor (the challenge sink and the composer
   * binding's sink), so a test can prove a write after shutdown is refused. It can only observe them, never unseal them.
   */
  readonly observeSealedWriters?: (writers: { readonly challenge: { append(e: never): unknown }; readonly composer: { append(e: never): unknown } }) => void;
  /** How long shutdown waits for composer runs to record their last rows before the audit writers are sealed (default 1000). */
  readonly composerSettleMs?: number;
  /** Composer runs (`axis.runs/1`, docs/design/composer-runtime.md): the mock provider's script and the per-run budget. */
  readonly composer?: { readonly mock?: MockProviderOptions; readonly budget?: RunBudgetLimits; readonly maxTurns?: number; readonly toolCaps?: Partial<ToolCaps> };
  /** Period of the event sources (docs/design/events.md section 4; default 250 ms). */
  readonly eventPumpMs?: number;
}

export interface ComposedHost {
  readonly host: DaemonHost;
  start(): Promise<HostServices>;
  stop(): Promise<DisposeResult>;
  /** Resolves after the lifecycle's exit hook ran (never before `start` resolved). */
  readonly finished: Promise<void>;
}

function refuse(reason: string): never {
  throw new AxisError("E_INVALID_ARGUMENT", "The host composition is incomplete", { reason });
}

const isRunner = (r: unknown): r is GitRunner => typeof (r as { run?: unknown } | null)?.run === "function";
const isPty = (p: unknown): p is PtyPort => typeof (p as { spawn?: unknown } | null)?.spawn === "function";

/** The registry restricted to what the host serves, so an unserved method does not exist (and `hello` does not offer it). */
function registryOf(surface: HostServices["surface"]): ContractRegistry {
  return {
    lookup: (contract, version, method) => (surface.registry[`${contract}/${version}`]?.[method] === undefined ? undefined : lookupMethod(contract, version, method)),
    versions: (contract) => protocolRegistry.versions(contract).filter((v) => surface.registry[`${contract}/${v}`] !== undefined),
  };
}

export function composeDaemonHost(options: ComposeOptions): ComposedHost {
  if (!isPty(options.pty)) refuse("pty_required");
  if (!isRunner(options.ptyGitRunner)) refuse("pty_git_runner_required");
  if (typeof options.snapshotter !== "function") refuse("snapshotter_required");
  const { config, control, ports } = options;
  const pty = options.pty;
  const ptyGitRunner = options.ptyGitRunner;
  const snapshotterFactory = options.snapshotter;
  const logger: Logger | undefined = ports.logger;
  const scanner = createSecretScanner({ mode: options.scanMode ?? "refuse" });
  // Closed when the final anchor is taken: no composer or challenge row may land after it (review r1 S1).
  const auditSeal = createAuditSeal();

  /** Undo, in reverse order, what composition created (everything below is idempotent). */
  const cleanups: Array<() => void> = [];
  const runCleanups = (): void => {
    for (const fn of cleanups.splice(0).reverse()) {
      try {
        fn();
      } catch {
        // one failing cleanup must not stop the others
      }
    }
  };

  // Built in `afterStorage`, used by `reconcile` and `beforeReady`.
  const built: { worktrees?: WorktreesBinding; runs?: RunsBinding; approvals?: WorktreesApprovals; projectPaths?: () => string[]; agent?: AgentBinding; composer?: ComposerService } = {};
  let lifecycle: LifecycleHandle | undefined;
  let offConnect: (() => void) | undefined;
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => void (finish = resolve));
  let stopping: Promise<DisposeResult> | undefined;

  const host: DaemonHost = createDaemonHost(
    config,
    {
      ...ports,
      control,
      // The registered repositories (design 5a): git is never taken from one of them. Known to the journal once it is open.
      registeredRepoRoots: () => [...(ports.registeredRepoRoots?.() ?? []), ...(built.projectPaths?.() ?? [])],
      reconcile: (signal) => {
        const worktrees = built.worktrees;
        if (worktrees === undefined) throw new AxisError("E_INTERNAL", "Reconcile ran before the worktrees binding", { reason: "not_built" });
        return worktrees.service.reconcile(signal);
      },
      afterStorage(parts) {
        // Built with the git the host resolved once (design 5a), before anything else of the bindings: no snapshotter, no start.
        const projectRoot = (workspaceId: string): string | undefined => {
          const ws = parts.journal.getWorkspace(workspaceId);
          return ws === undefined ? undefined : parts.journal.getProject(ws.projectId)?.path;
        };
        const snapshotter = snapshotterFactory({ gitPath: parts.gitPath, env: ports.env, projectRoot });
        if (typeof snapshotter?.before !== "function" || typeof snapshotter?.after !== "function") refuse("snapshotter_required");
        const forwarder = createActiveRunForwarder();
        // Both writers are guarded by the seal (review r1 S1); removing either guard fails compose-composer.test.ts.
        const challengeWriter = { append: (e: Parameters<typeof parts.audit.append>[0]) => (auditSeal.guard(), parts.audit.append(e), parts.anchors.noteWrite(), undefined) };
        const composerWriter = { append: (e: Parameters<typeof parts.audit.append>[0]) => { auditSeal.guard(); const row = parts.audit.append(e); parts.anchors.noteWrite(); return row; } };
        options.observeSealedWriters?.({ challenge: challengeWriter as never, composer: composerWriter as never });
        const approvals = createWorktreesApprovals({
          audit: createChallengeAuditSink(challengeWriter),
          control,
          clock: ports.clock,
          ...(logger === undefined ? {} : { logger }),
          preflight: anchorPreflight(parts.anchors),
        });
        cleanups.push(() => approvals.dispose());
        const worktrees = createWorktreesBinding({
          journal: parts.journal,
          audit: parts.audit,
          transact: (fn) => withTransaction(parts.db, fn),
          random: { bytes: (n) => randomBytes(n), uuid: () => randomUUID() },
          runs: forwarder,
          gitPath: parts.gitPath,
          env: ports.env,
          platform: config.platform,
          worktreeRoot: config.worktreeRoot,
          onPreview: approvals.onPreview,
        });
        const runs = createRunsBinding({
          journal: parts.journal,
          audit: parts.audit,
          pty,
          clock: createRunsClock(ports.clock),
          locator: worktrees.locator,
          snapshotter,
          env: () => ports.env,
          redactor: ports.redactor,
          mutex: worktrees.mutex,
          platform: config.platform,
          managedWorktreeRoots: () => [config.worktreeRoot],
          onInternalError: (where) => logger?.error("request.failed", { reason: `runs_${String(where).slice(0, 24)}` }),
        });
        cleanups.push(() => runs.dispose());
        forwarder.bind(runs.service);
        const projectPaths = (): string[] => parts.journal.listProjects().map((p) => p.path);
        // Composer runs: the broker's audit rows mark the anchor batch dirty like every other writer.
        const agent = createAgentBinding({
          locator: worktrees.locator,
          repositoryRoots: projectPaths,
          audit: composerWriter,
          redactor: ports.redactor,
          env: () => ports.env,
          approvals: approvals.runs,
          now: () => ports.clock.now(),
          platform: config.platform,
          ...(options.composer?.mock === undefined ? {} : { mock: options.composer.mock }),
        });
        const composer = createComposerService({
          journal: parts.journal,
          engine: agent,
          now: () => ports.clock.now(),
          ...(options.composer?.budget === undefined ? {} : { budget: options.composer.budget }),
          ...(options.composer?.maxTurns === undefined ? {} : { maxTurns: options.composer.maxTurns }),
          ...(options.composer?.toolCaps === undefined ? {} : { toolCaps: options.composer.toolCaps }),
          onInternalError: (where) => logger?.error("request.failed", { reason: `composer_${where.slice(0, 24)}` }),
        });
        cleanups.push(() => (composer.dispose(), agent.dispose()));
        Object.assign(built, { worktrees, runs, approvals, projectPaths, agent, composer });
      },
      async beforeReady(services, lock) {
        try {
          await assemble(services, lock);
        } catch (e) {
          lifecycle?.dispose();
          runCleanups();
          throw e;
        }
      },
    },
    options.host,
  );

  async function assemble(services: HostServices, lock: InstanceLock | undefined): Promise<void> {
    const { journal, audit } = services;
    const writable = services.degraded === undefined && journal !== undefined && audit !== undefined && services.idempotency !== undefined;
    if (writable && lock !== undefined) {
      built.runs?.recover(lock); // DMN-7 for CLI runs: QUEUED never reached a process; nothing starts before this
      built.composer?.recover(); // after Journal.recover: a QUEUED composer run never reached its loop
    }
    // Contracts: identity, policy, the daemon.
    const verifier = createAttestationVerifier({ key: config.attestationKey, clock: ports.clock });
    cleanups.push(() => verifier.close());
    // Server-pushed events (E1): only on a writable host that serves the contract (a degraded host does not).
    const events = writable && services.served.includes(EVENTS_CONTRACT) ? new EventHub({ onInternalError: () => logger?.warn("request.failed", { reason: "events_refused" }) }) : undefined;
    const daemon = new Daemon({
      identity: verifier,
      audit: daemonAuditSink(audit, () => services.anchors.noteWrite()),
      policy: services.policy,
      ...(built.approvals === undefined ? {} : { approvals: built.approvals.gate }),
      // A degraded host has no durable store: everything it serves is a read with no key, so the in-memory one is never written.
      idempotency: services.idempotency ?? new MemoryIdempotencyStore(),
      registry: registryOf(services.surface),
      onInternalError: (_correlationId, error) => logger?.error("request.failed", { reason: "daemon_internal", error }),
      ...(config.limits.maxConnections === undefined ? {} : { maxConnections: config.limits.maxConnections }),
      ...(options.shutdown === undefined ? {} : { shutdown: options.shutdown }),
      ...(events === undefined ? {} : { events }),
    });
    cleanups.push(() => daemon.stop());
    const recorded = recordingRegistrar(createHandlerRegistrar(daemon, services.anchors));
    const withheld = options.withholdHandlers;
    // Test seam: a contract listed in `withholdHandlers` is not registered, and the coverage check below must then fail startup.
    const registrar: HandlerRegistrar = withheld === undefined ? recorded.registrar : Object.freeze({ register: ((c, v, h, o) => (withheld.has(c) ? undefined : recorded.registrar.register(c, v, h, o))) as HandlerRegistrar["register"] });

    registerAuditHandlers(registrar, { audit: services.auditRead, anchors: services.anchors, degraded: () => services.degraded, clock: ports.clock });
    registrar.register(PROJECTS_CONTRACT, PROJECTS_VERSION, createProjectsHandlers({ projects: () => services.journalRead.listProjects() }));
    if (writable) registerServing(registrar, services);
    if (events !== undefined) {
      registrar.register(EVENTS_CONTRACT, EVENTS_VERSION, events.handlers());
      const approvals = built.approvals;
      const sources = createEventSources({
        hub: events,
        journal: services.journalRead,
        auditHead: () => services.auditRead.head()?.seq ?? 0,
        anchorStalled: () => services.anchors.status().stalled,
        pending: (windowId) => approvals?.port.pending(windowId) ?? [],
        ...(options.eventPumpMs === undefined ? {} : { intervalMs: options.eventPumpMs }),
        onError: (reason) => logger?.warn("request.failed", { reason }),
      });
      cleanups.push(() => sources.dispose());
    }
    // Every served method has a handler and every handler is a served method; a mismatch is exit 70 before `ready`.
    checkCoverage({ ...services.surface, also: { handlers: recorded.methods() } });

    const limiter = createConnectLimiter({
      clock: ports.clock,
      ...(config.limits.connectsPerMinute === undefined ? {} : { connectsPerMinute: config.limits.connectsPerMinute }),
      ...(config.limits.connectBurst === undefined ? {} : { burst: config.limits.connectBurst }),
    });
    const router = createConnectRouter({ limiter, accept: (connection, attestation) => daemon.accept(connection, attestation), ...(options.mux === undefined ? {} : { mux: options.mux }), ...(logger === undefined ? {} : { logger }) });
    const offMux = control.onConnect((request) => router.fromMux(request));
    const offPort = options.portSource?.onPort((data, port) => router.fromPortMessage(data, port));
    offConnect = () => {
      offMux();
      offPort?.();
    };
    cleanups.push(() => offConnect?.());
    cleanups.push(control.onTrustSet((m) => {
      try {
        services.trust.set({ windowId: m.windowId, ...(m.workspaceId === undefined ? {} : { workspaceId: m.workspaceId }) }, m.trusted);
      } catch {
        logger?.warn("request.failed", { reason: "trust_set_refused" }); // the registry fails closed by itself
      }
    }));
    cleanups.push(control.onProjectsRegister((m) => handleProjectsRegister({ journal, control, ...(logger === undefined ? {} : { logger }) }, m)));

    // Step 11: signals, the control `shutdown` message, crash handlers.
    lifecycle = installHostLifecycle({
      daemon,
      control,
      stop: () => stop(),
      finalize: () => finalAnchor(services),
      ...(options.finalizeTimeoutMs === undefined ? {} : { finalizeTimeoutMs: options.finalizeTimeoutMs }),
      ...(logger === undefined ? {} : { logger }),
      exit: options.exit,
      process: options.process,
    });
    void lifecycle.finished.then(finish);
  }

  /** The services of a healthy host, each registered through the registrar and nothing else. */
  function registerServing(registrar: ReturnType<typeof createHandlerRegistrar>, services: HostServices): void {
    const { worktrees, runs, approvals, composer } = built;
    const journal = services.journal;
    const audit = services.audit;
    if (worktrees === undefined || runs === undefined || approvals === undefined || composer === undefined || journal === undefined || audit === undefined) throw new AxisError("E_INTERNAL", "The host composition is incomplete", { reason: "not_built" });
    const git = createGitPort({
      gitPath: services.gitPath,
      env: { daemon: ports.env, pty: ports.env },
      platform: config.platform,
      runHooks: options.runHooks ?? false,
      scanner,
      ptyRunner: ptyGitRunner,
      assertNoDrift: (w) => worktrees.assertNoDrift(w),
      excludeDirs: services.excludeDirs,
    });
    const basesPath = join(config.dataDir, "push-bases.v1.json");
    const reviewDir = join(config.dataDir, "review-index");
    rmSync(reviewDir, { recursive: true, force: true }); // stale temporary indexes of an earlier process (this one holds the lock)
    mkdirSync(reviewDir, { recursive: true, mode: 0o700 });
    const reviewDeps = { git, locator: worktrees.locator, tempIndex: createTempIndexProvider(reviewDir), fileExists: (p: string) => access(p).then(() => true, () => false) };
    const trees = new ReviewedTrees();
    registrar.register(APPROVALS_CONTRACT, APPROVALS_VERSION, createApprovalsHandlers({ approvals: approvals.port }));
    registrar.register(PROVIDERS_CONTRACT, PROVIDERS_VERSION, createProvidersHandlers({ providers: () => [] }));
    registrar.register(WORKTREES_CONTRACT, WORKTREES_VERSION, createWorktreesHandlers({ service: worktrees.service, needsAttention: worktrees.needsAttention }), { content: worktrees.content });
    registerComposerRunsHandlers(registrar, { service: composer, journal, mutex: worktrees.mutex, needsAttention: worktrees.needsAttention });
    registerCliRunsHandlers(registrar, { service: runs.service, journal, control, minter: createRunTrustMinter(ports.clock), mutex: worktrees.mutex, needsAttention: worktrees.needsAttention, platform: config.platform });
    registrar.register(
      REVIEW_CONTRACT,
      REVIEW_VERSION,
      createReviewHandlers({ review: createReviewService(reviewDeps), journal, runs: runs.service, trees, audit: createReviewAuditSink({ append: (e) => (audit.append(e), services.anchors.noteWrite()) }) }),
    );
    registerGitHandlers(registrar, {
      ops: createGitOperations({ git, runs: runs.service, resolveSshHost: options.sshSpawn === undefined ? unavailableSshResolver : createSshResolver({ spawn: options.sshSpawn, env: ports.env, excludeDirs: services.excludeDirs }) }),
      review: createCommitPreparer(reviewDeps),
      trees,
      journal,
      locator: worktrees.locator,
      mutex: worktrees.mutex,
      needsAttention: worktrees.needsAttention,
      anchors: services.anchors,
      runs: runs.service,
      bases: new PushedBases(1024, loadPushedBases(basesPath, 1024), (entries) => savePushedBases(basesPath, entries)),
      onInternalError: () => logger?.error("request.failed", { reason: "git_internal" }),
      onBookkeepingError: () => logger?.warn("request.failed", { reason: "git_bookkeeping" }),
    });
  }

  /**
   * Shutdown steps 3 and 4 (design 8). Step 3: nothing may write after the final anchor, so the connect listener goes, the anchor
   * manager stops putting by itself, and the run supervisor kills live process groups and stops listening to them (a CLI that
   * exits now writes nothing). Step 4: the final checkpoint is put (synchronously) and its acknowledgement awaited, bounded; one
   * that does not arrive in time throws, and the lifecycle reports it as exit code 1 (the anchor on the supervisor is older than
   * the database).
   */
  async function finalAnchor(services: HostServices): Promise<void> {
    offConnect?.();
    services.haltAnchor();
    built.runs?.dispose();
    // Composer loops stop and write nothing more to the journal; what was running gets a bounded moment to record its result,
    // then the composer and challenge writers are sealed, so the final checkpoint below covers the last row (review r1 S1).
    if (!(await settleComposer(built.composer, auditSeal, options.composerSettleMs ?? 1_000))) logger?.warn("request.failed", { reason: "composer_unsettled" });
    built.agent?.dispose();
    services.flushAnchor();
    const target = services.anchor().put;
    const head = services.auditRead.head();
    // The final put must cover the newest row; one that could not be sent (a closed channel) leaves rows unanchored.
    if (head !== null && (target === undefined || target === null || target.seq < head.seq) && services.anchor().ackedSeq < head.seq) {
      throw new AxisError("E_UNAVAILABLE", "The final audit anchor could not be sent", { reason: "final_anchor_unsent" });
    }
    if (target === undefined || target === null || services.anchor().ackedSeq >= target.seq) return;
    const acked = await new Promise<boolean>((resolve) => {
      const off = control.onAnchorAck(() => {
        if (services.anchor().ackedSeq >= target.seq) done(true);
      });
      const timer = setTimeout(() => done(false), options.finalAnchorWaitMs ?? 1_500) as unknown as NodeJS.Timeout; // opaque handle under Code OSS's typings (ADR 0005)
      timer.unref();
      function done(ok: boolean): void {
        clearTimeout(timer);
        off();
        resolve(ok);
      }
    });
    if (!acked) throw new AxisError("E_UNAVAILABLE", "The final audit anchor was not acknowledged", { reason: "final_anchor_unacked" });
  }

  function stop(): Promise<DisposeResult> {
    stopping ??= (async () => {
      lifecycle?.dispose();
      runCleanups();
      return host.stop();
    })();
    return stopping;
  }

  return {
    host,
    start: async () => {
      try {
        return await host.start();
      } catch (e) {
        lifecycle?.dispose();
        runCleanups();
        throw e;
      }
    },
    stop,
    finished,
  };
}
