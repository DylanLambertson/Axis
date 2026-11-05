// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { AuditActor } from "@axis/audit";
import type { RunStateValue, RunStatusValue, SNAPSHOT_AFTER_VALUES } from "@axis/protocol";
import { RUN_STATE_VALUES } from "@axis/protocol";

/**
 * Mirrors the `RunSupervisor` of `@axis/runs` for `start`, `stop`, `get`, `list` and `hasActiveRun` (only
 * `src/bindings/runs.ts` may import that package). Its enums are the protocol's `axis.cli-runs` copies. `tail`,
 * `resize`, `onChange`, `workspaceStatus` and `discardInterrupted` are not part of this port yet. A type test
 * (`test/types/runs-port.test.ts`) compiles the port against the real supervisor, so drift fails the build.
 */
export const RUN_STATES = RUN_STATE_VALUES;
export type RunState = RunStateValue;
export type RunStatus = RunStatusValue;
export type RunSnapshotAfter = (typeof SNAPSHOT_AFTER_VALUES)[number];

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
  readonly actor: AuditActor;
  readonly trust: RunTrustAttestation;
  readonly idempotencyKey?: string;
}

export interface RunSummary {
  readonly runId: string;
  readonly workspaceId: string;
  readonly state: RunState;
  readonly status: RunStatus;
  readonly reason: string | null;
  readonly exitCode: number | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly live: boolean;
  readonly lastOutputAt: number | null;
  readonly outputChars: number;
  readonly droppedChars: number;
  readonly snapshotAfter: RunSnapshotAfter;
}

/** The CLI run lifecycle: a binding over `RunSupervisor`. Ids only; no path or command line crosses it. */
export interface RunsService {
  start(req: RunsStartRequest): Promise<{ readonly run: RunSummary; readonly replayed: boolean }>;
  stop(runId: string, actor: AuditActor): RunSummary;
  get(runId: string): RunSummary;
  /** Bounded: the supervisor caps `limit` at 1000 and the contract at 500; there is no cursor. */
  list(options?: { readonly workspaceId?: string; readonly limit?: number }): readonly RunSummary[];
  /** True while a CLI run is active in the workspace (the `@axis/git-ops` guard and the worktrees refusals). */
  hasActiveRun(workspaceId: string): boolean;
}
