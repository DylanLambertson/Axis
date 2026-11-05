// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { GitRunner } from "@axis/git-ops";

/**
 * The two git runners `@axis/git-ops` takes (`GitContext`). `daemon` runs in the host with hooks off; `pty` runs in
 * the Axis pty process, which holds no secrets and may run repository hooks when policy allows.
 */
export interface GitRunners {
  readonly daemon: GitRunner;
  readonly pty: GitRunner;
}
