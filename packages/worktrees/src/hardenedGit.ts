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
  /** Overrides the instance default (`DEFAULT_GIT_TIMEOUT_MS`). */
  readonly timeoutMs?: number;
}

/** A git call that has not finished by then is killed and fails with E_INTERNAL, so a hung git never holds a lock. */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

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

interface Shape {
  /** Flags allowed anywhere before `--` / `--end-of-options`. */
  readonly flags?: readonly string[];
  /** Flags that take the next argument as their value. */
  readonly valued?: readonly string[];
  /** Flags allowed in `--name=value` form. */
  readonly prefixed?: readonly string[];
  /** Flags that must be present. */
  readonly required?: readonly string[];
  /** False when the command must take no positional argument (such as a path). */
  readonly positional?: boolean;
  /** Upper bound on positional arguments (a second one would turn a read into a write). */
  readonly maxPositional?: number;
}

/**
 * The exact command shapes the manager uses (a test pins every call), keyed by
 * subcommand, or `worktree <op>`. None of them reads a working file through
 * attributes, checks a file out, or starts an editor, so no filter driver or
 * configured program can run. Anything else, including any other flag, is
 * refused: widening a shape needs proof that it stays filter-free.
 */
const SHAPES: Readonly<Record<string, Shape>> = {
  'config': { flags: ['--null', '--list', '--show-origin', '--show-scope'], required: ['--null', '--list'], positional: false },
  'rev-parse': { flags: ['--verify', '--quiet', '--git-path'] },
  'symbolic-ref': { flags: ['-q', '--short'], maxPositional: 1 },
  'show-ref': { flags: ['--verify', '--quiet'] },
  'check-ref-format': { flags: ['--branch'] },
  'for-each-ref': { prefixed: ['--format='] },
  'update-ref': { flags: ['-d'] },
  'branch': { flags: ['-D'], required: ['-D'] },
  'merge-base': { flags: ['--is-ancestor'] },
  'rev-list': { flags: ['--left-right', '--count'] },
  'ls-tree': { flags: ['-r', '-z', '-l', '--full-tree'] },
  'cat-file': { flags: ['--batch', '--batch-check'] },
  'ls-files': { flags: ['-z', '-s', '--cached', '--others', '--exclude-standard', '--ignored', '--directory'], positional: false },
  'write-tree': { positional: false },
  'commit-tree': { valued: ['-p', '-m'] },
  'read-tree': {},
  'hash-object': { flags: ['-w', '--no-filters', '--stdin'], required: ['--no-filters', '--stdin'], positional: false },
  'update-index': { flags: ['-z', '--index-info'], required: ['--index-info'], positional: false },
  'worktree add': { flags: ['--no-checkout'], valued: ['-b'], required: ['--no-checkout'] },
  'worktree lock': { valued: ['--reason'] },
  'worktree unlock': {},
  'worktree remove': { flags: ['--force'], required: ['--force'] },
  'worktree prune': { positional: false },
  'worktree list': { flags: ['--porcelain', '-z'], positional: false },
};

/** The only variables a caller may add to git's environment: a temporary index, and the two that make the merged check ignore replace refs and grafts. */
const CALLER_ENV = new Set(['GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_GRAFT_FILE']);

/** Leading `-c` pairs a caller may add (commit identity only); any other global option is refused. */
const CALLER_CONFIG = /^user\.(name|email)=/;

function fits(shape: Shape, rest: readonly string[]): boolean {
  const seen = new Set<string>();
  let literal = false;
  let positionals = 0;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (literal || !a.startsWith('-') || a === '-') {
      if (shape.positional === false || ++positionals > (shape.maxPositional ?? Infinity)) return false;
    } else if (a === '--' || a === '--end-of-options') {
      literal = true;
    } else if (shape.flags?.includes(a)) {
      seen.add(a);
    } else if (shape.valued?.includes(a)) {
      if (++i >= rest.length) return false;
    } else if (!shape.prefixed?.some((p) => a.startsWith(p))) {
      return false;
    }
  }
  return (shape.required ?? []).every((r) => seen.has(r));
}

/**
 * True only for a command that matches one of `SHAPES` exactly. `run()`
 * refuses everything else instead of trying to neutralise filters with a scan
 * of the (agent-writable) configuration, which would be a time-of-check race.
 */
export function runsNoFilters(args: readonly string[]): boolean {
  let i = 0;
  while (args[i] === '-c') {
    if (!CALLER_CONFIG.test(args[i + 1] ?? '')) return false;
    i += 2;
  }
  const sub = args[i];
  const key = sub === 'worktree' ? `worktree ${args[i + 1] ?? ''}` : sub;
  if (key === undefined || !Object.hasOwn(SHAPES, key)) return false;
  return fits(SHAPES[key] as Shape, args.slice(i + (sub === 'worktree' ? 2 : 1)));
}

/**
 * Every daemon git call except commit and push (design 5.3 invariant 4):
 * hooks off, core.fsmonitor=false, no signing, literal pathspecs, a timeout,
 * and only command shapes that cannot start a filter driver (clean, smudge,
 * process) or an editor (`runsNoFilters`); any other command is refused, so
 * nothing the repository configuration names can execute in the daemon.
 */
export class HardenedGit {
  private readonly timeoutMs: number;

  constructor(
    private readonly runner: GitRunner,
    private readonly hooks: HooksGuard,
    options: { readonly timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  }

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

  async run(args: readonly string[], opts: HardenedRunOptions): Promise<GitResult> {
    if (!runsNoFilters(args)) {
      // Fail closed: a command that cannot be shown filter-free never runs (NB-2, R3-3).
      throw new WorktreeError('E_INTERNAL', 'refusing a git command that is not on the filter-free allow-list', {
        reason: 'git-command-refused', args: args.slice(0, 4),
      });
    }
    const badEnv = Object.keys(opts.extraEnv ?? {}).filter((k) => !CALLER_ENV.has(k));
    if (badEnv.length > 0) {
      // GIT_DIR, GIT_CONFIG_PARAMETERS, GIT_EXEC_PATH and the like would bypass the shape check (R4-2).
      throw new WorktreeError('E_INTERNAL', 'refusing a git environment variable that is not allow-listed', {
        reason: 'git-env-refused', names: badEnv.slice(0, 4),
      });
    }
    await this.hooks.assertInert();
    const result = await this.runner.run([...this.prefix(opts.noOptionalLocks), ...args], {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
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
