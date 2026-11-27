// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { mkdirSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { AxisError } from "@axis/audit";
import type { GitRunner } from "@axis/git-ops";
import { APPROVALS_CONTRACT, APPROVALS_VERSION, PROVIDERS_CONTRACT, PROVIDERS_VERSION, REVIEW_CONTRACT, REVIEW_VERSION, WORKTREES_CONTRACT, WORKTREES_VERSION } from "@axis/protocol";
import type { SecretScanner } from "@axis/secret-scan";
import { createGitOperations, createGitPort } from "./bindings/git.js";
import { registerForgeServing } from "./compose-forge.js";
import { registerAttentionServing } from "./handlers/attention.js";
import { registerUsageServing } from "./handlers/usage.js";
import { usageServiceDeps } from "./usage/service.js";
import { integrationsVault, type SecretBackend } from "./bindings/integrations.js";
import { registerIntegrationsServing } from "./handlers/integrations.js";
import { createIntegrationsService, type IntegrationsSender } from "./integrations/service.js";
import { createCommitPreparer, createReviewService } from "./bindings/review.js";
import { createTempIndexProvider } from "./bindings/review-tempindex.js";
import { createSshResolver, unavailableSshResolver, type SshSpawn } from "./bindings/ssh-resolver.js";
import type { AgentBinding } from "./bindings/agent.js";
import type { RunsBinding } from "./bindings/runs.js";
import type { WorktreesBinding } from "./bindings/worktrees.js";
import type { ComposerService } from "./composer/service.js";
import type { HostConfig } from "./config.js";
import type { ApprovalsHandlerDeps } from "./handlers/approvals.js";
import type { ProvidersHandlerDeps } from "./handlers/providers.js";
import type { MessagingBinding } from "./messages/binding.js";
import type { RunTrustMinter } from "./ports/runs.js";
import type { ControlClient } from "./control/client.js";
import { createHostProjectTrustGate } from "./gate/project-trust-gate.js";
import { ticketedStart, type TrustCall } from "./gate/project-trust.js";
import type { HandlerRegistrar } from "./handlers/anchor-guard.js";
import { createApprovalsHandlers } from "./handlers/approvals.js";
import { registerCliRunsHandlers, startCliRun, type CliStart } from "./handlers/cli-runs.js";
import { registerComposerRunsHandlers, startComposerRun, type ComposerRunsHandlerDeps, type ComposerStart } from "./handlers/composer-runs.js";
import { registerPluginsHandlers } from "./handlers/plugins.js";
import { createGrantAction } from "./plugins/grant-action.js";
import { createCliEndpointSwitchAction } from "./messages/cli-endpoint-action.js";
import { hostCliSwitch, type CliEndpointLive } from "./compose-parts.js";
import type { HandlerContext } from "@axis/daemon";
import { PushedBases } from "./handlers/git-common.js";
import { registerGitHandlers } from "./handlers/git.js";
import { registerAgentsHandlers } from "./handlers/agents.js";
import { providerForConnection } from "./agents/start.js";
import { registerMessagesHandlers } from "./handlers/messages.js";
import { hostEnableCheck } from "./messages/enable-check.js";
import { registerPagesHandlers } from "./handlers/pages.js";
import { createPagesContentHooks } from "./pages/confirm.js";
import type { PagesService } from "./pages/service.js";
import { registerTasksHandlers } from "./handlers/tasks.js";
import { createTaskStart } from "./tasks/start.js";
import { createTasksContentHooks } from "./tasks/confirm.js";
import type { TasksService } from "./tasks/service.js";
import { createProvidersHandlers } from "./handlers/providers.js";
import { createReviewAuditSink } from "./handlers/review-audit.js";
import { createReviewHandlers } from "./handlers/review.js";
import { ReviewedTrees } from "./handlers/review-store.js";
import { createWorktreesHandlers } from "./handlers/worktrees.js";
import type { HostServices, StartupPorts } from "./host.js";
import type { Logger } from "./log/logger.js";
import type { PtyExecPort, PtyForgePort, PtyPort } from "./ports/pty.js";
import { loadPushedBases, savePushedBases } from "./storage/pushed-bases-file.js";
import type { WindowLifetimes } from "./plugins/window-lifetimes.js";

/** What `registerServing` takes from the composition (moved out of compose.ts unchanged, plus the project trust gate). */
/**
 * What `registerServing` reads of the composition's built parts. Structural on purpose: the providers binding and the minters may be
 * imported by the composition root only, so this file names just the calls it makes on them.
 */
export interface ServingParts {
  readonly worktrees?: WorktreesBinding;
  readonly runs?: RunsBinding;
  readonly approvals?: { readonly port: ApprovalsHandlerDeps["approvals"]; readonly onPreview?: (target: string, contentDigest: string, text: string) => void; readonly endPlugin: (pluginId: string, projectId: string) => number };
  readonly agent?: AgentBinding;
  readonly composer?: ComposerService;
  readonly providers?: { readonly cachedModels: NonNullable<ProvidersHandlerDeps["cachedModels"]>; readonly credential: NonNullable<ProvidersHandlerDeps["credential"]> };
  readonly messaging?: MessagingBinding;
  /** The live CLI endpoint wiring (PV-M7 slice 2): the switch handlers turn it on and off. */
  readonly cliLive?: CliEndpointLive;
  readonly pages?: PagesService;
  readonly tasks?: TasksService;
}

export interface ServingContext {
  readonly built: ServingParts;
  readonly config: HostConfig;
  readonly control: ControlClient;
  readonly ports: Omit<StartupPorts, "control" | "reconcile" | "afterStorage" | "beforeReady">;
  readonly pty: (PtyPort & Partial<PtyExecPort> & Partial<PtyForgePort>) | undefined;
  readonly scanner: SecretScanner;
  readonly ptyGitRunnerFor: (gitPath: string) => GitRunner;
  readonly logger: Logger | undefined;
  readonly runHooks: boolean;
  readonly sshSpawn: SshSpawn | undefined;
  /** PV-K2 K2-g2: serve plugin grant and enable (`ComposeOptions.pluginGrants`); false in production until K2-enable. */
  readonly pluginGrants?: boolean;
  /** Stops the project's live CLI and composer runs (a revoke or a lost binding). */
  readonly stopProjectRuns: (projectId: string) => void;
  /** The CLI run trust minter (made by the composition root, the only module that may import it). */
  readonly minter: RunTrustMinter;
  /** The host windows' lifetimes (PV-K2 K2-g4b): a plugin's run start is checked against the one pinned at issue. */
  readonly hostWindows: Pick<WindowLifetimes, "alive">;
  /** The integrations' authorized sender (the egress client, which only the root may import) and secret backend, if any. */
  readonly integrations: { readonly sender: IntegrationsSender; readonly backend: SecretBackend | undefined };
}

/** The services of a healthy host, each registered through the registrar and nothing else. */
export function registerServing(registrar: HandlerRegistrar, services: HostServices, ctx: ServingContext): void {
  const { built, config, control, ports, pty, scanner, ptyGitRunnerFor, logger } = ctx;
  const options = { runHooks: ctx.runHooks, sshSpawn: ctx.sshSpawn };
  const { worktrees, runs, approvals, composer, agent, providers } = built;
  const journal = services.journal;
  const audit = services.audit;
  if (worktrees === undefined || runs === undefined || approvals === undefined || composer === undefined || agent === undefined || providers === undefined || journal === undefined || audit === undefined) throw new AxisError("E_INTERNAL", "The host composition is incomplete", { reason: "not_built" });
  const git = createGitPort({
    gitPath: services.gitPath,
    env: { daemon: ports.env, pty: ports.env },
    platform: config.platform,
    runHooks: options.runHooks ?? false,
    scanner,
    ptyRunner: ptyGitRunnerFor(services.gitPath),
    assertNoDrift: (w) => worktrees.assertNoDrift(w),
    excludeDirs: services.excludeDirs,
  });
  const basesPath = join(config.dataDir, "push-bases.v1.json");
  const reviewDir = join(config.dataDir, "review-index");
  rmSync(reviewDir, { recursive: true, force: true }); // stale temporary indexes of an earlier process (this one holds the lock)
  mkdirSync(reviewDir, { recursive: true, mode: 0o700 });
  const reviewDeps = { git, locator: worktrees.locator, tempIndex: createTempIndexProvider(reviewDir), fileExists: (p: string) => access(p).then(() => true, () => false) };
  const trees = new ReviewedTrees();
  // The project trust gate (project-registration-and-trust.md §5.4): every gated handler calls it right before its side effect.
  const gate = createHostProjectTrustGate({ journal, control, registry: services.trust, platform: config.platform, now: () => ports.clock.monotonic(), onRevoked: (projectId) => ctx.stopProjectRuns(projectId) });
  registrar.register(APPROVALS_CONTRACT, APPROVALS_VERSION, createApprovalsHandlers({ approvals: approvals.port }));
  registrar.register(PROVIDERS_CONTRACT, PROVIDERS_VERSION, createProvidersHandlers({ providers: () => agent.providers(), cachedModels: (id) => providers.cachedModels(id), credential: (id, signal) => providers.credential(id, signal) }));
  registrar.register(WORKTREES_CONTRACT, WORKTREES_VERSION, createWorktreesHandlers({ service: worktrees.service, gate, needsAttention: worktrees.needsAttention }), { content: worktrees.content });
  const composerRuns: ComposerRunsHandlerDeps = {
    service: { cancel: (id) => composer.cancel(id), get: (id) => composer.get(id), list: (o) => composer.list(o), events: (id, a, l) => composer.events(id, a, l), start: ticketedStart((i, s) => composer.start(i, s), (id) => journal.getWorkspace(id)?.projectId, () => ports.clock.monotonic()) },
    gate,
    journal, mutex: worktrees.mutex, needsAttention: worktrees.needsAttention,
    pluginStarts: journal, // PV-K1e-b: a plugin's start reads its scope and grant from the journal
    hostWindows: ctx.hostWindows }; // PV-K2 K2-g4b: and is checked against its host window's pinned lifetime
  registerComposerRunsHandlers(registrar, composerRuns);
  // PV-K2 K2-g1: the user's plugin list, revoke and disable; a decrease ends the plugin's open challenges at once.
  registerPluginsHandlers(registrar, {
    journal,
    mutex: worktrees.mutex,
    endPlugin: (pluginId, projectId) => approvals.endPlugin(pluginId, projectId),
    // K2-g3: the journal's grant mint is taken here, once, at startup, and passed straight to the approved grant action. Anything
    // that took it first makes this throw, and the host does not start.
    grantAction: createGrantAction(journal.plugins, journal.plugins.takeGrantMint()),
    grantsEnabled: ctx.pluginGrants === true,
    onPreview: approvals.onPreview ?? (() => undefined),
  });
  if (built.messaging === undefined || built.cliLive === undefined) throw new AxisError("E_INTERNAL", "The host composition is incomplete", { reason: "not_built" });
  // PV-M7 slice 1: enabling a CLI worker's messaging checks its launch entry (from main, as a CLI start does) and workspace.
  registerMessagesHandlers(registrar, {
    ...built.messaging,
    checkEnable: hostEnableCheck({ journal, settingsGet: (k, o) => control.settingsGet(k, o), platform: config.platform }),
    // PV-M7 slice 2: the user's CLI endpoint switch. The journal's switch mint is taken here, once, at startup, straight into the
    // approved enable action (the writer rule checks it); anything that took it first makes this throw and the host not start.
    cliSwitch: hostCliSwitch({
      action: createCliEndpointSwitchAction(journal.cliEndpoint, journal.cliEndpoint.takeSwitchMint()),
      store: journal.cliEndpoint,
      live: built.cliLive,
      onLiveError: () => logger?.warn("request.failed", { reason: "cli_endpoint_live" }),
      platform: config.platform,
      onPreview: approvals.onPreview ?? (() => undefined),
    }),
  });
  if (built.pages === undefined) throw new AxisError("E_INTERNAL", "The host composition is incomplete", { reason: "not_built" });
  // axis.pages/1 (PV-Q1 slice 2): the user's own connection only; main's dialog for markReviewed and delete names the page.
  registerPagesHandlers(registrar, built.pages, createPagesContentHooks({ journal, onPreview: built.approvals?.onPreview ?? (() => undefined) }));
  if (built.tasks === undefined) throw new AxisError("E_INTERNAL", "The host composition is incomplete", { reason: "not_built" });
  const cliRuns = { service: runs.service, journal, control, gate, minter: ctx.minter, mutex: worktrees.mutex, needsAttention: worktrees.needsAttention, platform: config.platform };
  // One worker start for agents and tasks: the CLI and composer start paths, each through the project trust gate.
  const agentStart = {
    journal,
    startCli: (req: CliStart, context: HandlerContext) => startCliRun(cliRuns, req, context),
    startComposer: (req: ComposerStart, context: HandlerContext) => startComposerRun(composerRuns, req, context),
    providerFor: (connection: string) => providerForConnection(agent.providers(), connection),
  };
  // axis.tasks/1 (PV-T1 slices 2a, 2b): the user's own connection only; Start and delete name the task in main's dialog.
  registerTasksHandlers(
    registrar,
    built.tasks,
    createTaskStart({ journal, audit: { append: (e) => (audit.append(e), services.anchors.noteWrite()) }, agentStart }),
    createTasksContentHooks({ journal, onPreview: built.approvals?.onPreview ?? (() => undefined) }),
  );
  registerAgentsHandlers(registrar, {
    journal,
    mutex: worktrees.mutex,
    trust: services.trust,
    noteWrite: () => services.anchors.noteWrite(),
    // S1b (agents-contract.md 4.4 left this hook for it): the early check is the project's run-trust record, and the new home
    // worktree's create goes through the project trust gate like any other (the worktrees port spends its ticket).
    admitNewHome: (_caller, projectId) => journal.getProject(projectId)?.trusted === true,
    worktrees: { create: (req, ctx) => worktrees.service.create(req, { ...ctx, trust: (scope) => gate.admit({ ...scope, caller: ctx.caller.trust as TrustCall, signal: ctx.signal }) }) },
    // PV-G4: an agent's CLI run goes through the one CLI start path, so the same project trust gate and ticket apply;
    // a composer agent's goes through the composer start path, the stored connection resolved to the provider serving it now.
    startCli: agentStart.startCli,
    startComposer: agentStart.startComposer,
    providerFor: agentStart.providerFor,
  });
  registerCliRunsHandlers(registrar, cliRuns);
  registrar.register(
    REVIEW_CONTRACT,
    REVIEW_VERSION,
    createReviewHandlers({ review: createReviewService(reviewDeps), journal, runs: runs.service, trees, audit: createReviewAuditSink({ append: (e) => (audit.append(e), services.anchors.noteWrite()) }) }),
  );
  registerGitHandlers(registrar, {
    gate,
    ops: createGitOperations({ git, now: () => ports.clock.monotonic(), runs: runs.service, pushHooksUnavailable: typeof pty?.exec === "function", resolveSshHost: options.sshSpawn === undefined ? unavailableSshResolver : createSshResolver({ spawn: options.sshSpawn, env: ports.env, excludeDirs: services.excludeDirs, platform: config.platform }) }),
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
  registerForgeServing(registrar, { pty, projectPath: (id) => journal.getProject(id)?.path, git, platform: config.platform, audit: (e) => (audit.append(e), services.anchors.noteWrite()), monotonic: () => ports.clock.monotonic(), pins: journal.forgePins, ...(logger === undefined ? {} : { logger }) });
  registerAttentionServing(registrar, {
    projectExists: (id) => journal.getProject(id) !== undefined,
    records: journal.attention,
    cliRun: (id) => runs.service.get(id),
    composerRun: (id) => composer.get(id),
  });
  registerUsageServing(registrar, usageServiceDeps(journal, composer));
  // axis.integrations/1 list, status and read (PV-N1f read slice): with no backend nothing is revealed, sent or audited.
  const { backend } = ctx.integrations;
  registerIntegrationsServing(registrar, {
    service: createIntegrationsService({
      vault: integrationsVault(backend),
      sender: ctx.integrations.sender,
      redactor: services.redactor,
      audit: { append: (e) => (audit.append(e), services.anchors.noteWrite()) },
      now: () => ports.clock.monotonic(),
    }),
    journal,
    gate,
    now: () => ports.clock.monotonic(),
  });
}
