// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { AuditActor, AuditSink, Redactor } from "@axis/audit";
import type { Journal, RunState } from "@axis/journal";
import type { ExecFs } from "@axis/pty-policy";
import type { TrustAttestation } from "./attestation.js";
import type { RunLimits } from "./limits.js";
import type { Clock, EnvSource, PtyPort, RunSnapshotter, WorktreeLocator } from "./ports.js";
import type { RunStatus } from "./status.js";

export interface SupervisorOptions {
  readonly journal: Journal;
  /** An `AuditLog` bound to the journal's database handle; it redacts every payload as well. */
  readonly audit: AuditSink;
  readonly pty: PtyPort;
  readonly clock: Clock;
  readonly locator: WorktreeLocator;
  readonly snapshotter: RunSnapshotter;
  readonly env: EnvSource;
  /** Redacts `tail()` output. Register the vault's secrets on it. */
  readonly redactor: Redactor;
  readonly limits?: Partial<RunLimits>;
  /** Every managed worktree root, so no executable may come from any of them. */
  readonly managedWorktreeRoots?: () => readonly string[];
  readonly extensionVariableNames?: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly fs?: ExecFs;
  /** Local reporting only. Receives a fixed label and a closed-set code, never an error object or message. */
  readonly onInternalError?: (where: string, code: string) => void;
}

export interface StartRequest {
  readonly workspaceId: string;
  /** The `axis.cliAgents` entry the daemon resolved from user-scope settings. */
  readonly agent: unknown;
  /** The authenticated principal of the connection, never a value from a payload. */
  readonly actor: AuditActor;
  /** Main's attestation, minted by the daemon's connection layer (`@axis/runs/daemon-attestation`). */
  readonly trust: TrustAttestation;
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
  /** This supervisor holds a process (or a possible one) for the run. */
  readonly live: boolean;
  readonly lastOutputAt: number | null;
  readonly outputChars: number;
  readonly droppedChars: number;
}

export interface RunEvent {
  readonly runId: string;
  readonly workspaceId: string;
  readonly state: RunState;
  readonly status: RunStatus;
}
