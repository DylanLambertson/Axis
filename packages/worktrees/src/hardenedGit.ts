// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { mkdirSync, promises as fsp, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
 * no such device, so the path is a daemon-owned zero-byte regular FILE under
 * the app-data root: `<file>\<hook>` fails the same way, and there is nothing
 * to plant a hook into. `assertInert` still checks, before every call, that it
 * is still that file (fail closed).
 */
export interface HooksGuard {
  readonly path: string;
  assertInert(): Promise<void>;
}

export function createHooksGuard(platform: NodeJS.Platform, noHooksFile?: string): HooksGuard {
  if (platform !== 'win32') return { path: '/dev/null', assertInert: async () => undefined };
  if (!noHooksFile) {
    throw new WorktreeError('E_INVALID_ARGUMENT', 'Windows needs a no-hooks file under the app-data root');
  }
  mkdirSync(dirname(noHooksFile), { recursive: true });
  try {
    writeFileSync(noHooksFile, '', { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const check = async (): Promise<boolean> => {
    const st = await fsp.lstat(noHooksFile).catch(() => null);
    return st !== null && st.isFile() && st.size === 0;
  };
  return {
    path: noHooksFile,
    async assertInert() {
      if (!(await check())) {
        throw new WorktreeError('E_POLICY_DENIED', 'the no-hooks file is missing or not an empty regular file; refusing to run git', {
          reason: 'hooks-guard-tampered',
        });
      }
    },
  };
}

/** Strips `user:password@` from URLs so credentials never reach error details. */
export function redact(text: string): string {
  return text.replace(/(\w[\w+.-]*:\/\/)[^/\s]*@/g, '$1***@');
}

/** Skips leading `-c key=value` pairs and global flags to find the git subcommand. */
function subcommandOf(args: readonly string[]): { sub: string | undefined; rest: readonly string[] } {
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (a === '-c' || a === '-C') i += 2;
    else if (a.startsWith('--') && a.length > 2 && !a.startsWith('--end')) i += 1;
    else break;
  }
  return { sub: args[i], rest: args.slice(i + 1) };
}

/**
 * Allow-list of git commands that cannot invoke a filter driver, because they
 * neither read the working tree through attributes nor check files out. Only
 * these are used by the manager (a test pins this). They skip the per-call
 * filter scan, which would otherwise be a time-of-check race (the repository
 * configuration is agent-writable): a command that is not on this list gets
 * `-c filter.<n>.*` overrides built from a scan taken just before the call,
 * which is best effort only and can lose that race. Do not add such a
 * command to the daemon.
 */
export function runsNoFilters(args: readonly string[]): boolean {
  const { sub, rest } = subcommandOf(args);
  switch (sub) {
    case 'config': case 'rev-parse': case 'symbolic-ref': case 'show-ref': case 'check-ref-format':
    case 'for-each-ref': case 'update-ref': case 'branch': case 'merge-base': case 'rev-list':
    case 'ls-tree': case 'cat-file': case 'ls-files': case 'write-tree': case 'commit-tree':
      return !rest.includes('--filters') && !rest.includes('--textconv') && !rest.includes('--eol');
    case 'worktree': {
      const op = rest[0];
      if (op === 'add') return rest.includes('--no-checkout');
      if (op === 'remove') return rest.includes('--force');
      return op === 'list' || op === 'lock' || op === 'unlock' || op === 'prune';
    }
    case 'read-tree':
      return !rest.includes('-u') && !rest.includes('-m');
    case 'hash-object':
      return rest.includes('--no-filters');
    case 'update-index':
      return rest.includes('--index-info') && !rest.includes('--refresh') && !rest.includes('--really-refresh');
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
    await this.hooks.assertInert();
    const res = await this.runner.run(
      [...this.prefix(true), 'config', '--null', '--name-only', '--get-regexp', '^filter\\.'],
      { cwd },
    );
    const names = new Set<string>();
    for (const key of res.stdout.split('\0')) {
      if (key === '') continue;
      // The name may be empty (`[filter ""]` is `filter..clean`) or contain dots.
      const m = /^filter\.(.*)\.([^.]+)$/is.exec(key);
      if (!m) {
        throw new WorktreeError('E_POLICY_DENIED', 'a filter configuration key cannot be neutralised', { reason: 'filter-name' });
      }
      names.add(m[1] as string);
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
    await this.hooks.assertInert();
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
