// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError, type HandlerContext } from "@axis/daemon";
import type { Journal } from "@axis/journal";
import type { AgentsRequest, AgentsResponse } from "@axis/protocol";
import type { CliStart } from "../handlers/cli-runs.js";
import type { ComposerStart } from "../handlers/composer-runs.js";
import type { RunSummary } from "../ports/runs.js";
import { toRunError } from "../runs/errors.js";
import { AgentRefusal } from "./service.js";

/*
 * `axis.agents/1.start` (ticket PV-G4 slice A; docs/design/agents-contract.md section 6). The daemon resolves everything
 * from the journal: the agent (live), its home workspace (READY, the agent's project) and its launch. A CLI agent's run goes
 * through the one CLI start path (`startCliRun`: the entry from user-scope settings, the trust decision, the single-use
 * attestation, the supervisor) with the agent recorded as the run's `agent_id`; the agent is checked live again under the
 * project mutex, and the v12 trigger refuses the insert otherwise. A composer agent's run goes through the one composer start
 * path (`startComposerRun`) with its stored mode and model, the provider serving its stored connection (resolved now and
 * again under the mutex; the record never changes), and the prompt of the request. A key removed from the vault after the
 * start is not checked here: the run then fails as any composer run does (a closed provider error), not the start.
 */

export interface AgentStartDeps {
  readonly journal: Pick<Journal, "agents" | "getWorkspace">;
  /** The CLI start path (`startCliRun` with the host's CLI run deps). */
  readonly startCli: (req: CliStart, context: HandlerContext) => Promise<{ readonly run: RunSummary; readonly replayed: boolean }>;
  /** The composer start path (`startComposerRun` with the host's composer run deps). */
  readonly startComposer: (req: ComposerStart, context: HandlerContext) => Promise<{ readonly run: { readonly runId: string }; readonly replayed: boolean }>;
  /** The provider id of the guarded provider serving a vault connection, or undefined when none does (an unknown or removed one). */
  readonly providerFor: (connection: string) => string | undefined;
}

const refuse = (code: "E_NOT_FOUND" | "E_CONFLICT" | "E_UNAVAILABLE", reason: string): never => {
  throw new AgentRefusal(code, reason);
};

/** A run start's closed reason (`runs/errors.ts`) as the contract's own, or undefined (then `E_INTERNAL`). */
const FROM_RUN: Readonly<Record<string, readonly ["E_CONFLICT" | "E_UNAVAILABLE", string]>> = {
  untrusted: ["E_CONFLICT", "untrusted_project"],
  attestation_expired: ["E_CONFLICT", "untrusted_project"],
  attestation_used: ["E_CONFLICT", "untrusted_project"],
  attestation_mismatch: ["E_CONFLICT", "untrusted_project"],
  agent_unknown: ["E_CONFLICT", "entry_unavailable"],
  agent_invalid: ["E_CONFLICT", "entry_unavailable"],
  executable_not_found: ["E_CONFLICT", "entry_unavailable"],
  executable_changed: ["E_CONFLICT", "entry_unavailable"],
  invalid_env: ["E_CONFLICT", "entry_unavailable"],
  active_run: ["E_CONFLICT", "busy"],
  busy: ["E_CONFLICT", "busy"],
  git_operation_active: ["E_CONFLICT", "busy"],
  run_limit: ["E_CONFLICT", "busy"],
  not_ready: ["E_CONFLICT", "home_unavailable"],
  needs_attention: ["E_CONFLICT", "home_unavailable"],
  worktree_unavailable: ["E_CONFLICT", "home_unavailable"],
  bad_worktree: ["E_CONFLICT", "home_unavailable"],
  settings_unavailable: ["E_UNAVAILABLE", "not_available"],
  // The composer path's reasons (`composer/errors.ts`).
  provider_unknown: ["E_CONFLICT", "connection_unavailable"],
  provider_unavailable: ["E_CONFLICT", "connection_unavailable"],
  model_unknown: ["E_CONFLICT", "model_unavailable"],
  shutting_down: ["E_UNAVAILABLE", "not_available"],
  snapshot_timeout: ["E_UNAVAILABLE", "not_available"],
  snapshot_failed: ["E_UNAVAILABLE", "not_available"],
  outcome_unknown: ["E_UNAVAILABLE", "not_available"],
};

function fromRunError(raw: unknown): never {
  if (raw instanceof AgentRefusal) throw raw;
  // The project trust gate's refusal and the supervisor's errors become the run errors first (`untrusted`, ...).
  const e = raw instanceof DaemonError ? raw : toRunError(raw);
  {
    const reason = e.details?.["reason"];
    const mapped = typeof reason === "string" && Object.hasOwn(FROM_RUN, reason) ? FROM_RUN[reason] : undefined;
    if (mapped !== undefined) refuse(mapped[0], mapped[1]);
    if (e.code === "E_NOT_FOUND") refuse("E_CONFLICT", "home_unavailable"); // the home went away while the start waited
    // The run limit (CLI: the supervisor's `RUN_LIMIT`; composer: too many active runs) is `E_BACKPRESSURE` with no reason.
    if (e.code === "E_BACKPRESSURE") refuse("E_CONFLICT", "busy");
  }
  throw e;
}

export function createAgentStart(deps: AgentStartDeps): (req: AgentsRequest<"start">, context: HandlerContext) => Promise<AgentsResponse<"start">> {
  const { journal } = deps;
  /** The agent live, its home READY and in its project: read now, and again under the mutex. */
  const resolve = (agentId: string) => {
    const agent = journal.agents.get(agentId);
    if (agent === undefined) return refuse("E_NOT_FOUND", "not_found");
    if (agent.archived) refuse("E_CONFLICT", "archived");
    const home = journal.getWorkspace(agent.homeWorkspaceId);
    if (home === undefined || home.state !== "READY") refuse("E_CONFLICT", "home_unavailable");
    if (home!.projectId !== agent.projectId) refuse("E_CONFLICT", "cross_project");
    return agent;
  };
  return async (req, context) => {
    const agent = resolve(req.agentId);
    if (agent.launch.kind === "composer") {
      if (req.input === undefined) throw new DaemonError("E_INVALID_ARGUMENT", "invalid payload");
      const launch = agent.launch;
      const providerOf = (connection: string): string => deps.providerFor(connection) ?? refuse("E_CONFLICT", "connection_unavailable");
      const providerId = providerOf(launch.connection);
      let started: { readonly run: { readonly runId: string }; readonly replayed: boolean };
      try {
        started = await deps.startComposer(
          {
            workspaceId: agent.homeWorkspaceId,
            mode: launch.mode,
            prompt: req.input.prompt,
            providerId,
            modelId: launch.modelId,
            worker: agent.id,
            // Under the mutex: the worker read again, and the run takes ITS launch (an update while the start waited counts).
            recheck: () => {
              const fresh = resolve(agent.id).launch;
              if (fresh.kind !== "composer") return refuse("E_CONFLICT", "kind_changed");
              return { mode: fresh.mode, modelId: fresh.modelId, providerId: providerOf(fresh.connection) };
            },
          },
          context,
        );
      } catch (e) {
        return fromRunError(e);
      }
      return { runId: started.run.runId, kind: "composer", workspaceId: agent.homeWorkspaceId, replayed: started.replayed };
    }
    if (req.input !== undefined) throw new DaemonError("E_INVALID_ARGUMENT", "invalid payload"); // a CLI agent takes no prompt
    let out: { readonly run: RunSummary; readonly replayed: boolean };
    try {
      out = await deps.startCli({ workspaceId: agent.homeWorkspaceId, entryId: agent.launch.entryId, worker: agent.id, recheck: () => void resolve(agent.id) }, context);
    } catch (e) {
      return fromRunError(e);
    }
    return { runId: out.run.runId, kind: "cli", workspaceId: agent.homeWorkspaceId, replayed: out.replayed };
  };
}

/** The provider id of the provider serving a vault connection, or undefined when none does (PV-G4 slice B, `providerFor`). */
export function providerForConnection(providers: ReadonlyArray<{ readonly descriptor: { readonly connectionId: string; readonly providerId: string } }>, connection: string): string | undefined {
  return providers.find((p) => p.descriptor.connectionId === connection)?.descriptor.providerId;
}
