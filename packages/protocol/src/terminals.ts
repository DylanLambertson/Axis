// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { guarded } from "./guard.js";
import { projectIdSchema, runIdSchema, workspaceIdSchema, type MethodSpec } from "./worktrees.js";

/**
 * `axis.terminals/1` (DC-3a, docs/design/terminals-contract.md): plain terminals in a managed worktree, and the grant of a terminal
 * to a named data connection. The user's own desktop connection's alone: never a web client, a plugin or a worker.
 *
 * Served since DC-3c (terminal-trust-revocation.md): a host serves it only when its pty port has all four parts of the terminal
 * capability AND the trust-registry routing is installed (contract section 8); otherwise the host drops it from what it serves.
 *
 * No payload carries a path, a command or an environment: a terminal is opened for a workspace id, and the daemon resolves the
 * directory (the shared locator) and the shell itself.
 */
export const TERMINALS_CONTRACT = "axis.terminals" as const;
export const TERMINALS_VERSION = 1 as const;

/** At most this many plain terminals per workspace, pending and live together (contract section 4). */
export const MAX_TERMINALS_PER_WORKSPACE = 8;
/**
 * At most this many plain terminals in the whole host, pending and live together (DC-3c decision): well under the pty process's
 * own bound (64), which CLI runs, hooks and pushes share, so a flood of opens across workspaces can never starve them.
 */
export const MAX_PLAIN_TERMINALS = 16;

/** A terminal id is the pty process's: `pty_` and 32 lower-case hex characters. */
export const terminalIdSchema = z.string().regex(/^pty_[0-9a-f]{32}$/);
/** The name main gives a brokered data port (DC-3b mints it; DC-3a takes it as given, contract section 5). */
export const terminalConnSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const dimension = z.number().int().min(1).max(1000);

/** One terminal the daemon opened or started. `runId` is set for a CLI run's terminal. */
export const terminalSchema = z.strictObject({
  terminalId: terminalIdSchema,
  workspaceId: workspaceIdSchema,
  projectId: projectIdSchema,
  kind: z.enum(["plain", "cli-run"]),
  runId: runIdSchema.nullable(),
  /** The lifecycle (contract section 4): never goes back. Only `open` may be attached. */
  state: z.enum(["open", "closing", "closed", "exited"]),
});
export type Terminal = z.infer<typeof terminalSchema>;

// open (write, tier 2, per-start trust, idempotency required)
export const terminalsOpenRequestSchema = guarded(z.strictObject({ workspaceId: workspaceIdSchema, cols: dimension, rows: dimension }));
export const terminalsOpenResponseSchema = guarded(z.strictObject({ terminal: terminalSchema }));
// list (read, tier 0)
export const terminalsListRequestSchema = guarded(z.strictObject({ workspaceId: workspaceIdSchema.optional() }));
export const terminalsListResponseSchema = guarded(
  z.strictObject({
    terminals: z
      .array(terminalSchema)
      .max(4096)
      .refine((ts) => new Set(ts.map((t) => t.terminalId)).size === ts.length, "duplicate terminal id"),
  }),
);
// close (write, tier 2, idempotency required): a plain terminal only
export const terminalsCloseRequestSchema = guarded(z.strictObject({ terminalId: terminalIdSchema }));
export const terminalsCloseResponseSchema = guarded(z.strictObject({ closed: z.literal(true) }));
// attach (write, tier 2): grants the terminal to the data connection `conn`
export const terminalsAttachRequestSchema = guarded(z.strictObject({ terminalId: terminalIdSchema, conn: terminalConnSchema }));
export const terminalsAttachResponseSchema = guarded(z.strictObject({ attached: z.literal(true) }));

export const terminalsMethods = {
  open: { request: terminalsOpenRequestSchema, response: terminalsOpenResponseSchema, sideEffect: "write", tier: 2, idempotency: "required", timeoutMs: 30_000 },
  list: { request: terminalsListRequestSchema, response: terminalsListResponseSchema, sideEffect: "read", tier: 0, idempotency: "none", timeoutMs: 5_000 },
  close: { request: terminalsCloseRequestSchema, response: terminalsCloseResponseSchema, sideEffect: "write", tier: 2, idempotency: "required", timeoutMs: 15_000 },
  attach: { request: terminalsAttachRequestSchema, response: terminalsAttachResponseSchema, sideEffect: "write", tier: 2, idempotency: "none", timeoutMs: 5_000 },
} as const satisfies Record<string, MethodSpec>;

export type TerminalsMethod = keyof typeof terminalsMethods;
export type TerminalsRequest<M extends TerminalsMethod> = z.infer<(typeof terminalsMethods)[M]["request"]>;
export type TerminalsResponse<M extends TerminalsMethod> = z.infer<(typeof terminalsMethods)[M]["response"]>;
