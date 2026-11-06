// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { AuditSink, Redactor } from "@axis/audit";
import { BROKER_PAYLOAD_ALLOWLIST, BrokerError, ToolBroker, createCommandRunner, nodeBrokerFs, type ApprovalHook, type ApprovalRequest, type CommandRunner } from "@axis/broker";
import { MAX_APPROVAL_PATHS, toDisplayPath } from "@axis/protocol";
import { createMockProvider, guardProvider, type GuardedProvider, type MockProviderOptions, type Redactor as ProviderRedactor } from "@axis/providers";
import type { RunApprovals } from "../gate/run-approvals.js";
import type { ComposerApprovalNote, ComposerEngine, ComposerRunContext, ComposerRunTools, ComposerToolSpec } from "../ports/composer.js";
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
 *   containment and WT-3 protected paths apply at decision and at use. No command or git tool yet (ticket C3): no child
 *   process is started by a composer run, and the shared runner exists only so shutdown can kill one if C3 adds it.
 * - **Providers.** The mock, guarded (`guardProvider`: validation, outgoing secret scan with the host redactor, timeouts,
 *   stream grammar, the run budget). The Anthropic adapter comes with the vault in `bindings/providers.ts` (ticket C6).
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
}

/** The broker's audit payload keys (`broker.decision`: approver, approval id, expiry; `broker.result`), for the host's `AuditLog` (DMN-5). */
export const AGENT_PAYLOAD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = BROKER_PAYLOAD_ALLOWLIST;

export interface AgentBinding extends ComposerEngine {
  /** Kill any process a tool started (shutdown). */
  dispose(): void;
}

export const MAX_READ_BYTES = 262_144;
export const MAX_WRITE_BYTES = 1_048_576;
const pathArg = z.string().min(1).max(1024);
const readArgs = z.strictObject({ path: pathArg });
const writeArgs = z.strictObject({ path: pathArg, content: z.string().max(MAX_WRITE_BYTES) });

export const COMPOSER_TOOLS: readonly ComposerToolSpec[] = Object.freeze([
  {
    name: "read_file",
    description: "Read a UTF-8 text file of the workspace. The path is relative to the workspace root.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "write_file",
    description: "Create or replace a UTF-8 text file of the workspace. The path is relative to the workspace root.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
  },
]);

const LABEL = /^[a-z][a-z0-9:._-]{0,63}$/;
/** A broker reason (`approval-declined`) as a wire reason code (`approval_declined`). */
const reasonOf = (e: unknown): string => (e instanceof BrokerError ? e.reason.replace(/-/g, "_") : "tool_failed");

/** The host's audit redactor as the providers' redaction hook (PRV-2): anything it would change counts as a secret. */
function providerRedactor(r: Redactor): ProviderRedactor {
  return { redact: (t) => r.redactString(t), containsSecret: (t) => r.redactString(t) !== t };
}

export function createAgentBinding(deps: AgentBindingDeps): AgentBinding {
  const platform = deps.platform ?? process.platform;
  const runner: CommandRunner = createCommandRunner({ platform });
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
    const hook: ApprovalHook = {
      async request(req: ApprovalRequest, signal: AbortSignal): Promise<unknown> {
        const base = {
          tool: req.tool,
          reasons: req.reasons.filter((r) => LABEL.test(r)).slice(0, 16),
          paths: req.operations.slice(0, MAX_APPROVAL_PATHS).filter((o) => o.path.length > 0).map((o) => ({ access: o.access, path: toDisplayPath(o.path, 512) })),
        };
        let digest: string | undefined;
        const note = (state: ComposerApprovalNote["state"]): void => {
          if (digest !== undefined) run.onApproval({ ...base, state, digest });
        };
        const out = await deps.approvals.request(
          { runId: run.runId, windowId: run.windowId, tool: req.tool, tier: req.tier, digest: req.digest, reasons: req.reasons },
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
      registry: { get: (id) => (id === worktree.id ? worktree : undefined), repositoryRoots: () => repos },
      fs: nodeBrokerFs,
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
      run: async (ctx, a) => (await ctx.readFile(a.path, MAX_READ_BYTES)).toString("utf8"),
    });
    broker.register({
      name: "write_file",
      tier: "write",
      args: writeArgs,
      targets: (a) => [{ path: a.path, access: "write" }],
      run: async (ctx, a) => {
        const data = Buffer.from(a.content, "utf8");
        await ctx.writeFile(a.path, data, { mode: "upsert", maxBytes: MAX_WRITE_BYTES });
        return `wrote ${data.length} bytes`;
      },
    });
    return {
      specs: COMPOSER_TOOLS,
      async invoke(name, input, signal) {
        try {
          const out = await broker.invoke({ tool: name, worktreeId: worktree.id, actor, args: input, signal });
          return { ok: true, content: typeof out === "string" ? out : "done" };
        } catch (e) {
          // The action ran but its audit row could not be written: the run must stop (never continue unrecorded).
          if (e instanceof BrokerError && e.details["executed"] === true) throw new Error("unrecorded side effect");
          const reason = reasonOf(e);
          return { ok: false, reason, content: `The call was refused (${reason}).` };
        }
      },
    };
  }

  return {
    provider: (providerId) => providers.get(providerId),
    prepare,
    dispose: () => void runner.killAll(),
  };
}
