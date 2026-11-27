// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Journal } from "@axis/journal";
import { MAX_SETTINGS_AGENTS } from "@axis/protocol";
import type { AgentEntry, MessagingDirectory } from "../messages/policy.js";

/**
 * The messaging directory over the journal's agents and groups (ticket PV-G3 slice 2; docs/design/messages-contract.md
 * "Directory"). Live only: an archived agent is unknown here, so it can be neither addressed nor delivered to, and its
 * queued messages wait (a restored agent gets them). A group's members are its live agents, in id order, at most
 * `MAX_SETTINGS_AGENTS`; an archived member is not expanded. A project's agents are its live agents in id order (not
 * creation order), at most `MAX_SETTINGS_AGENTS`; both caps are applied in the query, never by cutting a longer list. Every answer is read from the journal at the moment it is
 * asked, so an archive, a group change or a deletion takes effect on the next call.
 */
export function journalAgentsDirectory(journal: Pick<Journal, "agents" | "getProject">): MessagingDirectory {
  const entry = (a: { id: string; projectId: string; groupId: string | null; launch: { kind: "composer" | "cli" } }): AgentEntry => ({
    agentId: a.id,
    projectId: a.projectId,
    groupId: a.groupId,
    kind: a.launch.kind,
  });
  return {
    project: (id) => journal.getProject(id) !== undefined,
    agent(id) {
      const a = journal.agents.get(id);
      return a === undefined || a.archived ? undefined : entry(a);
    },
    group(id) {
      const g = journal.agents.getGroup(id);
      return g === undefined ? undefined : { groupId: g.id, projectId: g.projectId, members: journal.agents.liveMembers(g.id, MAX_SETTINGS_AGENTS) };
    },
    agents: (projectId) => journal.agents.liveEntries(projectId, MAX_SETTINGS_AGENTS).map((a) => ({ agentId: a.id, projectId, groupId: a.groupId, kind: a.kind })),
  };
}

/**
 * The worker a run acts for and its project, as the page tools ask it (PV-Q1 slice 2): the run's recorded worker while it is
 * not archived, else undefined. Asked when the run's tools are built and again at every page call, so archiving the worker
 * takes the tools away from its live runs too.
 */
export function journalWorkerOf(journal: Pick<Journal, "agents">): (runId: string) => { readonly agentId: string; readonly projectId: string } | undefined {
  return (runId) => {
    const id = journal.agents.agentOfRun(runId);
    const r = id === undefined ? undefined : journal.agents.get(id);
    return r === undefined || r.archived ? undefined : { agentId: r.id, projectId: r.projectId };
  };
}

/** The agent a run acts for, as messaging asks it (`agentOf`): the run's recorded agent, set only by a run start from an agent (PV-G4). */
export function journalAgentOf(journal: Pick<Journal, "agents">): (runId: string) => string | undefined {
  return (runId) => journal.agents.agentOfRun(runId);
}
