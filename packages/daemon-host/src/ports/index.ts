// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Clock } from "./clock.js";
import type { GitPort } from "./git.js";
import type { PtyPort } from "./pty.js";
import type { RandomSource } from "./random.js";
import type { ReviewService } from "./review.js";
import type { RunTrustMinter, RunsService } from "./runs.js";
import type { StoragePort } from "./storage.js";
import type { SupervisorChannel } from "./supervisor.js";
import type { TrustRegistry } from "./trust.js";
import type { WorktreeLocator } from "./worktree-locator.js";
import type { WorktreesService } from "./worktrees.js";

export type * from "./clock.js";
export type * from "./common.js";
export type * from "./composer.js";
export * from "./git.js";
export type * from "./pty.js";
export type * from "./worktree-locator.js";
export type * from "./random.js";
export * from "./review.js";
export * from "./runs.js";
export type * from "./storage.js";
export type * from "./supervisor.js";
export type * from "./trust.js";
export * from "./worktrees.js";

/** Every OS-touching dependency of the host. `createHost(ports)` (ticket H2 onward) takes this and nothing else. */
export interface HostPorts {
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly storage: StoragePort;
  readonly supervisor: SupervisorChannel;
  readonly worktrees: WorktreesService;
  readonly runs: RunsService;
  readonly review: ReviewService;
  readonly pty: PtyPort;
  readonly git: GitPort;
  readonly locator: WorktreeLocator;
  readonly runTrust: RunTrustMinter;
  readonly trust: TrustRegistry;
}
