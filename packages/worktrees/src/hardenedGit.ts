// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { chmodSync, mkdirSync, promises as fsp } from 'node:fs';
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
 * Supplies `core.hooksPath` for every daemon git call. On POSIX this is
 * `/dev/null`: git then looks for `/dev/null/<hook>`, gets ENOTDIR and runs
 * nothing, and there is no directory an attacker could write into. Windows has
 * no such device, so a read-only directory under the app-data root is used and
 * checked to be empty immediately before every call (fail closed).
 */
export interface HooksGuard {
  readonly path: string;
  assertEmpty(): Promise<void>;
}

export function createHooksGuard(platform: NodeJS.Platform, emptyDir?: string): HooksGuard {
  if (platform !== 'win32') return { path: '/dev/null', assertEmpty: async () => undefined };
  if (!emptyDir) {
    throw new WorktreeError('E_INVALID_ARGUMENT', 'Windows needs an empty hooks directory under the app-data root');
  }
  mkdirSync(emptyDir, { recursive: true });
  try {
    chmodSync(emptyDir, 0o555);
  } catch {
    // best effort: the emptiness check below is the real control
  }
  return {
    path: emptyDir,
    async assertEmpty() {
      const entries = await fsp.readdir(emptyDir).catch(() => ['<unreadable>']);
      if (entries.length !== 0) {
        throw new WorktreeError('E_POLICY_DENIED', 'the empty hooks directory is not empty; refusing to run git', {
          reason: 'hooks-dir-tampered',
        });
      }
    },
  };
}

/** Strips `user:password@` from URLs so credentials never reach error details. */
export function redact(text: string): string {
  return text.replace(/(\w[\w+.-]*:\/\/)[^/@\s]+@/g, '$1***@');
}

/** Subcommands that never run filter drivers, so they skip the per-call filter scan. */
function runsNoFilters(args: readonly string[]): boolean {
  const [sub, second] = args;
  switch (sub) {
    case 'config': case 'rev-parse': case 'symbolic-ref': case 'show-ref': case 'check-ref-format':
    case 'for-each-ref': case 'update-ref': case 'branch': case 'merge-base': case 'rev-list':
    case 'ls-tree': case 'cat-file': case 'ls-files': case 'write-tree': case 'commit-tree':
      return true;
    case 'worktree':
      return second === 'list' || second === 'lock' || second === 'unlock' || second === 'prune';
    case 'read-tree':
      return !args.includes('-u');
    case 'hash-object':
      return args.includes('--no-filters');
    case 'update-index':
      return args.includes('--index-info');
    default:
      return false;
  }
}

/**
 * Every daemon git call except commit and push (design 5.3 invariant 4):
 * hooks off, core.fsmonitor=false, no signing, literal pathspecs, and every
 * configured filter driver (clean, smudge, process) blanked, so nothing the
 * repository configuration names can execute in the daemon.
 */
export class HardenedGit {
  constructor(
    private readonly runner: GitRunner,
    private readonly hooks: HooksGuard,
  ) {}

  private prefix(noOptionalLocks: boolean | undefined): string[] {
    return [
      '--literal-pathspecs',
      '-c', `core.hooksPath=${this.hooks.path}`,
      '-c', 'core.fsmonitor=false',
      '-c', 'commit.gpgsign=false',
      '-c', 'core.askPass=',
      ...(noOptionalLocks ? ['--no-optional-locks'] : []),
    ];
  }

  /** `-c filter.<n>.{clean,smudge,process}=` for every filter named in any config scope. */
  private async filterOverrides(cwd: string): Promise<string[]> {
    await this.hooks.assertEmpty();
    const res = await this.runner.run(
      [...this.prefix(true), 'config', '--null', '--name-only', '--get-regexp', '^filter\\.'],
      { cwd },
    );
    const names = new Set<string>();
    for (const key of res.stdout.split('\0')) {
      const m = /^filter\.(.+)\.[^.]+$/is.exec(key);
      if (m?.[1]) names.add(m[1]);
    }
    const out: string[] = [];
    for (const n of names) {
      if (n.includes('=') || n.includes('\n')) {
        throw new WorktreeError('E_POLICY_DENIED', 'a filter driver name cannot be neutralised', { reason: 'filter-name' });
      }
      out.push(
        '-c', `filter.${n}.clean=`, '-c', `filter.${n}.smudge=`,
        '-c', `filter.${n}.process=`, '-c', `filter.${n}.required=false`,
      );
    }
    return out;
  }

  async run(args: readonly string[], opts: HardenedRunOptions): Promise<GitResult> {
    await this.hooks.assertEmpty();
    const filters = runsNoFilters(args) ? [] : await this.filterOverrides(opts.cwd);
    const result = await this.runner.run([...this.prefix(opts.noOptionalLocks), ...filters, ...args], {
      cwd: opts.cwd,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(opts.extraEnv ? { extraEnv: opts.extraEnv } : {}),
    });
    if (result.code !== 0 && !opts.allowFailure) {
      throw new WorktreeError('E_INTERNAL', `git ${args[0] ?? ''} failed (exit ${result.code})`, {
        git: true,
        args: args.slice(0, 4),
        stderr: redact(result.stderr).slice(0, 2000),
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
