// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import * as path from 'node:path';
import { WorktreeError } from './errors.js';

export interface GitRunOptions {
  readonly cwd: string;
  /** Written to the child's stdin, then stdin is closed. */
  readonly input?: string | Buffer;
  /**
   * Explicit additions on top of GIT-ENV-1. Used for the few variables Axis
   * sets itself (for example GIT_INDEX_FILE for a temporary index). Never
   * populated from the ambient environment.
   */
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Unmodified stdout bytes, for binary blobs. */
  readonly raw: Buffer;
}

/** The only door to the git CLI. Tests and the daemon can substitute their own. */
export interface GitRunner {
  /** Absolute path of the pinned git executable, when the runner knows it. */
  readonly gitPath?: string;
  /** Resolves with the exit code; rejects with E_INTERNAL only when git cannot run. */
  run(args: readonly string[], options: GitRunOptions): Promise<GitResult>;
}

const UNIX_ALLOW = new Set(['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR']);
const WIN_ALLOW = new Set([
  'PATH', 'PATHEXT', 'HOME', 'USER', 'USERNAME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'LANG', 'TEMP', 'TMP', 'TMPDIR', 'SYSTEMROOT', 'WINDIR', 'LOCALAPPDATA', 'APPDATA', 'COMSPEC',
]);

/**
 * GIT-ENV-1 (policies 6.5): an allow-list taken from the resolved environment
 * (PATH, HOME, USER, LANG, LC_*, TMPDIR) plus GIT_TERMINAL_PROMPT=0. Every
 * other variable is dropped, which removes all GIT_* names, credential
 * helpers' variables, SSH_AUTH_SOCK, proxy settings and tokens.
 */
export function buildGitEnv(
  base: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const win = platform === 'win32';
  const allow = win ? WIN_ALLOW : UNIX_ALLOW;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const key = win ? name.toUpperCase() : name;
    if (allow.has(key) || key.startsWith('LC_')) out[name] = value;
  }
  out['GIT_TERMINAL_PROMPT'] = '0';
  return out;
}

export interface ExecGitRunnerOptions {
  readonly gitPath?: string;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly maxOutputBytes?: number;
}

/**
 * Resolves git to an absolute path once. A relative or bare name is searched
 * for in the absolute directories of PATH only, so a project-relative entry
 * such as ./node_modules/.bin can never supply the binary.
 */
export function resolveGitPath(
  explicit: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): string {
  if (explicit && path.isAbsolute(explicit)) return explicit;
  const exe = explicit ?? (platform === 'win32' ? 'git.exe' : 'git');
  const rawPath = env['PATH'] ?? env['Path'] ?? '';
  for (const dir of rawPath.split(platform === 'win32' ? ';' : ':')) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, exe);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep searching
    }
  }
  throw new WorktreeError('E_NOT_FOUND', 'git executable not found in an absolute PATH directory');
}

/** Real runner: spawns git directly with an argument vector, never a shell. */
export function createExecGitRunner(options: ExecGitRunnerOptions = {}): GitRunner {
  const gitPath = resolveGitPath(options.gitPath, options.baseEnv ?? process.env, options.platform);
  const maxBytes = options.maxOutputBytes ?? 256 * 1024 * 1024;
  return {
    gitPath,
    run(args, opts) {
      const env = {
        ...buildGitEnv(options.baseEnv ?? process.env, options.platform),
        ...opts.extraEnv,
      };
      return new Promise<GitResult>((resolve, reject) => {
        const child = spawn(gitPath, [...args], {
          cwd: opts.cwd,
          env,
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let size = 0;
        let settled = false;
        const fail = (e: WorktreeError): void => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          reject(e);
        };
        const timer = opts.timeoutMs
          ? setTimeout(() => fail(new WorktreeError('E_INTERNAL', 'git timed out', { args: args.slice(0, 3) })), opts.timeoutMs)
          : undefined;
        child.stdout.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) fail(new WorktreeError('E_INTERNAL', 'git output exceeded limit'));
          else out.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          if (err.length < 64) err.push(chunk);
        });
        child.on('error', (e) => {
          if (timer) clearTimeout(timer);
          fail(new WorktreeError('E_INTERNAL', `cannot run git: ${e.message}`));
        });
        child.stdin.on('error', () => undefined);
        child.on('close', (code) => {
          if (timer) clearTimeout(timer);
          if (settled) return;
          settled = true;
          const raw = Buffer.concat(out);
          resolve({
            code: code ?? -1,
            stdout: raw.toString('utf8'),
            stderr: Buffer.concat(err).toString('utf8'),
            raw,
          });
        });
        if (opts.input !== undefined) child.stdin.end(opts.input);
        else child.stdin.end();
      });
    },
  };
}
