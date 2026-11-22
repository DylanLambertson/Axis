// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import { DaemonError } from "@axis/daemon";
import { MAX_AGENTS, MAX_GROUPS, type AgentRecord, type GroupRecord, type Journal } from "@axis/journal";
import type { Agent, AgentGroup, AgentGroupsRequest, AgentGroupsResponse, AgentsRequest, AgentsResponse } from "@axis/protocol";
import type { PortContext } from "../ports/common.js";
import type { TrustRegistry } from "../ports/trust.js";
import type { WorktreesService } from "../ports/worktrees.js";
import type { ProjectMutex } from "../worktrees/project-mutex.js";

/*
 * `axis.agents/1` and `axis.agent-groups/1` over the journal (ticket PV-G3, docs/design/agents-contract.md section 4).
 * Every write re-reads its ids from the journal inside one transaction, and the project always comes from the journal,
 * never from the payload. A refusal is an `AgentRefusal` with one of the contract's closed reasons; the handler maps it.
 */

export class AgentRefusal extends Error {
  constructor(readonly code: "E_NOT_FOUND" | "E_CONFLICT", readonly reason: string) {
    super("agent request refused");
  }
}

/** Who asks: the attested connection, never the payload. Only the user reaches the service (the handler checks). */
export interface AgentsCaller {
  readonly ctx: PortContext;
  /** `identity.trusted`, attested by main for this connection. */
  readonly trusted: boolean;
  readonly windowId: string;
  readonly workspaceId?: string;
}

export interface AgentsServiceDeps {
  readonly journal: Pick<Journal, "agents" | "getProject" | "getWorkspace">;
  /** The worktrees service: a new home is its `create`, under the same project mutex. */
  readonly worktrees: Pick<WorktreesService, "create">;
  readonly mutex: ProjectMutex;
  /** The live trust registry the policy pipeline reads for `axis.worktrees/1.create` (its `registry` trust mode). */
  readonly trust: Pick<TrustRegistry, "isTrusted">;
  /**
   * The one decision whether `create` may make a new home worktree in `projectId` for this caller. Default:
   * `registryAdmission(trust)`. The project gate of ticket S1b replaces it here, at the composition root, and nowhere else.
   */
  readonly admitNewHome?: (caller: AgentsCaller, projectId: string) => boolean;
  /** A fresh journal id (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`). */
  readonly newId: () => string;
  /** Called after every write, so the audit anchor sees it. */
  readonly noteWrite?: () => void;
}

const refuse = (code: "E_NOT_FOUND" | "E_CONFLICT", reason: string): never => {
  throw new AgentRefusal(code, reason);
};

/** The journal's refusal (an `AxisError` with a closed `detail.reason`) as the service's own. */
function fromJournal<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof AxisError && (e.code === "E_NOT_FOUND" || e.code === "E_CONFLICT") && typeof e.detail["reason"] === "string") refuse(e.code, e.detail["reason"]);
    throw e;
  }
}

const toAgent = (a: AgentRecord): Agent => ({
  id: a.id, projectId: a.projectId, name: a.name, launch: { ...a.launch }, homeWorkspaceId: a.homeWorkspaceId, groupId: a.groupId, archived: a.archived, createdAt: a.createdAt, updatedAt: a.updatedAt,
});
const toGroup = (g: GroupRecord): AgentGroup => ({ id: g.id, projectId: g.projectId, name: g.name, order: g.order, createdAt: g.createdAt, updatedAt: g.updatedAt });

export interface AgentsService {
  readonly agents: { [M in keyof AgentsRequestMap]: (caller: AgentsCaller, req: AgentsRequest<M>) => Promise<AgentsResponse<M>> };
  readonly groups: { [M in keyof GroupsRequestMap]: (caller: AgentsCaller, req: AgentGroupsRequest<M>) => Promise<AgentGroupsResponse<M>> };
}
type AgentsRequestMap = { list: 1; get: 1; create: 1; update: 1; archive: 1; restore: 1 };
type GroupsRequestMap = { list: 1; create: 1; rename: 1; reorder: 1; delete: 1; assign: 1 };

export function createAgentsService(deps: AgentsServiceDeps): AgentsService {
  const { journal } = deps;
  const records = journal.agents;
  /** One journal transaction for a write, the anchor told after it committed. */
  const write = <T>(fn: () => T): T => {
    const out = records.transaction(() => fromJournal(fn));
    deps.noteWrite?.();
    return out;
  };
  const project = (id: string): string => (journal.getProject(id) === undefined ? refuse("E_NOT_FOUND", "not_found") : id);
  const agent = (id: string): AgentRecord => records.get(id) ?? refuse("E_NOT_FOUND", "not_found");
  const group = (id: string): GroupRecord => records.getGroup(id) ?? refuse("E_NOT_FOUND", "not_found");
  const admitNewHome = deps.admitNewHome ?? registryAdmission(deps.trust);

  const agents: AgentsService["agents"] = {
    list: async (_c, req) => ({ agents: records.list(project(req.projectId), req.includeArchived === true).map(toAgent) }),
    get: async (_c, req) => ({ agent: toAgent(agent(req.agentId)) }),
    create: async (c, req) => {
      const projectId = project(req.projectId);
      const id = deps.newId();
      const base = { id, projectId, name: req.name, launch: req.launch, groupId: req.groupId ?? null };
      if ("existing" in req.home) {
        const homeWorkspaceId = req.home.existing;
        return deps.mutex.run(projectId, async () => ({ agent: toAgent(write(() => records.create({ ...base, homeWorkspaceId }))) }), c.ctx.signal);
      }
      const fresh = req.home.new;
      if (!admitNewHome(c, projectId)) refuse("E_CONFLICT", "untrusted_project");
      return deps.mutex.run(
        projectId,
        async () => {
          // Refuse before any worktree exists: what the record would refuse is checked first, under the same mutex.
          precheck(projectId, req.name, req.groupId ?? null);
          let homeWorkspaceId: string;
          try {
            homeWorkspaceId = (await deps.worktrees.create({ projectId, name: fresh.name, ...(fresh.baseRef === undefined ? {} : { baseRef: fresh.baseRef }) }, c.ctx)).id;
          } catch (e) {
            if (e instanceof DaemonError && e.code === "E_CANCELLED") throw e;
            if (c.ctx.signal.aborted) throw new DaemonError("E_CANCELLED", "The request was cancelled.");
            return refuse("E_CONFLICT", "home_unavailable");
          }
          // A refusal here leaves the new workspace without an agent (listed under Workspaces, ADR 0006 decision 5).
          return { agent: toAgent(write(() => records.create({ ...base, homeWorkspaceId }))) };
        },
        c.ctx.signal,
      );
    },
    update: async (_c, req) =>
      write(() => {
        agent(req.agentId);
        let changed = false;
        if (req.name !== undefined) changed = records.rename(req.agentId, req.name).changed || changed;
        if (req.launch !== undefined) changed = records.setLaunch(req.agentId, req.launch).changed || changed;
        return { agent: toAgent(agent(req.agentId)), changed };
      }),
    archive: async (_c, req) => write(() => changedAgent(records.archive(req.agentId))),
    restore: async (_c, req) => write(() => changedAgent(records.restore(req.agentId))),
  };

  function changedAgent(r: { value: AgentRecord; changed: boolean }): { agent: Agent; changed: boolean } {
    return { agent: toAgent(r.value), changed: r.changed };
  }

  function precheck(projectId: string, name: string, groupId: string | null): void {
    if (records.list(projectId, true).length >= MAX_AGENTS) refuse("E_CONFLICT", "limit_reached");
    if (records.list(projectId).some((a) => asciiFold(a.name) === asciiFold(name))) refuse("E_CONFLICT", "name_taken");
    if (groupId !== null && group(groupId).projectId !== projectId) refuse("E_CONFLICT", "cross_project");
  }

  const groups: AgentsService["groups"] = {
    list: async (_c, req) => ({ groups: records.listGroups(project(req.projectId)).map(toGroup) }),
    create: async (_c, req) => {
      const projectId = project(req.projectId);
      if (records.listGroups(projectId).length >= MAX_GROUPS) refuse("E_CONFLICT", "limit_reached");
      return { group: toGroup(write(() => records.createGroup({ id: deps.newId(), projectId, name: req.name }))) };
    },
    rename: async (_c, req) =>
      write(() => {
        const r = records.renameGroup(group(req.groupId).id, req.name);
        return { group: toGroup(r.value), changed: r.changed };
      }),
    reorder: async (_c, req) => ({ groups: write(() => records.reorderGroups(project(req.projectId), req.order)).map(toGroup) }),
    delete: async (_c, req) => ({ ungrouped: write(() => records.deleteGroup(group(req.groupId).id)) }),
    assign: async (_c, req) => write(() => changedAgent(records.assign(agent(req.agentId).id, req.groupId))),
  };

  return { agents, groups };
}

/**
 * The pipeline's `registry` trust rule for this connection, as `axis.worktrees/1.create` gets it (agents-contract.md 4.4):
 * the attested `identity.trusted` AND the live registry for its window and workspace. Per window, not per project.
 */
export function registryAdmission(trust: Pick<TrustRegistry, "isTrusted">): (caller: AgentsCaller, projectId: string) => boolean {
  return (c) => c.trusted === true && trust.isTrusted({ windowId: c.windowId, ...(c.workspaceId === undefined ? {} : { workspaceId: c.workspaceId }) });
}

/** SQLite's NOCASE: ASCII letters only. */
const asciiFold = (s: string): string => s.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
