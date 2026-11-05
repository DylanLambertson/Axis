// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { emptyRequestSchema, guarded } from "./guard.js";
import { projectIdSchema, workspaceNameSchema, type MethodSpec } from "./worktrees.js";

/**
 * `axis.projects/1` (docs/design/daemon-host.md section 4.2 and 7.4).
 *
 * Read only. A project is registered by main over the control channel, never
 * by a renderer request, so this contract has no write method. It returns ids,
 * display names and trust, never a filesystem path (ADR 0004 security 2).
 */

export const PROJECTS_CONTRACT = "axis.projects" as const;
export const PROJECTS_VERSION = 1 as const;

export const MAX_PROJECTS = 1000;

export const projectInfoSchema = z.strictObject({
  id: projectIdSchema,
  /** Short display name, shown in the UI. Same rules as a workspace name. */
  name: workspaceNameSchema,
  /** The user's trust decision for the repository (policy rows read it; the UI shows it). */
  trusted: z.boolean(),
});
export type ProjectInfo = z.infer<typeof projectInfoSchema>;

// list (read, tier 0)
export const projectsListRequestSchema = emptyRequestSchema;
export const projectsListResponseSchema = guarded(
  z.strictObject({
    projects: z
      .array(projectInfoSchema)
      .max(MAX_PROJECTS)
      .refine((ps) => new Set(ps.map((p) => p.id)).size === ps.length, "duplicate project id"),
  }),
);

export const projectsMethods = {
  list: {
    request: projectsListRequestSchema,
    response: projectsListResponseSchema,
    sideEffect: "read",
    tier: 0,
    idempotency: "none",
    timeoutMs: 10_000,
  },
} as const satisfies Record<string, MethodSpec>;

export type ProjectsMethod = keyof typeof projectsMethods;
export type ProjectsRequest<M extends ProjectsMethod> = z.infer<(typeof projectsMethods)[M]["request"]>;
export type ProjectsResponse<M extends ProjectsMethod> = z.infer<(typeof projectsMethods)[M]["response"]>;
