// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { AuditSink, Redactor } from "@axis/audit";
import { ABSENT, BROKER_PAYLOAD_ALLOWLIST, BrokerError, ToolBroker, callDigest, contentDigest, createCommandRunner, nodeBrokerFs, type ApprovalHook, type ApprovalRequest, type BrokerFs, type CommandRunner, type ContainDeps } from "@axis/broker";
import { MAX_APPROVAL_PATHS, toDisplayPath, type ApprovalPreview } from "@axis/protocol";
import { createSecretScanner } from "@axis/secret-scan";
import { createMockProvider, guardProvider, type GuardedProvider, type MockProviderOptions, type Redactor as ProviderRedactor } from "@axis/providers";
import { formatDriftNotice } from "../composer/drift.js";
import { buildApprovalPreview, type PreviewScanner } from "../composer/preview.js";
import type { RunSnapshotter } from "@axis/runs";
import { ObservedFiles } from "./agent-observed.js";
import { RUN_COMMAND, RUN_COMMAND_SPEC, commandLimits, commandOf, commandTool, runCommandArgs, type CommandLimits, type RunCommandArgs } from "./agent-command.js";
import type { RunApprovals } from "../gate/run-approvals.js";
import { ComposerRunHalt, type ComposerApprovalNote, type ComposerEngine, type ComposerRunContext, type ComposerRunTools, type ComposerToolSpec } from "../ports/composer.js";
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
 *   only when the host gave the WT-2 snapshotter (`commandSnapshotter`); shutdown kills what the shared runner started.
 * - **Providers.** The mock, guarded (`guardProvider`: validation, outgoing secret scan with the host redactor, timeouts,
 *   stream grammar, the run budget). The Anthropic adapter comes with the vault in `bindings/providers.ts` (ticket C6).
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
   * WT-2, broker side (C3): GIT-SNAP-1 before and after every command a run starts (its own instance, not the CLI runs').
   * Absent: `run_command` is not offered at all.
   */
  readonly commandSnapshotter?: RunSnapshotter;
  /** Bounds of one command (timeout, output cap, what the model sees). Default `DEFAULT_COMMAND_LIMITS`. */
  readonly commandLimits?: Partial<CommandLimits>;
}

/** The broker's audit payload keys (`broker.decision`: approver, approval id, expiry; `broker.result`), for the host's `AuditLog` (DMN-5). */
export const AGENT_PAYLOAD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = BROKER_PAYLOAD_ALLOWLIST;

export interface AgentBinding extends ComposerEngine {
  /** Every registered guarded provider: the one list `axis.providers/1.list` and `provider()` both answer from (C5). */
  providers(): readonly GuardedProvider[];
  /** Kill any process a tool started (shutdown). */
  dispose(): void;
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
    description: "Create or replace a UTF-8 text file of the workspace. The path is relative to the workspace root. To replace a file, set `base` to the digest your last read_file or write_file of it returned; to create one, omit `base` (or set it to `absent`). The write is refused (stale) if the file changed since: read it again.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, base: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
  },
]);

/** The registered tools' argument schemas (the broker parses with the same ones) and the content each call writes. */
const PREVIEWED: ReadonlyMap<string, { readonly args: z.ZodType; readonly content: (args: never) => string | undefined }> = new Map([
  ["read_file", { args: readArgs, content: () => undefined }],
  ["write_file", { args: writeArgs, content: (a: z.infer<typeof writeArgs>) => a.content }],
  [RUN_COMMAND, { args: runCommandArgs, content: () => undefined }],
]);
/** The broker tiers a command may be approved at: anything lower means the table was bypassed (fail closed). */
const COMMAND_TIERS: ReadonlySet<string> = new Set(["destructive", "privileged"]);

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

/** The host's audit redactor as the providers' redaction hook (PRV-2): anything it would change counts as a secret. */
function providerRedactor(r: Redactor): ProviderRedactor {
  return { redact: (t) => r.redactString(t), containsSecret: (t) => r.redactString(t) !== t };
}

export function createAgentBinding(deps: AgentBindingDeps): AgentBinding {
  const platform = deps.platform ?? process.platform;
  const brokerFs = deps.wrapFs?.(nodeBrokerFs) ?? nodeBrokerFs;
  const runner: CommandRunner = createCommandRunner({ platform });
  const scanner = deps.previewScanner ?? defaultPreviewScanner();
  const limits = commandLimits(deps.commandLimits);
  const providers = new Map<string, GuardedProvider>([["mock", guardProvider(createMockProvider(deps.mock ?? {}), { redactor: providerRedactor(deps.redactor) })]]);

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
        const call = covered(req);
        const spec = PREVIEWED.get(req.tool);
        // Fail closed: no preview bound to this digest, no challenge (the broker records the decline). The digest covers the
        // actor and the worktree, so a match is already this run's own call in this worktree.
        if (call === undefined || spec === undefined) return { approved: false };
        // A command is previewed from the broker's own line (program and interpreter as pinned), only at tier 4.
        const command = req.tool === RUN_COMMAND ? commandOf(req, call.args as RunCommandArgs) : undefined;
        if (req.tool === RUN_COMMAND && (command === undefined || !COMMAND_TIERS.has(req.tier))) return { approved: false };
        const preview = await buildApprovalPreview(
          { tier: req.tier, reasons: req.reasons, content: spec.content(call.args as never), ...(command === undefined ? {} : { command }) },
          { scanner, redact: (t) => deps.redactor.redactString(t) },
        );
        // A protected write (WT-3) is put to the user only when the head shows the whole content: a payload past the head,
        // a secret (the head is then redacted) or a scan that could not complete is never approved blind (review c2 S1). A call
        // cancelled during the preview is refused by `approvals.request`, which issues nothing for an aborted signal.
        if (preview === undefined || !shownWhole(preview)) return { approved: false };
        const base = {
          tool: req.tool,
          reasons: req.reasons.filter((r) => LABEL.test(r)).slice(0, 16),
          paths: req.operations.slice(0, MAX_APPROVAL_PATHS).filter((o) => o.path.length > 0).map((o) => ({ access: o.access, path: toDisplayPath(o.path, 512) })),
        };
        let digest: string | undefined;
        const note = (state: ComposerApprovalNote["state"]): void => {
          if (digest !== undefined) run.onApproval({ ...base, state, digest, preview: state === "requested" ? preview : null });
        };
        const out = await deps.approvals.request(
          { runId: run.runId, windowId: run.windowId, tool: req.tool, tier: req.tier, digest: req.digest, reasons: req.reasons, preview },
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
      ...(deps.extraProtected === undefined ? {} : { extraProtected: deps.extraProtected }),
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
    // WT-2: set once a command changed the repository's hooks or common dir; every later call of the run halts it.
    let halted = false;
    const snapshotter = deps.commandSnapshotter;
    if (snapshotter !== undefined) {
      broker.register(commandTool({
        runId: run.runId, workspaceId: worktree.id, worktree: { workTree: worktree.root, gitDir: worktree.gitDir },
        snapshotter, limits, redact: (t) => deps.redactor.redactString(t), writeLock: deps.writeLock, halt: () => void (halted = true),
      }));
    }
    const specs = snapshotter === undefined ? COMPOSER_TOOLS : Object.freeze([...COMPOSER_TOOLS, RUN_COMMAND_SPEC]);
    return {
      specs,
      drift: async (signal) => formatDriftNotice(await observed.drift(signal)),
      async invoke(name, input, signal) {
        if (halted) throw new ComposerRunHalt("GIT_DRIFT");
        const parsed = PREVIEWED.get(name)?.args.safeParse(input);
        const call = parsed?.success === true ? { tool: name, args: parsed.data } : undefined;
        // The loop runs one call at a time; a caller that floods the broker is refused before anything is held.
        if (inflight.size >= MAX_INFLIGHT_CALLS) return { ok: false, reason: "too_many_calls", content: "The call was refused (too_many_calls)." };
        if (call !== undefined) inflight.add(call);
        try {
          const out = await broker.invoke({ tool: name, worktreeId: worktree.id, actor, args: input, signal });
          if (halted) throw new ComposerRunHalt("GIT_DRIFT");
          return { ok: true, content: typeof out === "string" ? out : "done" };
        } catch (e) {
          if (halted) throw new ComposerRunHalt("GIT_DRIFT");
          // The action ran but its audit row could not be written: the run must stop (never continue unrecorded).
          if (e instanceof BrokerError && e.details["executed"] === true) throw new Error("unrecorded side effect");
          const reason = reasonOf(e);
          if (reason === "swapped") return { ok: false, reason, content: SWAPPED_RESULT };
          const hint = reason === "stale" ? " The file changed since you last read it: read it again before writing." : "";
          return { ok: false, reason, content: `The call was refused (${reason}).${hint}` };
        } finally {
          if (call !== undefined) inflight.delete(call);
        }
      },
    };
  }

  return {
    provider: (providerId) => providers.get(providerId),
    providers: () => [...providers.values()],
    prepare,
    dispose: () => void runner.killAll(),
  };
}
