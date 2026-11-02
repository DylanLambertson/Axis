// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { WorktreeError } from './errors.js';
import type { GitResult, GitRunner } from './git.js';

export interface HardenedRunOptions {
  readonly cwd: string;
  readonly input?: string | Buffer;
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** Return non-zero exits to the caller instead of throwing E_INTERNAL. */
  readonly allowFailure?: boolean;
  /** Skip optional index refreshes (for read-only status calls). */
  readonly noOptionalLocks?: boolean;
}

/**
 * Every daemon git call except commit and push (design 5.3 invariant 4):
 * an empty hooks path, core.fsmonitor=false, no commit signing, and the
 * GIT-ENV-1 environment supplied by the runner.
 */
export class HardenedGit {
  constructor(
    private readonly runner: GitRunner,
    private readonly emptyHooksDir: string,
  ) {}

  async run(args: readonly string[], opts: HardenedRunOptions): Promise<GitResult> {
    const prefix = [
      '-c', `core.hooksPath=${this.emptyHooksDir}`,
      '-c', 'core.fsmonitor=false',
      '-c', 'commit.gpgsign=false',
      '-c', 'core.askPass=',
      ...(opts.noOptionalLocks ? ['--no-optional-locks'] : []),
    ];
    const result = await this.runner.run([...prefix, ...args], {
      cwd: opts.cwd,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(opts.extraEnv ? { extraEnv: opts.extraEnv } : {}),
    });
    if (result.code !== 0 && !opts.allowFailure) {
      throw new WorktreeError('E_INTERNAL', `git ${args[0] ?? ''} failed (exit ${result.code})`, {
        args: args.slice(0, 4),
        stderr: result.stderr.slice(0, 2000),
      });
    }
    return result;
  }

  async text(args: readonly string[], opts: HardenedRunOptions): Promise<string> {
    return (await this.run(args, opts)).stdout.trim();
  }

  /** True when the command exits 0. */
  async ok(args: readonly string[], opts: Omit<HardenedRunOptions, 'allowFailure'>): Promise<boolean> {
    return (await this.run(args, { ...opts, allowFailure: true })).code === 0;
  }
}
