// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import type { Journal } from "@axis/journal";
import { CLI_RUNS_CONTRACT, CLI_RUNS_VERSION, MAX_CLI_RUNS_LIST, type CliRun, type CliRunsMethod, type CliRunsRequest } from "@axis/protocol";
import { resolveCliAgentsSetting } from "@axis/pty-policy";
import type { ControlClient } from "../control/client.js";
import type { RunSummary, RunTrustMinter, RunsService } from "../ports/runs.js";
import { runFailure, toRunError } from "../runs/errors.js";
import type { HandlerRegistrar } from "./anchor-guard.js";
import type { ProjectMutex } from "../worktrees/project-mutex.js";

/**
 * `axis.cli-runs/1` (design section 4.2): `start`, `stop`, `get`, `list` over the `RunsService` port. Nothing here touches a
 * path, a command line or the supervisor class. Who is calling comes from `ctx.identity` only; every method refuses any
 * actor but `user`, behind the policy row, with the same `E_NOT_FOUND` the other handlers use (a handler cannot raise
 * `E_POLICY_DENIED`). Every error is a `DaemonError` of fixed text (`toRunError`).
 *
 * `start` (tier 2, the EXT-2 amendment: the launch dialog carries the disclosure, there is no challenge) runs, under the
 * project mutex of the worktrees binding: the workspace is read from the journal (its project id comes from there, never
 * from the payload), the CLI entry is resolved from the user-scope `axis.cliAgents` setting main returns (a command line
 * is never taken from a payload), main is asked `trust.check` for this window, workspace and project (no answer in 2 s is a
 * refusal), and only then is the single-use attestation minted and passed to `start` in the same breath. The request's
 * idempotency key is passed to the supervisor, whose journal refuses a second run for it, so a retry after a failure that
 * left a row cannot start a second process. `start` is a write method: a call that throws while its signal is aborted
 * keeps its key as outcome-unknown (the daemon decides that, not this file), and a plain failure frees the key.
 */
export interface CliRunsHandlerDeps {
  readonly service: RunsService;
  readonly journal: Pick<Journal, "getWorkspace">;
  /** The control channel: main's live trust answer and the user-scope CLI definitions. */
  readonly control: Pick<ControlClient, "trustCheck" | "settingsGet">;
  readonly minter: RunTrustMinter;
  /** The project mutex of the worktrees binding (the same instance). */
  readonly mutex: Pick<ProjectMutex, "run">;
  /** True for a workspace the last reconcile reported (see `createWorktreesBinding`). Refuses `start`; `stop` always works. */
  readonly needsAttention?: (workspaceId: string, method?: string) => boolean;
  readonly platform?: NodeJS.Platform;
}

const DEFAULT_LIST = 200;

/** The wire shape of a run. `agentId` is not kept by the supervisor yet, so it is null. */
function wire(run: RunSummary): CliRun {
  return { ...run, agentId: null };
}

function cancelled(): DaemonError {
  return runFailure("E_CANCELLED");
}

export function createCliRunsHandlers(deps: CliRunsHandlerDeps): Readonly<Record<CliRunsMethod, Handler>> {
  const platform = deps.platform ?? process.platform;

  const guarded =
    <M extends CliRunsMethod>(call: (payload: CliRunsRequest<M>, context: HandlerContext) => Promise<unknown> | unknown): Handler =>
    async (context: HandlerContext, payload: never): Promise<unknown> => {
      if (context.signal.aborted) throw cancelled();
      // Defence in depth behind the policy row: only the user's own attested connection works with runs.
      if (context.identity.actor !== "user") throw runFailure("E_NOT_FOUND");
      try {
        return await call(payload as CliRunsRequest<M>, context);
      } catch (e) {
        throw toRunError(e);
      }
    };

  /** The user's `axis.cliAgents` entry, by id. Main returns only the user, application or machine value (CFG-1). */
  async function resolveAgent(agentId: string, signal: AbortSignal): Promise<unknown> {
    let value;
    try {
      value = await deps.control.settingsGet("axis.cliAgents", { signal });
    } catch (e) {
      signal.throwIfAborted();
      throw e instanceof DaemonError ? e : runFailure("E_UNAVAILABLE", "settings_unavailable");
    }
    const { agents } = resolveCliAgentsSetting({ user: value }, { platform });
    const agent = agents.find((a) => a.id === agentId);
    if (agent === undefined) throw runFailure("E_NOT_FOUND", "agent_unknown");
    return agent;
  }

  const start = guarded<"start">(async (req, context) => {
    const ws = deps.journal.getWorkspace(req.workspaceId);
    if (ws === undefined || ws.state === "REMOVED" || ws.state === "FAILED" || ws.state === "CREATING") throw runFailure("E_NOT_FOUND");
    if (deps.needsAttention?.(req.workspaceId, "start") === true) throw runFailure("E_UNAVAILABLE", "needs_attention");
    const agent = await resolveAgent(req.agentId, context.signal);
    return deps.mutex.run(
      ws.projectId,
      async () => {
        // Read again under the mutex: what a remove or finalise did while this call waited is what counts.
        const current = deps.journal.getWorkspace(req.workspaceId);
        if (current === undefined || current.projectId !== ws.projectId) throw runFailure("E_NOT_FOUND");
        const { windowId } = context.identity;
        try {
          await deps.control.trustCheck({ windowId, workspaceId: req.workspaceId, projectId: ws.projectId }, { signal: context.signal });
        } catch (e) {
          context.signal.throwIfAborted();
          throw e;
        }
        // Nothing has been changed so far, but a write method that throws while aborted keeps its key outcome-unknown (safe).
        if (context.signal.aborted) throw cancelled();
        const trust = deps.minter.attest({ workspaceId: req.workspaceId, projectId: ws.projectId });
        const out = await deps.service.start({
          workspaceId: req.workspaceId,
          agent,
          actor: "user",
          trust,
          ...(context.idempotencyKey === undefined ? {} : { idempotencyKey: context.idempotencyKey }),
        });
        return { run: wire(out.run), replayed: out.replayed };
      },
      context.signal,
    );
  });

  return {
    start,
    stop: guarded<"stop">((req) => ({ run: wire(deps.service.stop(req.runId, "user")) })),
    get: guarded<"get">((req) => ({ run: wire(deps.service.get(req.runId)) })),
    list: guarded<"list">((req) => {
      const limit = Math.min(req.limit ?? DEFAULT_LIST, MAX_CLI_RUNS_LIST);
      const runs = deps.service.list({ ...(req.workspaceId === undefined ? {} : { workspaceId: req.workspaceId }), limit });
      return { runs: runs.map(wire) };
    }),
  };
}

/** Register `axis.cli-runs/1` through the host's registrar (never the daemon itself). */
export function registerCliRunsHandlers(registrar: HandlerRegistrar, deps: CliRunsHandlerDeps): void {
  registrar.register(CLI_RUNS_CONTRACT, CLI_RUNS_VERSION, createCliRunsHandlers(deps));
}
