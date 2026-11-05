// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { projectDirName, resolveRepo, type RepoLocation, type WorktreeEntry } from './discovery.js';
import { WorktreeError } from './errors.js';
import { ensureDirChain, mkdirSafe, privateDir } from './fsSafe.js';
import type { GitSnapshot } from './gitSnap.js';
import type { HardenedGit } from './hardenedGit.js';
import { readMeta, writeBaseline, writeMeta } from './meta.js';
import { canonicalise, isSameOrInside, validateWorktreeRoot, type ProtectedLocation } from './paths.js';
import { populateFilterFree } from './populate.js';
import { deleteRefIf, writeSnapshotRef } from './snapshotRef.js';
import type { CreatedWorkspace } from './types.js';

/** What `createWorkspace` needs from the manager. */
export interface CreateHost {
  readonly git: HardenedGit;
  readonly worktreeRoot: string;
  readonly platform: NodeJS.Platform;
  readonly now: () => Date;
  readonly maxFile: number;
  listRaw(repo: RepoLocation): Promise<WorktreeEntry[]>;
  protectedLocations(repo: RepoLocation, localCheckout: string | null): Promise<ProtectedLocation[]>;
  takeGitSnapshot(worktree: string, commonDir: string): Promise<GitSnapshot>;
  /** Refuses (E_POLICY_DENIED) when this workspace has unacknowledged execution drift. */
  assertExecutionClean(worktree: string): Promise<void>;
  assertGitTrusted(extra: readonly ProtectedLocation[]): Promise<void>;
}

export interface CreateParams {
  readonly slug: string;
  readonly id: string;
  readonly baseRef: string;
}

/** Runs inside the project lock. */
export async function createWorkspace(host: CreateHost, repo: RepoLocation, p: CreateParams): Promise<CreatedWorkspace> {
  const { git } = host;
  const cwd = repo.workTree ?? repo.commonDir;
  const entries = await host.listRaw(repo);
  const main = entries[0];
  const localCheckout = main && !main.bare ? await canonicalise(main.path) : null;

  const protectedLocs = await host.protectedLocations(repo, localCheckout);
  await host.assertGitTrusted(protectedLocs);
  const root = await validateWorktreeRoot(host.worktreeRoot, protectedLocs, host.platform);

  // Other Axis workspaces of this repository: ids must be unique and none may carry unreviewed drift.
  for (const e of entries.slice(1)) {
    const wt = await fs.realpath(e.path).catch(() => null);
    if (wt === null || !isSameOrInside(wt, root, host.platform)) continue;
    const meta = await readMeta((await resolveRepo(wt)).gitDir).catch(() => null);
    if (!meta) continue;
    if (meta.id === p.id) throw new WorktreeError('E_CONFLICT', 'workspace id already in use', { reason: 'id-exists' });
    await host.assertExecutionClean(wt);
  }

  await ensureDirChain(root);
  if ((await fs.realpath(root)) !== root) throw new WorktreeError('E_POLICY_DENIED', 'worktree root changed during the operation');
  const projName = projectDirName(repo.commonDir, localCheckout, host.platform);
  const projDir = await mkdirSafe(root, [projName]);
  if ((await fs.realpath(projDir)) !== projDir) {
    throw new WorktreeError('E_POLICY_DENIED', 'project directory is a symlink or escapes the worktree root');
  }
  const wtPath = path.join(projDir, p.slug);
  for (const loc of protectedLocs) {
    if (isSameOrInside(wtPath, loc.path, host.platform)) {
      throw new WorktreeError('E_POLICY_DENIED', `worktree path is inside ${loc.label}`);
    }
  }
  if (await fs.lstat(wtPath).then(() => true, () => false)) {
    throw new WorktreeError('E_CONFLICT', 'worktree path already exists', { reason: 'path-exists' });
  }

  const branch = `axis/${p.slug}`;
  if (!(await git.ok(['check-ref-format', '--branch', branch], { cwd }))) {
    throw new WorktreeError('E_INVALID_ARGUMENT', 'slug does not form a valid branch name', { branch });
  }
  if (await git.ok(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd })) {
    throw new WorktreeError('E_CONFLICT', 'branch already exists', { reason: 'branch-exists', branch });
  }
  const runBaseRef = `refs/axis/runbase/${p.id}`;
  for (const ref of [runBaseRef, `refs/axis/archive/${p.id}`]) {
    if (await git.ok(['show-ref', '--verify', '--quiet', ref], { cwd })) {
      throw new WorktreeError('E_CONFLICT', 'workspace id already in use', { reason: 'id-exists' });
    }
  }
  // The base is resolved exactly once, here; everything below uses the SHA.
  const resolved = await git.run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${p.baseRef}^{commit}`], { cwd, allowFailure: true });
  const baseSha = resolved.stdout.trim();
  if (resolved.code !== 0 || !baseSha) {
    throw new WorktreeError('E_NOT_FOUND', 'base ref does not resolve to a commit', { baseRef: p.baseRef });
  }
  let baseBranch: string | null = null;
  if (p.baseRef === 'HEAD') {
    const sym = await git.run(['symbolic-ref', '-q', 'HEAD'], { cwd, allowFailure: true });
    baseBranch = sym.code === 0 ? sym.stdout.trim() : null;
  } else {
    const full = p.baseRef.startsWith('refs/heads/') ? p.baseRef : `refs/heads/${p.baseRef}`;
    baseBranch = (await git.ok(['show-ref', '--verify', '--quiet', full], { cwd })) ? full : null;
  }

  const scratchDir = await privateDir(path.join(root, '.axis-tmp'));
  let runBaseSha: string | null = null;
  try {
    await git.run(['worktree', 'add', '--no-checkout', '-b', branch, '--', wtPath, baseSha], { cwd });
    await git.run(['worktree', 'lock', '--reason', `axis:${p.id}`, '--', wtPath], { cwd });
    await populateFilterFree(git, wtPath);
    const wt = await resolveRepo(wtPath);
    const snap = await writeSnapshotRef(git, wtPath, runBaseRef, `axis run base ${p.id}`, host.maxFile, scratchDir);
    runBaseSha = snap.commit;
    await writeMeta(wt.gitDir, {
      version: 1, id: p.id, slug: p.slug, branch, baseRef: p.baseRef, baseSha, baseBranch, runBaseSha,
      createdAt: host.now().toISOString(), state: 'READY', outcome: null,
    });
    await writeBaseline(wt.gitDir, await host.takeGitSnapshot(wtPath, repo.commonDir));
    return {
      id: p.id, slug: p.slug, branch, path: wtPath, baseRef: p.baseRef, baseSha, runBaseRef,
      skippedLarge: snap.skippedLarge, localCheckout,
    };
  } catch (e) {
    // Roll back only what this call made: the branch did not exist before and the path was absent.
    await git.run(['worktree', 'unlock', '--', wtPath], { cwd, allowFailure: true });
    await git.run(['worktree', 'remove', '--force', '--', wtPath], { cwd, allowFailure: true });
    await fs.rm(wtPath, { recursive: true, force: true });
    await git.run(['worktree', 'prune'], { cwd, allowFailure: true });
    // Only a branch still at the commit we created it on: never delete one somebody else made or moved.
    await deleteRefIf(git, cwd, `refs/heads/${branch}`, baseSha);
    if (runBaseSha) await deleteRefIf(git, cwd, runBaseRef, runBaseSha);
    throw e;
  }
}
