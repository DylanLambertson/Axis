// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { cliAgentIdSchema } from "./cliRuns.js";
import { MAX_PROMPT_CHARS, composerModeSchema, composerModelIdSchema } from "./composer-runs.js";
import { guarded, safeTextSchema, timestampSchema } from "./guard.js";
import { agentGroupIdSchema, agentIdSchema } from "./messages-wire.js";
import { connectionNameSchema } from "./providers.js";
import { projectIdSchema, refNameSchema, runIdSchema, workspaceIdSchema, workspaceNameSchema, type MethodSpec } from "./worktrees.js";

/*
 * `axis.agents/1` and `axis.agent-groups/1` (ticket PV-G2, `docs/design/agents-contract.md`, ADR 0006 decisions 4 to 6 and
 * 10, journal schema version 12).
 * Planned contracts: the agreed schemas, served by PV-G3. Every write is the user's (the policy rows are user-only), and no
 * payload carries a path, a command or a credential: a CLI agent names an `axis.cliAgents` entry id, a composer agent a
 * vault connection name, a model id and a mode; a new home workspace is a workspace name and an optional base ref, exactly
 * what `axis.worktrees/1.create` takes. The daemon derives every path from its own records.
 */
export const AGENTS_CONTRACT = "axis.agents" as const;
export const AGENTS_VERSION = 1 as const;
export const AGENT_GROUPS_CONTRACT = "axis.agent-groups" as const;
export const AGENT_GROUPS_VERSION = 1 as const;

/** The most agents a project holds (archived ones included) and the most groups; a list answers all of them. */
export const MAX_AGENTS_PER_PROJECT = 500;
export const MAX_GROUPS_PER_PROJECT = 100;
export const AGENT_NAME_CHARS = 64;

/**
 * The space separators a name refuses on top of `safeTextSchema`'s set (Cc, Cs, the line and paragraph separators, Cf):
 * no-break and fixed-width spaces that read as a plain space. Together they are exactly the journal's
 * `NAME_REFUSED_RANGES` (schema version 12) plus NUL; a daemon-host test compares the two over every code point.
 */
export const AGENT_NAME_SPACES = /[\u{a0}\u{2000}-\u{200a}\u{202f}\u{205f}]/u;

/** A name the user chose: 1 to 64 characters, no edge space, no control, format, line-separator or invisible space. */
export const agentNameSchema = safeTextSchema(AGENT_NAME_CHARS).refine((t) => !AGENT_NAME_SPACES.test(t), { message: "no invisible spaces" });

export const agentLaunchSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("composer"), connection: connectionNameSchema, modelId: composerModelIdSchema, mode: composerModeSchema }),
  z.strictObject({ kind: z.literal("cli"), entryId: cliAgentIdSchema }),
]);
export type AgentLaunch = z.infer<typeof agentLaunchSchema>;

export const agentSchema = z.strictObject({
  id: agentIdSchema,
  projectId: projectIdSchema,
  name: agentNameSchema,
  launch: agentLaunchSchema,
  homeWorkspaceId: workspaceIdSchema,
  groupId: agentGroupIdSchema.nullable(),
  archived: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Agent = z.infer<typeof agentSchema>;

export const agentGroupSchema = z.strictObject({
  id: agentGroupIdSchema,
  projectId: projectIdSchema,
  name: agentNameSchema,
  order: z.number().int().min(0).max(9999),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type AgentGroup = z.infer<typeof agentGroupSchema>;

/** The home of a new agent: a new workspace (what `axis.worktrees/1.create` takes), or an existing one of the project. */
export const agentHomeSchema = z.union([
  z.strictObject({ new: z.strictObject({ name: workspaceNameSchema, baseRef: refNameSchema.optional() }) }),
  z.strictObject({ existing: workspaceIdSchema }),
]);

const unique = <T extends z.ZodType<string>>(item: T, max: number) =>
  z.array(item).min(1).max(max).refine((ids) => new Set(ids).size === ids.length, "ids are unique");

// ---- axis.agents/1 ----

export const agentsListRequestSchema = z.strictObject({ projectId: projectIdSchema, includeArchived: z.boolean().optional() });
export const agentsListResponseSchema = z.strictObject({ agents: z.array(agentSchema).max(MAX_AGENTS_PER_PROJECT) });
export const agentsGetRequestSchema = z.strictObject({ agentId: agentIdSchema });
export const agentsGetResponseSchema = z.strictObject({ agent: agentSchema });
export const agentsCreateRequestSchema = z.strictObject({
  projectId: projectIdSchema,
  name: agentNameSchema,
  launch: agentLaunchSchema,
  home: agentHomeSchema,
  groupId: agentGroupIdSchema.optional(),
});
export const agentsCreateResponseSchema = z.strictObject({ agent: agentSchema });
/** Rename, or change the launch within the agent's kind (a kind never changes); at least one of them. */
export const agentsUpdateRequestSchema = z
  .strictObject({ agentId: agentIdSchema, name: agentNameSchema.optional(), launch: agentLaunchSchema.optional() })
  .refine((r) => r.name !== undefined || r.launch !== undefined, "nothing to update");
export const agentsUpdateResponseSchema = z.strictObject({ agent: agentSchema, changed: z.boolean() });
/** Archive never removes the home workspace; restore needs a home that is not going or gone and a free name. */
export const agentsArchiveRequestSchema = z.strictObject({ agentId: agentIdSchema });
export const agentsArchiveResponseSchema = z.strictObject({ agent: agentSchema, changed: z.boolean() });
export const agentsRestoreRequestSchema = z.strictObject({ agentId: agentIdSchema });
export const agentsRestoreResponseSchema = z.strictObject({ agent: agentSchema, changed: z.boolean() });

/**
 * Start a run for an agent (PV-G4): the daemon resolves the agent's home workspace and its launch (a CLI entry or a composer
 * connection, model and mode) from the journal; the caller names only the agent and, for a composer agent, the prompt. No
 * workspace, command, entry, provider or model field exists here.
 */
export const agentsStartRequestSchema = z.strictObject({
  agentId: agentIdSchema,
  input: z.strictObject({ prompt: z.string().min(1).max(MAX_PROMPT_CHARS) }).optional(),
});
export const agentsStartResponseSchema = z.strictObject({
  runId: runIdSchema,
  kind: z.enum(["composer", "cli"]),
  workspaceId: workspaceIdSchema,
  replayed: z.boolean(),
});

// ---- axis.agent-groups/1 ----

export const groupsListRequestSchema = z.strictObject({ projectId: projectIdSchema });
export const groupsListResponseSchema = z.strictObject({ groups: z.array(agentGroupSchema).max(MAX_GROUPS_PER_PROJECT) });
export const groupsCreateRequestSchema = z.strictObject({ projectId: projectIdSchema, name: agentNameSchema });
export const groupsCreateResponseSchema = z.strictObject({ group: agentGroupSchema });
export const groupsRenameRequestSchema = z.strictObject({ groupId: agentGroupIdSchema, name: agentNameSchema });
export const groupsRenameResponseSchema = z.strictObject({ group: agentGroupSchema, changed: z.boolean() });
/** The project's groups in their new order: exactly the project's group ids, each once. */
export const groupsReorderRequestSchema = z.strictObject({ projectId: projectIdSchema, order: unique(agentGroupIdSchema, MAX_GROUPS_PER_PROJECT) });
export const groupsReorderResponseSchema = z.strictObject({ groups: z.array(agentGroupSchema).max(MAX_GROUPS_PER_PROJECT) });
/** Deleting a group ungroups its agents; it archives none and removes no workspace. */
export const groupsDeleteRequestSchema = z.strictObject({ groupId: agentGroupIdSchema });
export const groupsDeleteResponseSchema = z.strictObject({ ungrouped: z.array(agentIdSchema).max(MAX_AGENTS_PER_PROJECT) });
/** Put an agent in a group of its own project, or take it out (`null`). Membership feeds the messaging send policy. */
export const groupsAssignRequestSchema = z.strictObject({ agentId: agentIdSchema, groupId: agentGroupIdSchema.nullable() });
export const groupsAssignResponseSchema = z.strictObject({ agent: agentSchema, changed: z.boolean() });

/**
 * The closed refusals of both contracts: every error a handler returns other than `E_INTERNAL` and `E_CANCELLED` is one
 * of these, with `details: { reason }` and the one fixed message, so no stored name reaches an error. `E_CONFLICT`, not
 * `E_POLICY_DENIED`: only the daemon's pipeline raises that (with its own audit row).
 */
export const AGENTS_REFUSALS = {
  E_NOT_FOUND: ["not_found"],
  E_CONFLICT: [
    "name_taken", "cross_project", "kind_changed", "archived", "home_unavailable", "order_mismatch", "limit_reached", "untrusted_project",
    "entry_unavailable", "connection_unavailable", "busy",
  ],
  /** A start that could not be made now and may succeed later (settings or snapshot unavailable; a composer start before PV-G4 slice B). */
  E_UNAVAILABLE: ["not_available"],
} as const;
export type AgentsRefusalCode = keyof typeof AGENTS_REFUSALS;
export const AGENTS_REASONS = Object.values(AGENTS_REFUSALS).flat();
export const agentsRefusalDetailsSchema = z.strictObject({ reason: z.enum(AGENTS_REASONS as [string, ...string[]]) });
export const AGENTS_REFUSAL_MESSAGE = "agent request refused";

export function isAgentsRefusal(code: string, reason: string): boolean {
  return Object.hasOwn(AGENTS_REFUSALS, code) && (AGENTS_REFUSALS[code as AgentsRefusalCode] as readonly string[]).includes(reason);
}

const spec = <Req extends z.ZodType, Res extends z.ZodType>(
  request: Req,
  response: Res,
  sideEffect: "read" | "write",
  tier: 0 | 1 | 2,
  idempotency: "none" | "required",
  timeoutMs: number,
) => ({ request: guarded(request), response: guarded(response), sideEffect, tier, idempotency, timeoutMs }) as const;

/**
 * Tiers: reads 0; `create` 2 with an idempotency key, as `axis.worktrees/1.create` (it can create a worktree); a change to
 * what an agent runs (`update` with a launch) and to its messaging scope (`assign`) 2, as the messaging settings; the other
 * writes 1. Archive and delete are not destructive: nothing is lost and both can be undone by the user.
 */
export const agentsMethods = {
  list: spec(agentsListRequestSchema, agentsListResponseSchema, "read", 0, "none", 5_000),
  get: spec(agentsGetRequestSchema, agentsGetResponseSchema, "read", 0, "none", 5_000),
  create: spec(agentsCreateRequestSchema, agentsCreateResponseSchema, "write", 2, "required", 30_000),
  update: spec(agentsUpdateRequestSchema, agentsUpdateResponseSchema, "write", 2, "none", 5_000),
  archive: spec(agentsArchiveRequestSchema, agentsArchiveResponseSchema, "write", 1, "none", 5_000),
  restore: spec(agentsRestoreRequestSchema, agentsRestoreResponseSchema, "write", 1, "none", 5_000),
  start: spec(agentsStartRequestSchema, agentsStartResponseSchema, "write", 2, "required", 30_000),
} as const satisfies Record<string, MethodSpec>;

export const agentGroupsMethods = {
  list: spec(groupsListRequestSchema, groupsListResponseSchema, "read", 0, "none", 5_000),
  create: spec(groupsCreateRequestSchema, groupsCreateResponseSchema, "write", 1, "required", 5_000),
  rename: spec(groupsRenameRequestSchema, groupsRenameResponseSchema, "write", 1, "none", 5_000),
  reorder: spec(groupsReorderRequestSchema, groupsReorderResponseSchema, "write", 1, "none", 5_000),
  delete: spec(groupsDeleteRequestSchema, groupsDeleteResponseSchema, "write", 1, "none", 5_000),
  assign: spec(groupsAssignRequestSchema, groupsAssignResponseSchema, "write", 2, "none", 5_000),
} as const satisfies Record<string, MethodSpec>;

export type AgentsMethod = keyof typeof agentsMethods;
export type AgentsRequest<M extends AgentsMethod> = z.infer<(typeof agentsMethods)[M]["request"]>;
export type AgentsResponse<M extends AgentsMethod> = z.infer<(typeof agentsMethods)[M]["response"]>;
export type AgentGroupsMethod = keyof typeof agentGroupsMethods;
export type AgentGroupsRequest<M extends AgentGroupsMethod> = z.infer<(typeof agentGroupsMethods)[M]["request"]>;
export type AgentGroupsResponse<M extends AgentGroupsMethod> = z.infer<(typeof agentGroupsMethods)[M]["response"]>;
