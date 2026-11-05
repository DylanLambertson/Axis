// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { guarded, timestampSchema } from "./guard.js";
import { runIdSchema, workspaceIdSchema, type MethodSpec } from "./worktrees.js";

/**
 * Runs of a CLI agent in a workspace (docs/design/daemon-host.md section 4.2).
 *
 * The contract id is `axis.cli-runs`, not the design's `axis.cliRuns`:
 * `contractIdSchema` (the envelope and the hello message) allows lower-case
 * letters, digits and `-` only, so a camel-case id could never be sent or
 * negotiated. Changing the spelling later is one constant here.
 *
 * No payload carries a path or a command: a run is started for a workspace id
 * and an id from the user's `axis.cliAgents` setting, and the daemon resolves
 * the executable itself (PTY-5, DMN-2). `start` needs a trusted project and
 * `stop` does not; both are policy rows, not registry fields. Unknown runs
 * and workspaces answer E_NOT_FOUND, a run in the wrong state E_CONFLICT.
 */

export const CLI_RUNS_CONTRACT = "axis.cli-runs" as const;
export const CLI_RUNS_VERSION = 1 as const;

/** Ten values a run: 500 of them stay well inside the message walk's 10,000-node ceiling (1000 would not fit). */
export const MAX_CLI_RUNS_LIST = 500;

/** Same pattern as an `axis.cliAgents` entry id (`@axis/pty-policy`). */
export const cliAgentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

/** The Phase 1a run states (`@axis/journal`); a test keeps the two lists equal. */
export const RUN_STATE_VALUES = ["QUEUED", "RUNNING", "REVIEWING", "BLOCKED", "COMPLETED", "FAILED", "CANCELLED"] as const;
export const runStateSchema = z.enum(RUN_STATE_VALUES);
export type RunStateValue = z.infer<typeof runStateSchema>;
const TERMINAL: ReadonlySet<string> = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

export const cliRunSchema = z
  .strictObject({
    id: runIdSchema,
    workspaceId: workspaceIdSchema,
    state: runStateSchema,
    /** Short upper-case code such as `INTERRUPTED_BY_RESTART`; never free text. */
    reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
    exitCode: z.number().int().min(-255).max(255).nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    endedAt: timestampSchema.nullable(),
  })
  .refine((r) => (r.endedAt !== null) === TERMINAL.has(r.state), "endedAt is set exactly when the run is terminal")
  .refine((r) => r.startedAt !== null || r.state === "QUEUED" || r.state === "CANCELLED", "only a queued or cancelled run can have never started");
export type CliRun = z.infer<typeof cliRunSchema>;

const runResponse = guarded(z.strictObject({ run: cliRunSchema }));
const runIdRequest = guarded(z.strictObject({ runId: runIdSchema }));

// start (write, tier 2, idempotency required)
export const cliRunsStartRequestSchema = guarded(z.strictObject({ workspaceId: workspaceIdSchema, agentId: cliAgentIdSchema }));
export const cliRunsStartResponseSchema = runResponse;

// stop (write, tier 2, idempotency required): ask the run to end; the response is the run as it is then
export const cliRunsStopRequestSchema = runIdRequest;
export const cliRunsStopResponseSchema = runResponse;

// get (read, tier 0)
export const cliRunsGetRequestSchema = runIdRequest;
export const cliRunsGetResponseSchema = runResponse;

// list (read, tier 0): oldest first, like the journal; at most MAX_CLI_RUNS_LIST
export const cliRunsListRequestSchema = guarded(
  z.strictObject({
    workspaceId: workspaceIdSchema.optional(),
    states: z
      .array(runStateSchema)
      .min(1)
      .max(RUN_STATE_VALUES.length)
      .refine((s) => new Set(s).size === s.length, "duplicate state")
      .optional(),
  }),
);
export const cliRunsListResponseSchema = guarded(
  z.strictObject({
    runs: z
      .array(cliRunSchema)
      .max(MAX_CLI_RUNS_LIST)
      .refine((rs) => new Set(rs.map((r) => r.id)).size === rs.length, "duplicate run id"),
  }),
);

export const cliRunsMethods = {
  start: {
    request: cliRunsStartRequestSchema,
    response: cliRunsStartResponseSchema,
    sideEffect: "write",
    tier: 2,
    idempotency: "required",
    timeoutMs: 30_000,
  },
  stop: {
    request: cliRunsStopRequestSchema,
    response: cliRunsStopResponseSchema,
    sideEffect: "write",
    tier: 2,
    idempotency: "required",
    timeoutMs: 15_000,
  },
  get: {
    request: cliRunsGetRequestSchema,
    response: cliRunsGetResponseSchema,
    sideEffect: "read",
    tier: 0,
    idempotency: "none",
    timeoutMs: 5_000,
  },
  list: {
    request: cliRunsListRequestSchema,
    response: cliRunsListResponseSchema,
    sideEffect: "read",
    tier: 0,
    idempotency: "none",
    timeoutMs: 10_000,
  },
} as const satisfies Record<string, MethodSpec>;

export type CliRunsMethod = keyof typeof cliRunsMethods;
export type CliRunsRequest<M extends CliRunsMethod> = z.infer<(typeof cliRunsMethods)[M]["request"]>;
export type CliRunsResponse<M extends CliRunsMethod> = z.infer<(typeof cliRunsMethods)[M]["response"]>;
