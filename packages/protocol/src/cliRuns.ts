// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { countSchema, guarded, timestampSchema } from "./guard.js";
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

/**
 * Most runs one `list` reply holds. A run is sixteen values and the message
 * walk allows 10,000, so 500 fit and 1000 (what `@axis/runs` accepts) do not:
 * the handler clamps a page to this and the client follows `next`.
 */
export const MAX_CLI_RUNS_LIST = 500;

/** Same pattern as an `axis.cliAgents` entry id (`@axis/pty-policy`). */
export const cliAgentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

/** Opaque page cursor: only ever a value from a previous `next`, never built by a client. */
export const cliRunsCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/*
 * The enums below are copies. Source: `@axis/journal` (`RUN_STATES`) and
 * `@axis/runs` (`RUN_STATUSES`, `SnapshotVerdict`, the `RunSummary` fields), read at
 * `@axis/runs` on origin/feat/runs 40963ac. `@axis/protocol` must not depend on
 * either package, so a root test over the built packages
 * (test/packages/protocol-copies.test.mjs) compares the run states with the
 * journal's; the status and snapshot lists are to be added there when `@axis/runs`
 * is on main. Change the copies and their source together.
 */
export const RUN_STATE_VALUES = ["QUEUED", "RUNNING", "REVIEWING", "BLOCKED", "COMPLETED", "FAILED", "CANCELLED"] as const;
export const runStateSchema = z.enum(RUN_STATE_VALUES);
export type RunStateValue = z.infer<typeof runStateSchema>;

/** Dashboard status derived by `@axis/runs`: the journal state plus the process this daemon owns. */
export const RUN_STATUS_VALUES = ["starting", "running", "quiet", "finished", "failed", "killed", "interrupted", "stopping"] as const;
export const runStatusSchema = z.enum(RUN_STATUS_VALUES);
export type RunStatusValue = z.infer<typeof runStatusSchema>;

/** WT-2 post-run snapshot: `pending` until the run ends; `unknown` must be treated as possibly changed. */
export const SNAPSHOT_AFTER_VALUES = ["pending", "ok", "drift", "unknown"] as const;
export const snapshotAfterSchema = z.enum(SNAPSHOT_AFTER_VALUES);

const TERMINAL: ReadonlySet<string> = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/** One run, field for field as `@axis/runs` `RunSummary`, plus `agentId` (null until the journal records it). */
export const cliRunSchema = z
  .strictObject({
    runId: runIdSchema,
    workspaceId: workspaceIdSchema,
    /** The `axis.cliAgents` entry the run was started with; null when the backing store does not know it. */
    agentId: cliAgentIdSchema.nullable(),
    state: runStateSchema,
    status: runStatusSchema,
    /** Short upper-case code such as `INTERRUPTED_BY_RESTART`; never free text. */
    reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
    exitCode: z.number().int().min(-255).max(255).nullable(),
    createdAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    endedAt: timestampSchema.nullable(),
    /** The daemon holds a process (or a possible one) for the run. */
    live: z.boolean(),
    /** Epoch milliseconds of the last output, as `@axis/runs` reports it. */
    lastOutputAt: countSchema.nullable(),
    outputChars: countSchema,
    droppedChars: countSchema,
    snapshotAfter: snapshotAfterSchema,
  })
  .refine((r) => (r.endedAt !== null) === TERMINAL.has(r.state), "endedAt is set exactly when the run is terminal")
  .refine((r) => r.startedAt !== null || r.state === "QUEUED" || r.state === "CANCELLED", "only a queued or cancelled run can have never started");
export type CliRun = z.infer<typeof cliRunSchema>;

const runResponse = guarded(z.strictObject({ run: cliRunSchema }));
const runIdRequest = guarded(z.strictObject({ runId: runIdSchema }));

// start (write, tier 2, idempotency required). `replayed` is true when the idempotency key already started this run.
export const cliRunsStartRequestSchema = guarded(z.strictObject({ workspaceId: workspaceIdSchema, agentId: cliAgentIdSchema }));
export const cliRunsStartResponseSchema = guarded(z.strictObject({ run: cliRunSchema, replayed: z.boolean() }));

// stop (write, tier 2, idempotency required): ask the run to end; the response is the run as it is then
export const cliRunsStopRequestSchema = runIdRequest;
export const cliRunsStopResponseSchema = runResponse;

// get (read, tier 0)
export const cliRunsGetRequestSchema = runIdRequest;
export const cliRunsGetResponseSchema = runResponse;

/**
 * list (read, tier 0). Pages go from newest to older: a request without `cursor`
 * returns the newest `limit` runs, and `next` (null on the last page) is the
 * `cursor` for the next older page. Runs inside a page are oldest first, like
 * the journal. `limit` is at most MAX_CLI_RUNS_LIST; the handler picks the
 * default (`@axis/runs` uses 200).
 */
export const cliRunsListRequestSchema = guarded(
  z.strictObject({
    workspaceId: workspaceIdSchema.optional(),
    limit: z.number().int().min(1).max(MAX_CLI_RUNS_LIST).optional(),
    cursor: cliRunsCursorSchema.optional(),
  }),
);
export const cliRunsListResponseSchema = guarded(
  z.strictObject({
    runs: z
      .array(cliRunSchema)
      .max(MAX_CLI_RUNS_LIST)
      .refine((rs) => new Set(rs.map((r) => r.runId)).size === rs.length, "duplicate run id"),
    next: cliRunsCursorSchema.nullable(),
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
