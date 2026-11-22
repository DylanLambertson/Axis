// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { challengeReferenceSchema } from "./challenge.js";
import { guarded, timestampSchema } from "./guard.js";
import { agentGroupIdSchema, agentIdSchema, pageIdSchema, pluginIdSchema, taskIdSchema } from "./messages-wire.js";
import { pageTitleSchema } from "./pages.js";
import { projectIdSchema, runIdSchema, workspaceIdSchema, type MethodSpec } from "./worktrees.js";

/*
 * `axis.tasks/1` (ticket PV-T1 slice 1, `docs/design/extensibility.md` §6, `docs/design/tasks-store.md`, journal schema
 * version 15). A planned contract: the agreed schemas, served by slice 2 with the agent task tools and Start (which shows
 * the full prompt and taints the run, IAC-T source 5). The rows are the user's only; plugins (ADR 0008 `tasks.read`,
 * `tasks.write`) and agents get their own rows and tools later.
 * No request names an author, a source, a hop or a trust flag: the daemon takes the author from the attested caller and
 * the store derives the rest. Assigning starts nothing.
 */
export const TASKS_CONTRACT = "axis.tasks" as const;
export const TASKS_VERSION = 1 as const;

/** The journal's `TASK_LIMITS` (schema version 15). */
export const MAX_TASKS_PER_PROJECT = 1_000;
export const MAX_TASK_REVISIONS = 50;
export const MAX_TASK_LINKS = 32;
export const MAX_TASK_BODY_CHARS = 16_384;
/** `list` answers at most this many tasks, most recently changed first, with a cursor for the next ones. */
export const MAX_TASKS_LIST = 100;

/** Task text: at most 16,384 characters, well-formed (no lone surrogate), no NUL. */
export const taskBodySchema = z.string().max(MAX_TASK_BODY_CHARS).refine((t) => !/[\u0000\ud800-\udfff]/u.test(t), { message: "no NUL, well-formed" });
export const taskStatusSchema = z.enum(["open", "in_progress", "blocked", "done", "cancelled"]);
export const taskSourceSchema = z.enum(["user", "agent", "plugin", "integration"]);
const seqSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const hopSchema = z.number().int().min(0).max(8);
const integrationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

export const taskAssigneeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("agent"), id: agentIdSchema }),
  z.strictObject({ kind: z.literal("group"), id: agentGroupIdSchema }),
]);
/** A link is data, never a grant (`inter-agent-communication.md` §5.3). */
export const taskLinkSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("run"), target: runIdSchema }),
  z.strictObject({ kind: z.literal("workspace"), target: workspaceIdSchema }),
  z.strictObject({ kind: z.literal("page"), target: pageIdSchema }),
  z.strictObject({ kind: z.literal("pr"), target: z.string().regex(/^[1-9][0-9]{0,9}$/) }),
]);
export const taskAuthorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user") }),
  z.strictObject({ kind: z.literal("agent"), agentId: agentIdSchema }),
  z.strictObject({ kind: z.literal("plugin"), pluginId: pluginIdSchema.max(64) }),
  z.strictObject({ kind: z.literal("integration"), integrationId: integrationIdSchema }),
  z.strictObject({ kind: z.literal("system") }),
]);

/** `untrusted`: the text may hold text the user did not write (sticky; a read taints, Start taints, sources 8 and 5). */
export const taskSchema = z
  .strictObject({
    taskId: taskIdSchema,
    projectId: projectIdSchema,
    source: taskSourceSchema,
    status: taskStatusSchema,
    title: pageTitleSchema,
    assignee: taskAssigneeSchema.nullable(),
    untrusted: z.boolean(),
    hop: hopSchema,
    lastSeq: seqSchema,
    links: z.array(taskLinkSchema).max(MAX_TASK_LINKS),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .refine((t) => t.source === "user" || t.untrusted, "only the user's task can be trusted")
  .refine((t) => t.untrusted || t.hop === 0, "a trusted task has hop 0");
export const taskRevisionMetaSchema = z
  .strictObject({ taskId: taskIdSchema, seq: seqSchema, title: pageTitleSchema, author: taskAuthorSchema, hop: hopSchema, createdAt: timestampSchema })
  .refine((r) => r.author.kind !== "user" || r.hop === 0, "the user writes at hop 0");
export const taskRevisionSchema = z.strictObject({ meta: taskRevisionMetaSchema, body: taskBodySchema });

export const tasksListRequestSchema = z.strictObject({
  projectId: projectIdSchema,
  status: taskStatusSchema.optional(),
  /** The `updatedAt` and id of the last task of the previous page. */
  after: z.strictObject({ updatedAt: timestampSchema, taskId: taskIdSchema }).optional(),
});
export const tasksListResponseSchema = z.strictObject({ tasks: z.array(taskSchema).max(MAX_TASKS_LIST), more: z.boolean() });
export const tasksGetRequestSchema = z.strictObject({ taskId: taskIdSchema, seq: seqSchema.optional() });
export const tasksGetResponseSchema = z.strictObject({ task: taskSchema, revision: taskRevisionSchema });
export const tasksRevisionsRequestSchema = z.strictObject({ taskId: taskIdSchema });
export const tasksRevisionsResponseSchema = z.strictObject({ revisions: z.array(taskRevisionMetaSchema).max(MAX_TASK_REVISIONS) });
export const tasksCreateRequestSchema = z.strictObject({ projectId: projectIdSchema, title: pageTitleSchema, body: taskBodySchema });
export const tasksCreateResponseSchema = z.strictObject({ task: taskSchema });
/** A new revision on top of `baseSeq`; refused `stale_version` when another came first. */
export const tasksUpdateRequestSchema = z.strictObject({ taskId: taskIdSchema, baseSeq: seqSchema, title: pageTitleSchema, body: taskBodySchema });
export const tasksUpdateResponseSchema = z.strictObject({ task: taskSchema });
export const tasksSetStatusRequestSchema = z.strictObject({ taskId: taskIdSchema, status: taskStatusSchema });
export const tasksSetStatusResponseSchema = z.strictObject({ task: taskSchema });
/** Assign to an agent or a group of the task's project, or clear (`null`). Assigning starts nothing. */
export const tasksAssignRequestSchema = z.strictObject({ taskId: taskIdSchema, assignee: taskAssigneeSchema.nullable() });
export const tasksAssignResponseSchema = z.strictObject({ task: taskSchema });
export const tasksLinkRequestSchema = z.strictObject({ taskId: taskIdSchema, link: taskLinkSchema });
export const tasksLinkResponseSchema = z.strictObject({ task: taskSchema, changed: z.boolean() });
export const tasksUnlinkRequestSchema = tasksLinkRequestSchema;
export const tasksUnlinkResponseSchema = tasksLinkResponseSchema;
/** Delete a task with its revisions and links. Destructive, tier 3: resolved in the renderer, with no native step. */
export const tasksDeleteRequestSchema = z.strictObject({ taskId: taskIdSchema, approval: challengeReferenceSchema.optional() });
export const tasksDeleteResponseSchema = z.strictObject({ deleted: z.literal(true) });

/** Closed refusals under one fixed message; no stored title or body reaches an error. */
export const TASKS_REFUSALS = {
  E_NOT_FOUND: ["not_found"],
  E_INVALID_ARGUMENT: ["too_large"],
  E_CONFLICT: ["stale_version", "limit_reached", "assignee_refused", "link_refused"],
} as const;
export type TasksRefusalCode = keyof typeof TASKS_REFUSALS;
export const TASKS_REASONS = Object.values(TASKS_REFUSALS).flat();
export const tasksRefusalDetailsSchema = z.strictObject({ reason: z.enum(TASKS_REASONS as [string, ...string[]]) });
export const TASKS_REFUSAL_MESSAGE = "task request refused";

export function isTasksRefusal(code: string, reason: string): boolean {
  return Object.hasOwn(TASKS_REFUSALS, code) && (TASKS_REFUSALS[code as TasksRefusalCode] as readonly string[]).includes(reason);
}

const spec = <Req extends z.ZodType, Res extends z.ZodType>(
  request: Req,
  response: Res,
  sideEffect: "read" | "write" | "destructive",
  tier: 0 | 1 | 3,
  idempotency: "none" | "required",
  timeoutMs: number,
) => ({ request: guarded(request), response: guarded(response), sideEffect, tier, idempotency, timeoutMs }) as const;

/** Tiers: reads 0; every record write 1 (nothing runs, assigning starts nothing); delete 3 and destructive. */
export const tasksMethods = {
  list: spec(tasksListRequestSchema, tasksListResponseSchema, "read", 0, "none", 5_000),
  get: spec(tasksGetRequestSchema, tasksGetResponseSchema, "read", 0, "none", 5_000),
  revisions: spec(tasksRevisionsRequestSchema, tasksRevisionsResponseSchema, "read", 0, "none", 5_000),
  create: spec(tasksCreateRequestSchema, tasksCreateResponseSchema, "write", 1, "required", 10_000),
  update: spec(tasksUpdateRequestSchema, tasksUpdateResponseSchema, "write", 1, "none", 10_000),
  setStatus: spec(tasksSetStatusRequestSchema, tasksSetStatusResponseSchema, "write", 1, "none", 5_000),
  assign: spec(tasksAssignRequestSchema, tasksAssignResponseSchema, "write", 1, "none", 5_000),
  link: spec(tasksLinkRequestSchema, tasksLinkResponseSchema, "write", 1, "none", 5_000),
  unlink: spec(tasksUnlinkRequestSchema, tasksUnlinkResponseSchema, "write", 1, "none", 5_000),
  delete: spec(tasksDeleteRequestSchema, tasksDeleteResponseSchema, "destructive", 3, "none", 30_000),
} as const satisfies Record<string, MethodSpec>;

export type TasksMethod = keyof typeof tasksMethods;
export type TasksRequest<M extends TasksMethod> = z.infer<(typeof tasksMethods)[M]["request"]>;
export type TasksResponse<M extends TasksMethod> = z.infer<(typeof tasksMethods)[M]["response"]>;
