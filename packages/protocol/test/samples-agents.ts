// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Fixed vectors of axis.agents/1 and axis.agent-groups/1 (PV-G2).
import type { Sample } from "./suite.js";

export const T0 = "2026-11-21T10:00:00.000Z";
export const T1 = "2026-11-21T10:00:05.000Z";

export const composerAgent = {
  id: "agent-a",
  projectId: "proj-1",
  name: "Planner",
  launch: { kind: "composer", connection: "anthropic-main", modelId: "claude-x", mode: "agent" },
  homeWorkspaceId: "ws-1",
  groupId: "group-1",
  archived: false,
  createdAt: T0,
  updatedAt: T1,
};
export const cliAgent = {
  id: "agent-b",
  projectId: "proj-1",
  name: "Shell helper",
  launch: { kind: "cli", entryId: "my-cli.v2" },
  homeWorkspaceId: "ws-2",
  groupId: null,
  archived: true,
  createdAt: T0,
  updatedAt: T1,
};
export const group = { id: "group-1", projectId: "proj-1", name: "Backend", order: 0, createdAt: T0, updatedAt: T1 };

const A = "axis.agents";
const G = "axis.agent-groups";
const req = (contract: string, method: string, name: string, value: unknown, extra: Partial<Sample> = {}): Sample => ({ contract, method, side: "request", name, value, ...extra });
const res = (contract: string, method: string, name: string, value: unknown, extra: Partial<Sample> = {}): Sample => ({ contract, method, side: "response", name, value, ...extra });

export const AGENTS_SAMPLES: readonly Sample[] = [
  req(A, "list", "a project's live agents", { projectId: "proj-1" }),
  req(A, "list", "archived included", { projectId: "proj-1", includeArchived: true }),
  res(A, "list", "two agents", { agents: [composerAgent, cliAgent] }, { tolerated: ["null at agents.0.groupId", "string at agents.1.groupId"] }),
  req(A, "get", "one agent", { agentId: "agent-a" }),
  res(A, "get", "a composer agent", { agent: composerAgent }, { tolerated: ["null at agent.groupId"] }),
  req(A, "create", "a composer agent in a new workspace", {
    projectId: "proj-1", name: "Planner", launch: composerAgent.launch, home: { new: { name: "planner", baseRef: "main" } }, groupId: "group-1",
  }),
  req(A, "create", "a CLI agent in an existing workspace", { projectId: "proj-1", name: "Helper", launch: cliAgent.launch, home: { existing: "ws-2" } }),
  res(A, "create", "the new agent", { agent: cliAgent }, { tolerated: ["string at agent.groupId"] }),
  req(A, "update", "a rename", { agentId: "agent-a", name: "Planner 2" }),
  req(A, "update", "a new model", { agentId: "agent-a", launch: { kind: "composer", connection: "anthropic-main", modelId: "claude-y", mode: "ask" } }),
  res(A, "update", "changed", { agent: composerAgent, changed: true }, { tolerated: ["null at agent.groupId"] }),
  req(A, "archive", "archive", { agentId: "agent-b" }),
  res(A, "archive", "archived", { agent: cliAgent, changed: true }, { tolerated: ["string at agent.groupId"] }),
  req(A, "restore", "restore", { agentId: "agent-b" }),
  res(A, "restore", "already live", { agent: composerAgent, changed: false }, { tolerated: ["null at agent.groupId"] }),
  req(G, "list", "a project's groups", { projectId: "proj-1" }),
  res(G, "list", "one group", { groups: [group] }),
  req(G, "create", "a group", { projectId: "proj-1", name: "Backend" }),
  res(G, "create", "the group", { group }),
  req(G, "rename", "rename", { groupId: "group-1", name: "Front end" }),
  res(G, "rename", "renamed", { group, changed: true }),
  req(G, "reorder", "two groups", { projectId: "proj-1", order: ["group-2", "group-1"] }),
  res(G, "reorder", "in order", { groups: [group] }),
  req(G, "delete", "delete", { groupId: "group-1" }),
  res(G, "delete", "ungrouped two", { ungrouped: ["agent-a", "agent-c"] }),
  req(G, "assign", "into a group", { agentId: "agent-a", groupId: "group-1" }, { tolerated: ["null at groupId"] }),
  req(G, "assign", "out of its group", { agentId: "agent-a", groupId: null }, { tolerated: ["string at groupId"] }),
  res(G, "assign", "assigned", { agent: composerAgent, changed: true }, { tolerated: ["null at agent.groupId"] }),
];
