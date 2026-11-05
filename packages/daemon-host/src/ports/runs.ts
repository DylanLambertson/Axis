// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * Run states and status as `@axis/journal` and `@axis/runs` define them. This port repeats the shapes of
 * `RunSupervisor` (only `src/bindings/runs.ts` may import the package); the contract-facing summary is the protocol's
 * `axis.cli-runs` run schema, which the handler maps to.
 */
export const RUN_STATES = ["QUEUED", "RUNNING", "REVIEWING", "BLOCKED", "COMPLETED", "FAILED", "CANCELLED"] as const;
export type RunState = (typeof RUN_STATES)[number];

declare const attestationBrand: unique symbol;

/**
 * Main's statement that the workspace's repository is trusted right now (TRU-2): bound to a workspace and project,
 * expiring and single use. It is opaque here and only the binding can make or read one; a plain `trusted: true`
 * is not accepted anywhere.
 */
export interface RunTrustAttestation {
  readonly [attestationBrand]: true;
}

/** Mints a `RunTrustAttestation` from the window-verified call main attested. Fed by the control channel. */
export interface RunTrustMinter {
  attest(facts: { readonly workspaceId: string; readonly projectId: string }): RunTrustAttestation;
}

export interface RunsStartRequest {
  readonly workspaceId: string;
  /** The `axis.cliAgents` entry the host resolved from user-scope settings; never a command line from a payload. */
  readonly agent: unknown;
  /** The authenticated principal of the connection, never a value from a payload. */
  readonly actor: string;
  readonly trust: RunTrustAttestation;
  readonly idempotencyKey?: string;
}

export interface RunSummary {
  readonly runId: string;
  readonly workspaceId: string;
  readonly state: RunState;
  readonly status: string;
  readonly reason: string | null;
  readonly exitCode: number | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly live: boolean;
  readonly lastOutputAt: number | null;
  readonly outputChars: number;
  readonly droppedChars: number;
  readonly snapshotAfter: string;
}

/** The CLI run lifecycle: a binding over `RunSupervisor`. Ids only; no path or command line crosses it. */
export interface RunsService {
  start(req: RunsStartRequest): Promise<{ readonly run: RunSummary; readonly replayed: boolean }>;
  stop(runId: string, actor: string): RunSummary;
  get(runId: string): RunSummary;
  /** Bounded: `limit` is at most 1000, there is no cursor. */
  list(options?: { readonly workspaceId?: string; readonly limit?: number }): readonly RunSummary[];
  /** True while a CLI run is active in the workspace (the `@axis/git-ops` guard and the worktrees refusals). */
  isActive(workspaceId: string): boolean;
}
