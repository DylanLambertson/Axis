// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { markDiscardConfirmed, type DiscardConfirmation, type DiscardOp } from '../src/daemonConfirm.js';
import { createExecGitRunner, WorktreeManager, type ExpectedWorktree, type WorktreeManagerOptions } from '../src/index.js';

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'init.defaultBranch=main', ...args,
  ], { cwd, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1' } });
}

export interface Fixture {
  readonly tmp: string;
  readonly repo: string;
  readonly root: string;
  readonly manager: WorktreeManager;
  cleanup(): void;
}

export function write(file: string, content: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export function makeFixture(extra: Partial<WorktreeManagerOptions> = {}): Fixture {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'axis-wt-test-')));
  const repo = path.join(tmp, 'repo');
  const root = path.join(tmp, 'wt-root');
  mkdirSync(repo);
  sh(repo, 'init', '-q');
  write(path.join(repo, 'a.txt'), 'alpha\n');
  write(path.join(repo, 'sub', 'b.txt'), 'bravo\n');
  write(path.join(repo, 'run.sh'), '#!/bin/sh\necho hi\n');
  write(path.join(repo, '.gitignore'), 'ignored.log\n');
  chmodSync(path.join(repo, 'run.sh'), 0o755);
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'init');
  const manager = new WorktreeManager({
    runner: createExecGitRunner(), worktreeRoot: root, ...extra,
  });
  return {
    tmp, repo, root, manager,
    cleanup() {
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** HEAD, porcelain status and index bytes of a checkout: must not change. */
export function checkoutFingerprint(repo: string): string {
  const index = createHash('sha256').update(readFileSync(path.join(repo, '.git', 'index'))).digest('hex');
  return [sh(repo, 'rev-parse', 'HEAD'), sh(repo, 'status', '--porcelain=v1', '--untracked-files=all'), index].join('|');
}

/** Mints a confirmation bound to what the workspace would discard right now. */
export async function confirmFor(m: WorktreeManager, wtPath: string, id: string, op: DiscardOp): Promise<DiscardConfirmation> {
  const scan = await m.previewDiscard(wtPath, exp(wtPath));
  return markDiscardConfirmed({ workspaceId: id, op, fingerprint: scan.fingerprint });
}

/**
 * What a caller that resolved the workspace at (or under) `p` right now would pass as the expected worktree: the
 * canonical root of the linked worktree containing `p`, and the id in its record. Reads the disk at call time, so it
 * cannot detect a swap that happens before it (tests of that build the stale value first).
 */
export function exp(p: string): ExpectedWorktree {
  let start = p;
  const isDir = (x: string): boolean => {
    try {
      return lstatSync(x).isDirectory();
    } catch {
      return false;
    }
  };
  while (!isDir(start)) start = path.dirname(start);
  let dir = realpathSync(start);
  const origin = dir;
  for (;;) {
    const dot = path.join(dir, '.git');
    if (existsSync(dot) && statSync(dot).isFile()) break;
    const up = path.dirname(dir);
    if (up === dir) return { path: origin, id: 'ws-none' }; // not inside a linked worktree: a value that names no workspace
    dir = up;
  }
  const gitdir = /^gitdir: (.+)$/m.exec(readFileSync(path.join(dir, '.git'), 'utf8'))?.[1] ?? '';
  try {
    const rec = path.join(gitdir, 'axis-workspace.json');
    if (!lstatSync(rec).isFile()) throw new Error('not a regular record'); // never open a FIFO: it would block
    const meta = JSON.parse(readFileSync(rec, 'utf8')) as { id: string };
    return { path: dir, id: meta.id };
  } catch {
    return { path: dir, id: 'ws-none' }; // an unmanaged worktree or a corrupt record: a value that names no workspace
  }
}
