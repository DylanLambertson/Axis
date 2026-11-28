// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes, randomUUID } from "node:crypto";
import { AxisError, withTransaction, type InstanceLock } from "@axis/audit";
import { Daemon, EventHub, MemoryIdempotencyStore, type ElectronPortLike, type ShutdownOptions } from "@axis/daemon";
import type { GitRunner } from "@axis/git-ops";
import { EVENTS_CONTRACT, EVENTS_VERSION, MAX_PROMPT_CHARS, PROJECTS_CONTRACT, PROJECTS_VERSION } from "@axis/protocol";
import { createSecretScanner, type ScanMode } from "@axis/secret-scan";
import { anchorPreflight } from "./anchor/preflight.js";
import { createAgentBinding, type AgentBinding } from "./bindings/agent.js";
import { asVaultBackend, createProvidersBinding, productionConnection, type AnthropicConnectionOptions, type ProvidersBinding } from "./bindings/providers.js";
import { confirmFinalAnchor } from "./compose-anchor.js";
import { secretBrokerWiring, type SecretBrokerOption } from "./compose-secrets.js";
import { selectPtyGitRunner } from "./bindings/pty-git.js";
import { createRunsBinding, type RunsBinding } from "./bindings/runs.js";
import { composerGuardDeps, createRunRepositoryGuard, type RunSnapshotterFactory } from "./bindings/snapshot.js";
import { createWorktreesBinding, type WorktreesBinding } from "./bindings/worktrees.js";
import { composerWriteLock, createActiveRunForwarder, createAuditSeal, createRunsClock, isPty, messageSecretCheck, cliEndpointPty, cliEndpointLive, type CliEndpointLive, refuseComposition, settleComposer, daemonAuditSink, createProjectRunStopper, recordingRegistrar, registryOf, type ComposerOptions, type MessagingOptions } from "./compose-parts.js";
import { hostCommandLimits, type CommandLimits } from "./bindings/agent-command.js";
import type { HostConfig } from "./config.js";
import { createAttestationVerifier } from "./control/attestation.js";
import type { ControlClient } from "./control/client.js";
import { createConnectLimiter } from "./control/connect-limiter.js";
import { createConnectRouter } from "./control/connect-router.js";
import type { DisposeResult, ListenerTarget } from "./disposables.js";
import { sweepIndexLocksAtStart } from "./index-lock-sweep.js";
import { createEventSources } from "./events/sources.js";
import { hostMintRecheck } from "./messages/enable-check.js";
import { installProjectControl } from "./projects/control.js";
import { registerServing } from "./compose-serving.js";
import { createChallengeAuditSink } from "./gate/audit-sink.js";
import { createWorktreesApprovals, type WorktreesApprovals } from "./gate/worktrees-confirm.js";
import { createRunTrustMinter } from "./gate/run-trust.js";
import { createComposerService, type ComposerService } from "./composer/service.js";
import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MAX_TURNS, resolveToolCaps } from "./composer/loop.js";
import { assertScanBudgetFits } from "./bindings/provider-redactor.js";
import { createHandlerRegistrar, registerAuditHandlers, type HandlerRegistrar } from "./handlers/anchor-guard.js";
import { type SshSpawn } from "./bindings/ssh-resolver.js";
import { createProjectsHandlers } from "./handlers/projects.js";
import { createMessagingBinding, hostMessagingDeps, type MessagingBinding } from "./messages/binding.js";
import { createPagesService, type PagesService } from "./pages/service.js";
import { createTasksService, type TasksService } from "./tasks/service.js";
import { journalWorkerOf } from "./agents/directory.js";
import { createDaemonHost, type DaemonHost, type HostOptions, type HostServices, type StartupPorts } from "./host.js";
import { installHostLifecycle, type LifecycleHandle, type LifecycleOptions } from "./lifecycle.js";
import type { Logger } from "./log/logger.js";
import { checkCoverage } from "./policy/coverage.js";
import { createRunTaint } from "./composer/taint.js";
import { pluginRunStartChallenges } from "./gate/plugin-run-start.js";
import { createWindowLifetimes, type WindowLifetimes } from "./plugins/window-lifetimes.js";
import type { PtyExecPort, PtyForgePort, PtyPort, PtyPushPort } from "./ports/pty.js";
import type { ChannelMux } from "./transport/mux.js";
import { createEgressClient, type EgressClient } from "./net/egress-client.js";
import type { SecretBackend } from "./bindings/integrations.js";
import { composeTerminals, installTerminals, recordRunTerminals, runScope, withTerminalFanOut, type HostTerminals, type TerminalDataBroker } from "./terminals/compose.js";

/**
 * The composition root (ticket H12, design section 3 steps 10 and 11, plan section 1 and questions 18 and 19). It is the one
 * place that builds the `Daemon` and every binding, and it hands handler code ONLY the `HandlerRegistrar` (never the
 * `Daemon`, the raw `register`, the database or the discard minter; the run trust minter goes to the cli-runs handlers alone, TRU-2).
 *
 * What it guarantees, and what fails closed:
 * - It REFUSES TO BE BUILT without a pty port and a pty git runner (`pty_required`, exit 78, before a lock or a file exists; the
 *   runner is `createPtyGitRunner` over the port's `exec` when it has one, the only mapping of git-ops onto `exec`):
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
  /** The Axis pty process (CLI runs). REQUIRED. With `exec`, the `pty` git context and push run over it (H9-hooks S4, hooks off). */
  readonly pty: (PtyPort & Partial<PtyExecPort> & Partial<PtyPushPort> & Partial<PtyForgePort>) | undefined;
  /** The `pty` git context runner, REQUIRED exactly when `pty` has no `exec` (test fakes); refused alongside one that has. */
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
  /** TEST ONLY: sees the host windows' lifetimes the composition feeds (PV-K2 K2-g4b); it can read them, never feed them. */
  readonly observeWindowLifetimes?: (lifetimes: Pick<WindowLifetimes, "current" | "status">) => void;
  /** TEST ONLY observer (DC-3c): the composed terminals, when there are any. It can watch them; it cannot add any path to them. */
  readonly observeTerminals?: (terminals: HostTerminals) => void;
  /** DC-3b's data-port broker attestation: only DC-3b's broker makes one; without it `axis.terminals/1` is not served. */
  readonly terminalDataBroker?: TerminalDataBroker;
  /** TEST ONLY: sees whether the composer binding was given the WT-2 guard (review c3 r1 N-6). */
  readonly observeAgent?: (agent: { readonly commands: boolean; readonly gitReads: boolean; readonly commandLimits: CommandLimits }) => void;
  /** TEST ONLY: sees the `agentOf` the messaging binding was given (PV-G4: it knows no run unless `messaging.enabled`), the CLI endpoint path's own lookup and whether its relay was wired (PV-M7 slice 2: the user's switch alone decides both). */
  readonly observeMessaging?: (m: { readonly agentOf: (runId: string) => string | undefined; readonly cliAgentOf: (runId: string) => string | undefined; readonly cliWired: boolean }) => void;
  /** How long shutdown waits for composer runs to record their last rows before the audit writers are sealed (default 1000). */
  readonly composerSettleMs?: number;
  /** Composer runs (`axis.runs/1`, docs/design/composer-runtime.md); see `ComposerOptions`. */
  readonly composer?: ComposerOptions & {
    /** The Anthropic connection over the vault (C6); absent, only the mock is served. Always Node's own `fetch` and the default wire caps. */
    readonly anthropic?: Pick<AnthropicConnectionOptions, "connectionId" | "backend" | "pricing">;
  };
  /** Period of the event sources (docs/design/events.md section 4; default 250 ms). */
  readonly eventPumpMs?: number;
  /** Messaging: `enabled` for agent runs (delivery, the send and read tools; `HostMessaging.enabled`), off by default. The CLI endpoint is the user's switch in the journal (PV-M7 slice 2). */
  readonly messaging?: MessagingOptions;
  /**
   * PV-K2 K2-g2: serve `axis.plugins/1.grant` and `enable` (tier 4, native confirmation). Off by default and in production until
   * K2-enable, which merges only once all six conditions of `plugin-grant-contract.md` section 1 hold; off, both are refused
   * before any challenge (`plugin_grants_off`).
   */
  readonly pluginGrants?: boolean;
  /**
   * TEST ONLY (net-read-slice.md §7): the integrations' egress client and secret backend. The daemon entry passes neither:
   * the client is then the production one, and with no backend (production until PV-N0c) nothing is revealed or sent.
   */
  readonly integrations?: { readonly client?: EgressClient; readonly vaultBackend?: SecretBackend };
  /** TEST ONLY until PV-N0c-2: the secret broker wiring (`compose-secrets.ts`); the daemon entry never sets it (a pinned test). */
  readonly secretBroker?: SecretBrokerOption;
}

export interface ComposedHost {
  readonly host: DaemonHost;
  start(): Promise<HostServices>;
  stop(): Promise<DisposeResult>;
  /** Resolves after the lifecycle's exit hook ran (never before `start` resolved). */
  readonly finished: Promise<void>;
}

export function composeDaemonHost(options: ComposeOptions): ComposedHost {
  if (!isPty(options.pty)) refuseComposition("pty_required");
  // One source for the pty git context: the strict mapping over the pty process's `exec`, or (no `exec`) the caller's runner.
  const chosenPtyGit = selectPtyGitRunner(options.pty, options.ptyGitRunner, options.config.platform);
  if (typeof chosenPtyGit === "string") refuseComposition(chosenPtyGit);
  const ptyGitRunnerFor: (gitPath: string) => GitRunner = chosenPtyGit;
  if (typeof options.snapshotter !== "function") refuseComposition("snapshotter_required");
  // Lower-only (C3): read field by field before anything is built; a bad override refuses the composition.
  const commandBounds = hostCommandLimits(options.composer?.commandLimits);
  if (typeof commandBounds === "string") refuseComposition(commandBounds);
  const { control, pty } = options;
  // DC-3a/DC-3c: terminals only with all four pty parts and a trust registry with onRevoked (fixed here); otherwise not served.
  const { terminals, config, ports } = composeTerminals(options.config, options.ports, pty, options.observeTerminals, options.terminalDataBroker);
  const snapshotterFactory = options.snapshotter;
  const logger: Logger | undefined = ports.logger;
  const scanner = createSecretScanner({ mode: options.scanMode ?? "refuse" });
  if (options.secretBroker !== undefined && (options.composer?.anthropic !== undefined || options.integrations?.vaultBackend !== undefined)) refuseComposition("secret_broker_conflict");
  const broker = secretBrokerWiring(options.secretBroker, control, logger); // undefined unless the option is set: no backend, no send
  const viaBroker = broker === undefined ? undefined : asVaultBackend(broker.backend); // the ONE backend both bindings get
  // Closed when the final anchor is taken: no composer or challenge row may land after it (review r1 S1).
  const auditSeal = createAuditSeal();
  // The host windows' lifetimes (PV-K2 K2-g4b, plugin-grant-contract.md section 8.4): fed by the daemon's session lifecycle and
  // main's `window.gone`; a plugin's run start is bound to the lifetime its host window was in when the challenge was issued.
  const windowLifetimes = createWindowLifetimes({ randomBytes: (n) => randomBytes(n) });
  options.observeWindowLifetimes?.(windowLifetimes);

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
  const built: { worktrees?: WorktreesBinding; runs?: RunsBinding; approvals?: WorktreesApprovals; projectPaths?: () => string[]; agent?: AgentBinding; composer?: ComposerService; providers?: ProvidersBinding; messaging?: MessagingBinding; cliLive?: CliEndpointLive; pages?: PagesService; tasks?: TasksService } = {};
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
        if (typeof snapshotter?.before !== "function" || typeof snapshotter?.after !== "function") refuseComposition("snapshotter_required");
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
          // PV-K1e-b: a plugin's run start is challenged in its host window, bound to its grant, and counted (journal v17).
          plugins: pluginRunStartChallenges(parts.journal, parts.journal.pluginIssues, () => ports.clock.now(), windowLifetimes),
        });
        cleanups.push(() => approvals.dispose());
        const worktrees = createWorktreesBinding({
          journal: parts.journal,
          audit: parts.audit,
          transact: (fn) => withTransaction(parts.db, fn),
          random: { bytes: (n) => randomBytes(n), uuid: () => randomUUID() },
          runs: forwarder,
          ...(terminals === undefined ? {} : { terminals: terminals.registry }),
          now: () => ports.clock.monotonic(),
          gitPath: parts.gitPath,
          env: ports.env,
          platform: config.platform,
          worktreeRoot: config.worktreeRoot,
          onPreview: approvals.onPreview,
        });
        const runs = createRunsBinding({
          journal: parts.journal,
          audit: parts.audit,
          // PV-M6: a CLI run's endpoint at spawn, only with the messaging flags on; PV-M7: the enable rule is checked again first.
          pty: recordRunTerminals(cliEndpointPty(pty, () => cliLive.current(), hostMintRecheck({ journal: parts.journal, settingsGet: (k, o) => control.settingsGet(k, o), platform: config.platform, agentOfRun: (id) => parts.journal.agents.agentOfRun(id), acknowledged: (id) => parts.journal.messages.cliAcknowledged(id), audit: parts.audit })), terminals, (id) => runScope(parts.journal, id)),
          clock: createRunsClock(ports.clock),
          locator: worktrees.locator,
          snapshotter,
          env: () => ports.env,
          redactor: ports.redactor,
          mutex: worktrees.mutex,
          platform: config.platform,
          managedWorktreeRoots: () => [config.worktreeRoot],
          ...(config.limits.runSnapshotTimeoutMs === undefined ? {} : { limits: { snapshotTimeoutMs: config.limits.runSnapshotTimeoutMs } }),
          onInternalError: (where) => logger?.error("request.failed", { reason: `runs_${String(where).slice(0, 24)}` }),
        });
        cleanups.push(() => runs.dispose());
        forwarder.bind(runs.service);
        const projectPaths = (): string[] => parts.journal.listProjects().map((p) => p.path);
        // Composer runs: the broker's audit rows mark the anchor batch dirty like every other writer.
        const providers = createProvidersBinding({ redactor: ports.redactor, audit: composerWriter, ...productionConnection(broker === undefined || viaBroker === undefined ? options.composer?.anthropic : { connectionId: broker.connectionId, backend: viaBroker, vault: broker.vault }) });
        if (broker !== undefined) void broker.startup((signal) => providers.validateStored(signal)); // the startup reveal, under the option only
        // axis.messages/1 (PV-M3): service, settings and delivery into runs; its rows go through the sealed composer writer.
        const messagingDeps = hostMessagingDeps({ journal: parts.journal, audit: composerWriter, monotonic: () => ports.clock.monotonic(), scan: (text) => scanner.scan(text, { part: "message" }), logger, holdsSecret: messageSecretCheck(ports.redactor), enabled: options.messaging?.enabled === true });
        const messaging = createMessagingBinding(messagingDeps);
        // The CLI endpoint, live (PV-M7 slice 2): wired at start when the user's switch is on (read from the journal, never a
        // flag); the switch handlers turn it on and off in the running host.
        const cliLive = cliEndpointLive(pty, messaging.endpoints, cleanups);
        if (parts.journal.cliEndpoint.enabled()) cliLive.on();
        options.observeMessaging?.({ agentOf: (id) => messagingDeps.agentOf?.(id), cliAgentOf: (id) => messagingDeps.cliAgentOf?.(id), cliWired: cliLive.current() !== undefined });
        // axis.pages/1 and the page tools (PV-Q1 slice 2): writes and their audit rows through the sealed composer writer.
        const pages = createPagesService({ journal: parts.journal, audit: composerWriter, random: { bytes: (n) => randomBytes(n) } });
        const tasks = createTasksService({ journal: parts.journal, audit: composerWriter, random: { bytes: (n) => randomBytes(n) } }); // axis.tasks/1 (PV-T1 slice 2a)
        const workerOf = journalWorkerOf(parts.journal);
        const agent = createAgentBinding({
          locator: worktrees.locator,
          repositoryRoots: projectPaths,
          audit: composerWriter,
          redactor: ports.redactor,
          env: () => ports.env,
          approvals: approvals.runs, taintStore: parts.journal.composer, deliveries: messaging.delivery, // IAC-T: run taint, recorded in its journal record
          messaging: messaging.participation, // PV-M4: offered to no run while messaging is off (`agentOf` knows none)
          pages: { service: pages, workerOf }, // PV-Q1 slice 2: read_page and write_page, for a run of a live worker only
          tasks: { service: tasks, workerOf }, // PV-T1 slice 2a: the task tools, the same rule
          now: () => ports.clock.now(),
          platform: config.platform,
          ...(options.composer?.mock === undefined ? {} : { mock: options.composer.mock }),
          providers: providers.providers,
          // Composer writes take the project mutex Axis git operations take (policies 3.3, 6.1), queued like any caller.
          writeLock: composerWriteLock(parts.journal, worktrees.mutex),
          // WT-2 broker side (C3): one baseline per composer run, held by run and apart from the CLI runs' snapshotter.
          commandGuard: createRunRepositoryGuard(composerGuardDeps({ gitPath: parts.gitPath, env: ports.env, projectRoot }, config.limits)),
          gitPath: parts.gitPath, // git_status and git_diff (C3 slice 2): the broker's git on the host's one git
          commandLimits: commandBounds,
        });
        options.observeAgent?.({ commands: agent.commands, gitReads: agent.gitReads, commandLimits: agent.commandLimits });
        const caps = resolveToolCaps(options.composer?.toolCaps);
        assertScanBudgetFits({ ...caps, maxTurns: options.composer?.maxTurns ?? DEFAULT_MAX_TURNS, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS, promptChars: MAX_PROMPT_CHARS });
        const composer = createComposerService({
          journal: parts.journal,
          engine: agent,
          now: () => ports.clock.now(),
          redactor: ports.redactor,
          ...(options.composer?.budget === undefined ? {} : { budget: options.composer.budget }),
          ...(options.composer?.workspaceBudget === undefined ? {} : { workspaceBudget: options.composer.workspaceBudget }),
          ...(options.composer?.maxTurns === undefined ? {} : { maxTurns: options.composer.maxTurns }),
          ...(options.composer?.toolCaps === undefined ? {} : { toolCaps: options.composer.toolCaps }),
          onInternalError: (where) => logger?.error("request.failed", { reason: `composer_${where.slice(0, 24)}` }),
          // PV-K1e: a plugin-started run is tainted inside its creation, over the journal's records and its own audit log.
          taintAtStart: (runId, receipt) => createRunTaint({ runId, store: parts.journal.composer, audit: composerWriter, now: () => ports.clock.now() }).receive(receipt),
        });
        cleanups.push(() => (composer.dispose(), agent.dispose()));
        Object.assign(built, { worktrees, runs, approvals, projectPaths, agent, composer, providers, messaging, cliLive, pages, tasks });
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
      built.messaging?.delivery.releaseLeases(); // no run survives a restart: a delivery whose ack never landed goes to a later run
      await sweepIndexLocksAtStart(journal, logger); // DC-0b (RR-98): a provably Axis-made stale index lock goes
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
      lifecycle: windowLifetimes,
    });
    cleanups.push(() => daemon.stop());
    const recorded = recordingRegistrar(createHandlerRegistrar(daemon, services.anchors));
    const withheld = options.withholdHandlers;
    // Test seam: a contract listed in `withholdHandlers` is not registered, and the coverage check below must then fail startup.
    const registrar: HandlerRegistrar = withheld === undefined ? recorded.registrar : Object.freeze({ register: ((c, v, h, o) => (withheld.has(c) ? undefined : recorded.registrar.register(c, v, h, o))) as HandlerRegistrar["register"] });

    registerAuditHandlers(registrar, { audit: services.auditRead, anchors: services.anchors, degraded: () => services.degraded, clock: ports.clock });
    registrar.register(PROJECTS_CONTRACT, PROJECTS_VERSION, createProjectsHandlers({ projects: () => services.journalRead.listProjects() }));
    // A revoke (a gesture, or the gate's lost binding) stops the project's live runs (project-registration-and-trust.md §5.4).
    const stopProjectRuns = withTerminalFanOut(createProjectRunStopper({ mutex: () => built.worktrees?.mutex, journal: () => services.journal, runs: () => built.runs?.service, composer: () => built.composer }), terminals);
    if (writable) {
      const egress = options.integrations?.client ?? createEgressClient();
      cleanups.push(() => egress.close());
      const integrations = { sender: egress, backend: viaBroker ?? options.integrations?.vaultBackend };
      registerServing(registrar, services, { built, config, control, ports, pty, scanner, ptyGitRunnerFor, logger, runHooks: options.runHooks ?? false, sshSpawn: options.sshSpawn, pluginGrants: options.pluginGrants === true, stopProjectRuns, minter: createRunTrustMinter(ports.clock), hostWindows: windowLifetimes, integrations, terminals, terminalRouting: installTerminals(terminals, services.trust, (e) => (services.audit?.append(e), services.anchors.noteWrite()), () => logger?.warn("request.failed", { reason: "terminal_audit" }), cleanups) });
    }
    if (events !== undefined) {
      registrar.register(EVENTS_CONTRACT, EVENTS_VERSION, events.handlers());
      const approvals = built.approvals;
      const sources = createEventSources({
        hub: events,
        journal: services.journalRead,
        auditHead: () => services.auditRead.head()?.seq ?? 0,
        auditSince: (afterSeq, limit) => services.auditRead.list({ afterSeq, limit }),
        anchorStalled: () => services.anchors.status().stalled,
        pending: (windowId) => approvals?.port.pending(windowId) ?? [],
        ...(options.eventPumpMs === undefined ? {} : { intervalMs: options.eventPumpMs }),
        onError: (reason) => logger?.warn("request.failed", { reason }),
      });
      cleanups.push(() => sources.dispose());
    }
    // Every served method has a handler and every handler is a served method; a mismatch is exit 70 before `ready`.
    checkCoverage({ ...services.surface, also: { handlers: recorded.methods() }, gated: recorded.gated() });

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
    cleanups.push(control.onWindowGone((m) => (windowLifetimes.gone(m.windowId), terminals?.registry.windowGone(m.windowId))));
    cleanups.push(control.onTrustSet((m) => {
      try {
        services.trust.set({ windowId: m.windowId, ...(m.workspaceId === undefined ? {} : { workspaceId: m.workspaceId }) }, m.trusted);
      } catch {
        logger?.warn("request.failed", { reason: "trust_set_refused" }); // the registry fails closed by itself
      }
    }));
    cleanups.push(installProjectControl(control, { journal, config, gitPath: services.gitPath, env: ports.env, onRevoked: stopProjectRuns, ...(logger === undefined ? {} : { logger }) }));

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
    await broker?.stop(); // the startup reveal starts no read the sealed writers could not audit (review n0c1-b nit)
    // Composer loops stop and write nothing more to the journal; what was running gets a bounded moment to record its result,
    // then the composer and challenge writers are sealed, so the final checkpoint below covers the last row (review r1 S1).
    if (!(await settleComposer(built.composer, auditSeal, options.composerSettleMs ?? 1_000))) logger?.warn("request.failed", { reason: "composer_unsettled" });
    built.agent?.dispose();
    services.flushAnchor();
    await confirmFinalAnchor(control, { anchor: () => services.anchor(), head: () => services.auditRead.head() }, options.finalAnchorWaitMs ?? 1_500);
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
