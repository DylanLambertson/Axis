// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { RunState } from "@axis/journal";
import type { AuditActor } from "@axis/audit";
import type { CliAgent } from "@axis/pty-policy";
import type { Disposable, PtyExit, PtyHandle, RunWorktree, TimerId } from "./ports.js";
import { RingBuffer } from "./ring.js";
import type { LiveView } from "./status.js";

export type SnapshotVerdict = "ok" | "drift" | "unknown";
export type Phase = "launching" | "spawning" | "running" | "stopping" | "exited";

/**
 * Everything the supervisor holds for one run that can still own a process. One object per run: it is created
 * with the concurrency slot and dropped only when no process can exist (see `Supervisor#release`).
 */
export class LiveRun {
  runId: string | undefined;
  /** What the journal row holds, kept in step by the supervisor's single transition helper. */
  state: RunState = "QUEUED";
  phase: Phase = "launching";
  handle: PtyHandle | undefined;
  /** True from the moment spawn is called until it is known that no process exists or the process has exited. */
  processPossible = false;
  stopRequested = false;
  stopReason = "USER_KILLED";
  escalating = false;
  /** The journal already holds this run's final state (a timeout or an unconfirmed kill wrote it). */
  finalised = false;
  /** Handlers are attached but the journal does not yet say RUNNING: an exit seen now waits. */
  subscribing = false;
  pendingExit: PtyExit | undefined;
  /** Ends a pending spawn wait (and its timer) when the run is released before the port answers. */
  abortSpawn: (() => void) | undefined;
  quiet = false;
  released = false;
  reportedKillError = false;
  /** SIGKILL was sent and no exit came within the kill timeout: the process may still live. */
  unconfirmed = false;
  /** The post-run snapshot verdict; `unknown` until a snapshot answered. */
  verdict: SnapshotVerdict = "unknown";
  ignoredEvents = 0;
  lastActivityAt: number;
  readonly ring: RingBuffer;
  readonly subs: Disposable[] = [];
  readonly timers = new Set<TimerId>();

  constructor(
    readonly workspaceId: string,
    readonly worktree: RunWorktree,
    readonly actor: AuditActor,
    readonly agent: Readonly<CliAgent>,
    capacity: number,
    now: number,
  ) {
    this.ring = new RingBuffer(capacity);
    this.lastActivityAt = now;
  }

  view(): LiveView | undefined {
    if (this.phase === "exited") return undefined;
    const phase = this.phase === "launching" || this.phase === "spawning" ? "starting" : this.phase;
    return { phase, lastActivityAt: this.lastActivityAt };
  }
}
