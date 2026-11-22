// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import type { Journal } from "@axis/journal";
import { CLI_RUNS_CONTRACT, CLI_RUNS_VERSION, MAX_CLI_RUNS_LIST, type CliRun, type CliRunsMethod, type CliRunsRequest } from "@axis/protocol";
import { resolveCliAgentsSetting } from "@axis/pty-policy";
import type { ControlClient } from "../control/client.js";
import type { RunSummary, RunTrustMinter, RunsService } from "../ports/runs.js";
import { runFailure, toRunError } from "../runs/errors.js";
import { projectGated, type ProjectTrustGate } from "../gate/project-trust.js";
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
 * is never taken from a payload), the project trust gate admits this window, workspace and project (T1 to T4, main's
 * `trust.check` among them) and its single-use ticket is spent by the minter, and only then is the attestation passed to
 * `start` in the same breath. `axis.agents/1.start` (PV-G4) runs the same path (`startCliRun`) with the agent's home and
 * entry, so the gate and the ticket apply to it alike. The request's
 * idempotency key is passed to the supervisor, whose journal refuses a second run for it, so a retry after a failure that
 * left a row cannot start a second process. `start` is a write method: a call that throws while its signal is aborted
 * keeps its key as outcome-unknown (the daemon decides that, not this file), and a plain failure frees the key.
 */
export interface CliRunsHandlerDeps {
  readonly service: RunsService;
  readonly journal: Pick<Journal, "getWorkspace">;
  /** The control channel: main's live trust answer and the user-scope CLI definitions. */
  readonly control: Pick<ControlClient, "settingsGet">;
  /** The project trust gate (T1 to T4); its ticket is spent by `minter.attest`. */
  readonly gate: ProjectTrustGate;
  readonly minter: RunTrustMinter;
  /** The project mutex of the worktrees binding (the same instance). */
  readonly mutex: Pick<ProjectMutex, "run">;
  /** True for a workspace the last reconcile reported (see `createWorktreesBinding`). Refuses `start`; `stop` always works. */
  readonly needsAttention?: (workspaceId: string, method?: string) => boolean;
  readonly platform?: NodeJS.Platform;
}

/** What a CLI run start needs: the workspace, the `axis.cliAgents` entry id, and the Axis agent record it runs for (PV-G4). */
export interface CliStart {
  readonly workspaceId: string;
  readonly entryId: string;
  readonly worker?: string;
  /** Re-checked under the project mutex, after the workspace is read again and before the trust gate: throws to refuse. */
  readonly recheck?: () => void;
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

  const start = guarded<"start">((req, context) => startCliRun(deps, { workspaceId: req.workspaceId, entryId: req.agentId }, context).then((out) => ({ run: wire(out.run), replayed: out.replayed })));

  return {
    start: projectGated(start),
    stop: guarded<"stop">((req) => ({ run: wire(deps.service.stop(req.runId, "user")) })),
    get: guarded<"get">((req) => ({ run: wire(deps.service.get(req.runId)) })),
    list: guarded<"list">((req) => {
      const limit = Math.min(req.limit ?? DEFAULT_LIST, MAX_CLI_RUNS_LIST);
      const runs = deps.service.list({ ...(req.workspaceId === undefined ? {} : { workspaceId: req.workspaceId }), limit });
      return { runs: runs.map(wire) };
    }),
  };
}

/**
 * A CLI run start, shared by `axis.cli-runs/1.start` and `axis.agents/1.start` (PV-G4): the workspace from the journal, the
 * entry from user-scope settings, then under the project mutex the agent's recheck, the project trust gate for the run's
 * workspace and project (its single-use ticket spent by the minter: both paths alike), the attestation and the supervisor.
 * Throws the run errors of `runs/errors.ts` and the gate's refusal.
 */
export async function startCliRun(deps: CliRunsHandlerDeps, req: CliStart, context: HandlerContext): Promise<{ run: RunSummary; replayed: boolean }> {
  const platform = deps.platform ?? process.platform;
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

  {
    const ws = deps.journal.getWorkspace(req.workspaceId);
    if (ws === undefined || ws.state === "REMOVED" || ws.state === "FAILED" || ws.state === "CREATING") throw runFailure("E_NOT_FOUND");
    if (deps.needsAttention?.(req.workspaceId, "start") === true) throw runFailure("E_UNAVAILABLE", "needs_attention");
    const agent = await resolveAgent(req.entryId, context.signal);
    return deps.mutex.run(
      ws.projectId,
      async () => {
        // Read again under the mutex: what a remove or finalise did while this call waited is what counts.
        const current = deps.journal.getWorkspace(req.workspaceId);
        if (current === undefined || current.projectId !== ws.projectId) throw runFailure("E_NOT_FOUND");
        req.recheck?.();
        const { windowId } = context.identity;
        let ticket: unknown;
        try {
          ticket = await deps.gate.admit({ projectId: ws.projectId, windowId, workspaceId: req.workspaceId, signal: context.signal });
        } catch (e) {
          context.signal.throwIfAborted();
          throw e;
        }
        // Nothing has been changed so far, but a write method that throws while aborted keeps its key outcome-unknown (safe).
        if (context.signal.aborted) throw cancelled();
        const trust = deps.minter.attest({ workspaceId: req.workspaceId, projectId: ws.projectId }, ticket);
        const out = await deps.service.start({
          workspaceId: req.workspaceId,
          agent,
          actor: "user",
          trust,
          ...(context.idempotencyKey === undefined ? {} : { idempotencyKey: context.idempotencyKey }),
          ...(req.worker === undefined ? {} : { worker: req.worker }),
        });
        return out;
      },
      context.signal,
    );
  }
}

/** Register `axis.cli-runs/1` through the host's registrar (never the daemon itself). */
export function registerCliRunsHandlers(registrar: HandlerRegistrar, deps: CliRunsHandlerDeps): void {
  registrar.register(CLI_RUNS_CONTRACT, CLI_RUNS_VERSION, createCliRunsHandlers(deps));
}
