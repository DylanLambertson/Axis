// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { AuditSink, Redactor } from "@axis/audit";
import { ABSENT, BROKER_PAYLOAD_ALLOWLIST, BrokerError, ToolBroker, callDigest, contentDigest, createCommandRunner, nodeBrokerFs, type ApprovalHook, type ApprovalRequest, type BrokerFs, type CommandRunner, type ContainDeps, type ToolDefinition } from "@axis/broker";
import { MAX_APPROVAL_PATHS, toDisplayPath, type ApprovalPreview } from "@axis/protocol";
import { createNodeRunner, type GitRunner } from "@axis/git-ops";
import { createSecretScanner } from "@axis/secret-scan";
import { createMockProvider, guardProvider, type GuardedProvider, type MockProviderOptions } from "@axis/providers";
import { formatDriftNotice } from "../composer/drift.js";
import { buildApprovalPreview, type PreviewScanner } from "../composer/preview.js";
import { createRunTaint, type TaintStore } from "../composer/taint.js";
import { ObservedFiles } from "./agent-observed.js";
import { GIT_DIFF, GIT_STATUS, GIT_TOOL_SPECS, gitDiffArgs, gitReadRunnerOptions, gitStatusArgs, gitTools } from "./agent-git.js";
import { providerRedactor } from "./provider-redactor.js";
import { PAGE_TOOL_SPECS, PageRead, WRITE_PAGE, pageTools, pagesReason, writePageArgs, writePagePreview } from "./agent-pages.js";
import type { PagesService } from "../pages/service.js";
import { MESSAGE_TOOL_SPECS, MessagesRead, READ_MESSAGES, SEND_MESSAGE, messageTools, messagingReason, readMessagesArgs, sendMessageArgs, sendPreview } from "./agent-messages.js";
import { createComposerMessaging, raisedHop, type ComposerMessagingDeps } from "../messages/participation.js";
import { RUN_COMMAND, RUN_COMMAND_SPEC, RunWt2, approvableCommand, commandLimits, commandTool, runCommandArgs, type CommandLimits, type RunCommandArgs } from "./agent-command.js";
import type { RunApprovals } from "../gate/run-approvals.js";
import { ComposerRunHalt, type ComposerApprovalNote, type ComposerEngine, type ComposerRunContext, type ComposerRunTools, type ComposerToolSpec, type RunRepositoryGuard } from "../ports/composer.js";
import type { WorktreeLocator } from "../ports/worktree-locator.js";

/**
 * The composer engine over `@axis/broker` and the guarded providers (docs/design/composer-runtime.md section 4). This is
 * the ONLY file that imports `@axis/broker` (`test/packages/imports.test.mjs`: `src/bindings/*.ts`).
 *
 * - **Roots (DMN-2).** The worktree comes from the host's `WorktreeLocator` (journal, never a payload) and is resolved to
 *   its real path when the run is prepared; the broker's registry answers that one workspace and nothing else, and the
 *   broker checks at every use that the root still resolves there and is not inside a registered repository.
 * - **One broker per run.** Its approval hook knows the run and the window that started it (`gate/run-approvals.ts`), so
 *   an approval is always the run's own; its ledger refuses a replayed grant.
 * - **Tools (C1).** `read_file` (tier `read`) and `write_file` (tier `write`), each declaring its one path, so WT-1
 *   containment and WT-3 protected paths apply at decision and at use. `run_command` (C3, `agent-command.ts`) is offered
 *   only when the host gave the WT-2 guard (`commandGuard`); shutdown kills what the shared runner started. `git_status` and
 *   `git_diff` (C3 slice 2, `agent-git.ts`, tier `read`) are offered when the host gave its git (`gitPath`): the broker's git,
 *   checked by the run's WT-2 guard before git starts. `send_message` and `read_messages` (PV-M4, `agent-messages.ts`) are
 *   offered only to a run whose agent the host's messaging knows (`messaging.agentOf`): none until PV-G4.
 * - **Providers.** The mock, guarded (`guardProvider`: validation, outgoing secret scan with the host redactor, timeouts,
 *   stream grammar, the run budget), and the network providers `bindings/providers.ts` builds over the vault (C6).
 * - **Approval preview (C8).** Each call's parsed arguments are held while the broker decides; when the broker asks, the
 *   hook recomputes the broker's digest (`callDigest`) from those arguments and the request, and builds the preview
 *   (`composer/preview.ts`) only from the arguments whose digest is the one the challenge is bound to. No match, or no
 *   preview, declines the call before any challenge exists: the user never answers for content they were not shown.
 * - **Compare-and-swap writes (C2, policies section 3.3).** `read_file` answers with the content's digest on its first
 *   line; `write_file` names the digest it replaces as `base` (`absent`, the default, for a new file), which must be the
 *   one this run last saw for that file (any other is `stale`, so a predicted digest replaces nothing). The broker writes
 *   only if the file still holds that content (`swapContained`), under the workspace's write lock (`writeLock`: the
 *   project mutex that Axis git operations take), and otherwise refuses `stale` with nothing written. Axis never merges.
 * - **Drift (C2, policies section 3.4).** The digests a run saw are kept (`agent-observed.ts`); before each model turn
 *   after the first, `drift()` lists the paths that changed outside the run since, as an untrusted-labelled notice.
 * - **Taint (IAC-T, PV-M0).** Each run has one sticky taint flag (`composer/taint.ts`). The broker asks it for every call
 *   (its decision hook, over any floor); a producer of a listed source taints the run BEFORE its result is returned, so
 *   the next call of the same reply is decided tainted. An approval card of a tainted run lists the sources, and the flag
 *   is bound into the challenge at issue and read again at consume (`gate/run-approvals.ts`).
 * - **What the model gets back.** File text, or a refusal word from the broker's closed set: never a path the broker
 *   resolved, an error message or a stack.
 */

export interface AgentBindingDeps {
  readonly locator: WorktreeLocator;
  /** Canonical roots of the registered repositories (the local checkouts): a worktree inside one is refused. */
  readonly repositoryRoots: () => readonly string[];
  readonly audit: AuditSink;
  readonly redactor: Redactor;
  /** The host's environment: the base of every tool child's PTY-2 environment. */
  readonly env: () => Readonly<Record<string, string | undefined>>;
  readonly approvals: RunApprovals;
  readonly now: () => number;
  readonly platform?: NodeJS.Platform;
  /** The mock provider's script (tests and the UI fixtures). Default: echo. */
  readonly mock?: MockProviderOptions;
  /** The network providers (`bindings/providers.ts`, already guarded). A provider id registered twice refuses the build. */
  readonly providers?: readonly GuardedProvider[];
  /** More protected paths (WT-3), from the host's private settings. */
  readonly extraProtected?: readonly (readonly string[])[];
  /** The secret scan of approval previews. Default: `@axis/secret-scan` in `refuse` mode over plain text. */
  readonly previewScanner?: PreviewScanner;
  /**
   * The workspace's write lock (policies 3.3 and 6.1): runs `fn` holding the lock Axis git operations take for this
   * workspace, waiting for it like any other caller. Every composer write runs inside it.
   */
  readonly writeLock: <T>(workspaceId: string, fn: () => Promise<T>, signal: AbortSignal) => Promise<T>;
  /** Wraps the file system the broker and the drift re-read use (tests inject races through it). Default: none. */
  readonly wrapFs?: (real: BrokerFs) => BrokerFs;
  /**
   * The taint sources among the tools' results (IAC-T): a receipt of the closed list for a successful call, or undefined.
   * No registered tool is a source yet, so the host passes none; tests use it as the test source, and the later tickets'
   * tools (PV-M4, PV-Q1, PV-T1) taint the run the same way, before their result is returned.
   */
  readonly taintSources?: (tool: string, args: unknown) => unknown;
  /**
   * More broker tools for every run, registered after the built-in ones and WITHOUT a preview schema. The host passes none;
   * the tests use it for a source tool that has no preview schema (review pv-m0 r2 N1). They are not offered to the model.
   */
  readonly extraTools?: readonly ToolDefinition[];
  /** Where each run's taint is recorded and read back (IAC-T across a restart or resume): the journal's composer records. */
  readonly taintStore: TaintStore;
  /** Messages delivered into runs at turn boundaries (PV-M3 slice 2); absent, nothing is delivered. */
  readonly deliveries?: { next(runId: string, taint: { receive(input: unknown): void }): { readonly text: string; ack(): unknown; release(): unknown } | undefined };
  /**
   * WT-2, broker side (C3): GIT-SNAP-1 before and after every command a run starts (its own instance, not the CLI runs').
   * Absent: `run_command` is not offered at all.
   */
  readonly commandGuard?: RunRepositoryGuard;
  /**
   * The host's ONE absolute git (`HostServices.gitPath`) for `git_status` and `git_diff`, run by the broker's git over a
   * daemon-context node runner of `@axis/git-ops`. Absent: neither tool is offered.
   */
  readonly gitPath?: string;
  /** Bounds of one command (timeout, output cap, what the model sees). Default `DEFAULT_COMMAND_LIMITS`. */
  readonly commandLimits?: Partial<CommandLimits>;
  /**
   * A run's messaging (PV-M4): `send_message` and `read_messages` for a run whose agent it knows. Absent, or no agent for
   * the run (every run until PV-G4 records a run's agent), and neither tool is offered or registered.
   */
  readonly messaging?: Omit<ComposerMessagingDeps, "holdsSecret">;
  /** `read_page` and `write_page` (PV-Q1 slice 2): offered only to a run whose worker `workerOf` knows. */
  readonly pages?: { readonly service: PagesService; readonly workerOf: (runId: string) => { readonly agentId: string; readonly projectId: string } | undefined };
}

/** The broker's audit payload keys (`broker.decision`: approver, approval id, expiry; `broker.result`), for the host's `AuditLog` (DMN-5). */
export const AGENT_PAYLOAD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = BROKER_PAYLOAD_ALLOWLIST;

export interface AgentBinding extends ComposerEngine {
  /** Every registered guarded provider: the one list `axis.providers/1.list` and `provider()` both answer from (C5). */
  providers(): readonly GuardedProvider[];
  /** Kill any process a tool started (shutdown). */
  dispose(): void;
  /** `run_command` is offered: the host gave the WT-2 guard (C3). */
  readonly commands: boolean;
  /** `git_status` and `git_diff` are offered: the host gave its git (C3 slice 2). */
  readonly gitReads: boolean;
  /** The bounds every `run_command` of this binding runs under. */
  readonly commandLimits: CommandLimits;
}

export const MAX_READ_BYTES = 262_144;
/** Calls of one run inside the broker at once (each holds its parsed arguments for the approval preview). */
export const MAX_INFLIGHT_CALLS = 16;
export const MAX_WRITE_BYTES = 1_048_576;
const pathArg = z.string().min(1).max(1024);
const readArgs = z.strictObject({ path: pathArg });
const baseArg = z.union([z.literal(ABSENT), z.string().regex(/^sha256:[0-9a-f]{64}$/)]);
const writeArgs = z.strictObject({ path: pathArg, content: z.string().max(MAX_WRITE_BYTES), base: baseArg.optional() });

export const COMPOSER_TOOLS: readonly ComposerToolSpec[] = Object.freeze([
  {
    name: "read_file",
    description: "Read a UTF-8 text file of the workspace. The path is relative to the workspace root. The first line of the result is `digest: sha256:...`, the digest of the content; the file's text follows from the second line.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "write_file",
    description: "Create or replace a UTF-8 text file of the workspace. The path is relative to the workspace root. To replace a file, set `base` to the digest your last read_file or write_file of it returned; to create one, omit `base` (or set it to `absent`). The write is refused (stale) if the file changed since: read it again. Once this run has received untrusted input (messages and the like), a write needs the user's approval and the user must be able to read all of it: content past 2,048 units counted after escaping (about 2,000 plain characters), or holding a secret, is then refused as content_not_reviewable (a write replaces the whole file, so such a file cannot be written in that run: tell the user what to change).",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, base: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
  },
]);

/** The registered tools' argument schemas (the broker parses with the same ones) and the content each call writes. */
const PREVIEWED: ReadonlyMap<string, { readonly args: z.ZodType; readonly content: (args: never) => string | undefined }> = new Map([
  ["read_file", { args: readArgs, content: () => undefined }],
  ["write_file", { args: writeArgs, content: (a: z.infer<typeof writeArgs>) => a.content }],
  [RUN_COMMAND, { args: runCommandArgs, content: () => undefined }],
  [GIT_STATUS, { args: gitStatusArgs, content: () => undefined }],
  [GIT_DIFF, { args: gitDiffArgs, content: () => undefined }],
  [SEND_MESSAGE, { args: sendMessageArgs, content: sendPreview }],
  [READ_MESSAGES, { args: readMessagesArgs, content: () => undefined }],
]);
/** Tools that are never put to the user: a read the broker asks about (a path into the git directory) is refused, not declined. */
const NEVER_ASKED: ReadonlySet<string> = new Set([GIT_STATUS, GIT_DIFF]);
/** The preview shows its whole content: present, not cut at the head's bound, no finding hiding it. */
export const wholeText = (preview: ApprovalPreview): boolean => preview.content !== null && !preview.content.truncated && preview.content.findings.length === 0;
/** The user can judge the call from the preview: it writes nothing, or it is not protected, or its whole content is shown. */
export function shownWhole(preview: ApprovalPreview): boolean {
  const c = preview.content;
  return c === null || !preview.protected || (!c.truncated && c.findings.length === 0);
}

/** A scanner over plain text that fails closed (`refuse`: an incomplete scan throws). */
function defaultPreviewScanner(): PreviewScanner {
  const s = createSecretScanner({ mode: "refuse" });
  return { scan: async (text) => (await s.scan(text, { part: "message" })).map((f) => f.rule) };
}

/**
 * A `swapped` write is NOT a refusal: the parent directory was swapped for a symlink after the last check, and the bytes
 * may already be in the directory it now points to (`swapContained` item 5, detected afterwards, never undone).
 */
export const SWAPPED_RESULT =
  "The call failed (swapped): a folder of the path was replaced while the file was being written, and the write may have landed outside the workspace. Tell the user; do not retry.";

const LABEL = /^[a-z][a-z0-9:._-]{0,63}$/;
/** A broker reason (`approval-declined`) as a wire reason code (`approval_declined`). */
const reasonOf = (e: unknown): string => (e instanceof BrokerError ? e.reason.replace(/-/g, "_") : "tool_failed");

/**
 * The taint receipt of a successful call (IAC-T, review pv-m0 S1). Asked for EVERY call the broker ran, not only the ones
 * with a preview schema: a source tool that is registered without one still taints. The arguments are the parsed ones when
 * the call has a preview schema, else the raw input the broker accepted.
 */
export function taintReceiptOf(sources: AgentBindingDeps["taintSources"], tool: string, call: { readonly args: unknown } | undefined, input: unknown): unknown {
  return sources?.(tool, call === undefined ? input : call.args);
}

export function createAgentBinding(deps: AgentBindingDeps): AgentBinding {
  const platform = deps.platform ?? process.platform;
  const brokerFs = deps.wrapFs?.(nodeBrokerFs) ?? nodeBrokerFs;
  const runner: CommandRunner = createCommandRunner({ platform });
  const scanner = deps.previewScanner ?? defaultPreviewScanner();
  const limits = commandLimits(deps.commandLimits);
  // One runner for every run's git reads: the host's git only (never looked up), its output bounded for the model.
  const gitRunner: GitRunner | undefined = deps.gitPath === undefined ? undefined : createNodeRunner(gitReadRunnerOptions(deps.gitPath, deps.env()));
  const outgoing = providerRedactor(deps.redactor);
  const providers = new Map<string, GuardedProvider>([["mock", guardProvider(createMockProvider(deps.mock ?? {}), { redactor: outgoing })]]);
  // A read never returns a body the providers' outgoing check would refuse (a secret): it is withheld instead.
  const runMessaging = deps.messaging === undefined ? undefined : createComposerMessaging({ ...deps.messaging, holdsSecret: (t) => outgoing.containsSecret(t) });
  for (const p of deps.providers ?? []) {
    if (providers.has(p.descriptor.providerId)) throw new Error("provider registered twice");
    providers.set(p.descriptor.providerId, p);
  }

  const roots = async (): Promise<string[]> => {
    const out: string[] = [];
    for (const p of deps.repositoryRoots()) {
      try {
        out.push(await realpath(p));
      } catch {
        out.push(p); // a vanished checkout cannot contain a worktree; keep its recorded path all the same
      }
    }
    return out;
  };

  async function prepare(workspaceId: string): Promise<(run: ComposerRunContext) => ComposerRunTools> {
    const ref = await deps.locator.locate(workspaceId);
    const root = await realpath(ref.workTree);
    const repos = await roots();
    return (run) => tools(run, { id: workspaceId, root, gitDir: ref.gitDir }, repos);
  }

  function tools(run: ComposerRunContext, worktree: { id: string; root: string; gitDir: string }, repos: readonly string[]): ComposerRunTools {
    const actor = `agent:composer.${run.runId}`;
    const contain: ContainDeps = {
      registry: { get: (id) => (id === worktree.id ? worktree : undefined), repositoryRoots: () => repos },
      fs: brokerFs,
      platform,
      ...(deps.extraProtected === undefined ? {} : { extraProtected: deps.extraProtected }),
    };
    const observed = new ObservedFiles(contain, worktree.id, MAX_WRITE_BYTES);
    const taint = createRunTaint({ runId: run.runId, store: deps.taintStore, audit: deps.audit, now: deps.now });
    // Section 7.3: the highest hop this run has received through any taint source (a delivery, a read, a test source). Every
    // receipt raises it first, then taints, so a later send of the run carries it; held for the run's life (a run does not
    // survive a restart). The run's agent is fixed when its tools are built: messaging is offered only when it is known.
    let receivedHop = 0;
    const received = {
      receive(input: unknown): void {
        receivedHop = raisedHop(receivedHop, typeof input === "object" && input !== null ? (input as { hop?: unknown }).hop : undefined);
        taint.receive(input);
      },
    };
    const agentId = runMessaging?.agentOf(run.runId);
    const worker = deps.pages?.workerOf(run.runId);
    const pageWho = () => ({ kind: "agent" as const, agentId: worker?.agentId as string, projectId: worker?.projectId as string, runId: run.runId, receivedHop });
    const previewed = worker === undefined || deps.pages === undefined ? PREVIEWED : new Map([...PREVIEWED, [WRITE_PAGE, { args: writePageArgs, content: writePagePreview(deps.pages.service, pageWho) as never }]]);
    // Calls inside the broker now, with their parsed arguments: the hook previews only the one whose digest it is asked for.
    const inflight = new Set<{ readonly tool: string; readonly args: unknown }>();
    const covered = (req: ApprovalRequest): { readonly tool: string; readonly args: unknown } | undefined => {
      const paths = req.operations.map((o) => `${o.access}:${o.path}`);
      for (const call of inflight) {
        if (call.tool !== req.tool) continue;
        try {
          if (callDigest({ tool: req.tool, worktreeId: req.worktreeId, actor: req.actor, tier: req.tier, paths, commands: req.commands, args: call.args }) === req.digest) return call;
        } catch {
          // arguments that cannot be canonicalised cover nothing
        }
      }
      return undefined;
    };
    const hook: ApprovalHook = {
      async request(req: ApprovalRequest, signal: AbortSignal): Promise<unknown> {
        // A command line the hook is shown cut (a program path that pushes the line past the broker's bound) can never be
        // matched to its call: refused with a closed reason, never declined as if the user had said no (review c3 r1 SF-3).
        if (req.tool === RUN_COMMAND && req.commandsTruncated) throw new BrokerError("E_INVALID_ARGUMENT", "invalid-command", "the command line is too long to be shown whole");
        if (NEVER_ASKED.has(req.tool)) throw new BrokerError("E_POLICY_DENIED", "protected-path", "a git read of the git directory is refused");
        const call = covered(req);
        const spec = previewed.get(req.tool);
        // Fail closed: no preview bound to this digest, no challenge (the broker records the decline). The digest covers the
        // actor and the worktree, so a match is already this run's own call in this worktree.
        if (call === undefined || spec === undefined) return { approved: false };
        // A command is previewed from the broker's own line (program and interpreter as pinned), only at tier 4.
        const command = req.tool === RUN_COMMAND ? approvableCommand(req, call.args as RunCommandArgs) : undefined;
        if (req.tool === RUN_COMMAND && command === undefined) return { approved: false };
        const preview = await buildApprovalPreview(
          { tier: req.tier, reasons: req.reasons, content: spec.content(call.args as never), ...(command === undefined ? {} : { command }) },
          { scanner, redact: (t) => deps.redactor.redactString(t) },
        );
        // A protected write (WT-3) is put to the user only when the head shows the whole content: a payload past the head,
        // a secret (the head is then redacted) or a scan that could not complete is never approved blind (review c2 S1). A call
        // cancelled during the preview is refused by `approvals.request`, which issues nothing for an aborted signal.
        // A message is judged by its whole text (PV-M4 review 1 B1): a send whose card cannot show all of it (past the head's
        // bound, or hidden by a scan finding) is REFUSED before any card exists, with its own reason, never put to the user on
        // its first 2,048 units and never recorded as the user's decline. A preview that could not be built at all is the same
        // refusal for a send (review 2 N2).
        if (req.tool === SEND_MESSAGE && (preview === undefined || !wholeText(preview))) throw new BrokerError("E_POLICY_DENIED", "body-not-reviewable", "the message cannot be shown whole for approval");
        // The same for a write to a file that is not protected: with the floor at `network` it is asked only in a tainted run
        // (IAC-T), and the user must see all of what is written, never its first 2,048 units. A protected write keeps C2's rule
        // below (declined unless shown whole); a preview that could not be built is this refusal too.
        if ((req.tool === "write_file" || req.tool === WRITE_PAGE) && (preview === undefined || (!preview.protected && !wholeText(preview)))) throw new BrokerError("E_POLICY_DENIED", "content-not-reviewable", "the content cannot be shown whole for approval");
        if (preview === undefined || !shownWhole(preview)) return { approved: false };
        // The card's sources, read with the flag the challenge binds: nothing awaits between here and its issue.
        const card = taint.card();
        const shown = card === undefined ? preview : { ...preview, taint: card };
        const base = {
          tool: req.tool,
          reasons: req.reasons.filter((r) => LABEL.test(r)).slice(0, 16),
          paths: req.operations.slice(0, MAX_APPROVAL_PATHS).filter((o) => o.path.length > 0).map((o) => ({ access: o.access, path: toDisplayPath(o.path, 512) })),
        };
        let digest: string | undefined;
        const note = (state: ComposerApprovalNote["state"]): void => {
          if (digest !== undefined) run.onApproval({ ...base, state, digest, preview: state === "requested" ? shown : null });
        };
        const out = await deps.approvals.request(
          { runId: run.runId, windowId: run.windowId, tool: req.tool, tier: req.tier, digest: req.digest, reasons: req.reasons, preview: shown, tainted: taint.tainted },
          signal,
          (challenge) => {
            digest = challenge.digest;
            note("requested");
          },
        );
        if (out.kind === "granted") {
          note("approved");
          return out.grant;
        }
        note(out.state === "refused" ? "withdrawn" : out.state);
        return { approved: false };
      },
    };
    // WT-2: one baseline for the run; once a check finds a change, every later call and turn of the run halts it.
    const guard = deps.commandGuard;
    const wt2 = guard === undefined ? undefined : new RunWt2({ runId: run.runId, workspaceId: worktree.id, worktree: { workTree: worktree.root, gitDir: worktree.gitDir }, guard, writeLock: deps.writeLock });
    const halted = (): boolean => wt2?.halted === true;
    // Ends a lock wait of a git read when the run ends.
    const life = new AbortController();
    const broker = new ToolBroker({
      registry: contain.registry,
      fs: brokerFs,
      audit: deps.audit,
      runner,
      parentEnv: deps.env,
      approval: hook,
      redactor: deps.redactor,
      clock: { now: deps.now },
      platform,
      // IAC-T: asked for every call after the tier policy; while the run is tainted every call above `read` needs the user.
      policy: { hook: taint },
      ...(deps.extraProtected === undefined ? {} : { extraProtected: deps.extraProtected }),
      ...(gitRunner === undefined ? {} : { gitRunner, assertNoDrift: async (_w, s) => wt2?.beforeRead(s === undefined ? life.signal : AbortSignal.any([life.signal, s])) }),
    });
    broker.register({
      name: "read_file",
      tier: "read",
      args: readArgs,
      targets: (a) => [{ path: a.path, access: "read" }],
      run: async (ctx, a) => {
        const at = await observed.locate(a.path); // before the read: a change during it is hashed again next turn
        const data = await ctx.readFile(a.path, MAX_READ_BYTES);
        let text: string;
        try {
          // Not lossy: text with U+FFFD in place of bad bytes, written back on this digest, would pass the compare-and-swap.
          text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
        } catch {
          throw new BrokerError("E_POLICY_DENIED", "not-text", "the file is not UTF-8 text");
        }
        const digest = contentDigest(data);
        if (at !== undefined) observed.record(a.path, at, digest, { wrote: false });
        return `digest: ${digest}\n${text}`;
      },
    });
    broker.register({
      name: "write_file",
      tier: "write",
      args: writeArgs,
      targets: (a) => [{ path: a.path, access: "write" }],
      run: async (ctx, a) => {
        const data = Buffer.from(a.content, "utf8");
        const base = a.base ?? ABSENT;
        // §3.3: the base is the hash THIS run last observed for the file, not any digest that happens to match it.
        if (base !== ABSENT && (await observed.seenBy(a.path)) !== base) throw new BrokerError("E_CONFLICT", "stale", "the base is not what the run last saw");
        const at = await observed.locate(a.path);
        const r = await deps.writeLock(worktree.id, () => ctx.swapFile(a.path, data, { base, maxBytes: MAX_WRITE_BYTES }), ctx.signal);
        if (at !== undefined) observed.record(a.path, at, r.digest, { wrote: true, lost: r.lostChange });
        // The residual window of section 3.3: a writer outside the lock changed the file in place and our rename replaced
        // it. That writer's content is gone and Axis cannot recover it (no run base could hold it); say so, never hide it.
        const lost = r.lostChange ? "\nWarning: the file was changed by someone else while it was being replaced; that change was overwritten." : "";
        return `wrote ${data.length} bytes\ndigest: ${r.digest}${lost}`;
      },
    });
    if (wt2 !== undefined) broker.register(commandTool({ wt2, workspaceId: worktree.id, platform, limits, redact: (t) => deps.redactor.redactString(t), writeLock: deps.writeLock }));
    for (const extra of deps.extraTools ?? []) broker.register(extra);
    if (gitRunner !== undefined) for (const t of gitTools({ redact: (t) => deps.redactor.redactString(t) })) broker.register(t as ToolDefinition);
    const messaging = agentId === undefined ? undefined : runMessaging;
    if (messaging !== undefined && agentId !== undefined) for (const t of messageTools({ messaging, who: () => ({ agentId, runId: run.runId, receivedHop }) })) broker.register(t);
    if (deps.pages !== undefined && worker !== undefined) for (const t of pageTools({ pages: deps.pages.service, who: pageWho })) broker.register(t);
    const specs = Object.freeze([...COMPOSER_TOOLS, ...(wt2 === undefined ? [] : [RUN_COMMAND_SPEC]), ...(gitRunner === undefined ? [] : GIT_TOOL_SPECS), ...(messaging === undefined ? [] : MESSAGE_TOOL_SPECS), ...(worker === undefined || deps.pages === undefined ? [] : PAGE_TOOL_SPECS)]);
    return {
      specs,
      drift: async (signal) => formatDriftNotice(await observed.drift(signal)),
      // IAC-T source 1: the pipeline taints this run through its own flag before the block is returned. A halted run
      // (WT-2) never gets here: the loop's guard ends it at the boundary before it asks for a delivery.
      ...(deps.deliveries === undefined ? {} : { deliver: async () => deps.deliveries?.next(run.runId, received) }),
      ...(wt2 === undefined ? {} : { guard: (signal: AbortSignal) => wt2.turn(signal) }),
      close: () => {
        life.abort();
        wt2?.close();
      },
      async invoke(name, input, signal) {
        if (halted()) throw new ComposerRunHalt(wt2?.haltReason ?? "GIT_DRIFT");
        const parsed = previewed.get(name)?.args.safeParse(input);
        const call = parsed?.success === true ? { tool: name, args: parsed.data } : undefined;
        // The loop runs one call at a time; a caller that floods the broker is refused before anything is held.
        if (inflight.size >= MAX_INFLIGHT_CALLS) return { ok: false, reason: "too_many_calls", content: "The call was refused (too_many_calls)." };
        if (call !== undefined) inflight.add(call);
        let out: unknown;
        try {
          out = await broker.invoke({ tool: name, worktreeId: worktree.id, actor, args: input, signal });
          // WT-2 (C3): a check that found a change halts the run; nothing the call returned reaches the model.
          if (halted()) throw new ComposerRunHalt(wt2?.haltReason ?? "GIT_DRIFT");
        } catch (e) {
          if (halted()) throw new ComposerRunHalt(wt2?.haltReason ?? "GIT_DRIFT");
          // The action ran but its audit row could not be written: the run must stop (never continue unrecorded).
          if (e instanceof BrokerError && e.details["executed"] === true) throw new Error("unrecorded side effect");
          const reason = messagingReason(e) ?? pagesReason(e) ?? reasonOf(e);
          if (reason === "swapped") return { ok: false, reason, content: SWAPPED_RESULT };
          const hint = reason === "stale" ? " The file changed since you last read it: read it again before writing." : "";
          return { ok: false, reason, content: `The call was refused (${reason}).${hint}` };
        } finally {
          if (call !== undefined) inflight.delete(call);
        }
        // IAC-T: a source taints the run BEFORE its result is returned. A throw stops the run with the result withheld
        // (the flag is already set when the receipt is bad or its audit row could not be written).
        // IAC-T source 2 (PV-M4): each message from an agent, a plugin or a CLI sender in a read raises the run's received hop
        // and taints the run, before the text is returned.
        // IAC-T source 4 (PV-Q1 slice 2): an untrusted page version raises the hop and taints the run before its text returns.
        if (out instanceof PageRead) {
          if (out.receipt !== undefined) received.receive(out.receipt);
          return { ok: true, content: out.text };
        }
        if (out instanceof MessagesRead) {
          for (const r of out.outcome.receipts) received.receive(r);
          return { ok: true, content: out.outcome.text };
        }
        const receipt = taintReceiptOf(deps.taintSources, name, call, input);
        if (receipt !== undefined) received.receive(receipt);
        return { ok: true, content: typeof out === "string" ? out : "done" };
      },
    };
  }

  return {
    provider: (providerId) => providers.get(providerId),
    providers: () => [...providers.values()],
    prepare,
    dispose: () => void runner.killAll(),
    commands: deps.commandGuard !== undefined,
    gitReads: gitRunner !== undefined,
    commandLimits: limits,
  };
}
