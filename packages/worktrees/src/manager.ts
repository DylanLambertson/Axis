// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { DiscardConfirmation } from './confirmation.js';
import { createWorkspace, type CreateHost } from './createWorkspace.js';
import { parseWorktreeList, resolveRepo, type RepoLocation } from './discovery.js';
import { readDirty, requireDiscardConfirmation, scanDiscard, type DiscardScan } from './discard.js';
import { removeWorkspace } from './removeWorkspace.js';
import { toWorktreeError, WorktreeError } from './errors.js';
import type { GitRunner } from './git.js';
import {
  buildGitSnapshot, diffGitSnapshots, includedConfigFiles, isExecutionDrift, parseConfigAll,
  snapshotExtraFiles, snapshotGuardFiles, watchedEntries, type GitSnapshot,
} from './gitSnap.js';
import { createHooksGuard, HardenedGit } from './hardenedGit.js';
import { privateDir } from './fsSafe.js';
import { acquireFileLock } from './lock.js';
import {
  IdSchema, SlugSchema, readBaseline, readMeta, writeBaseline, writeMeta, type WorkspaceMeta,
} from './meta.js';
import {
  assertNoTraversal, canonicalise, isSameOrInside, type ProtectedLocation,
} from './paths.js';
import { hasGitComponent, isOutsideRel } from './pathGuard.js';
import { parseLsTree, writeRestoredEntry } from './restore.js';
import { MAX_SNAPSHOT_FILE_BYTES, createRefOnce, deleteRefIf, writeSnapshotRef } from './snapshotRef.js';
import type {
  CreateInput, CreatedWorkspace, FinaliseOutcome, FinaliseResult, RemoveResult, RestoreResult,
  WorkspaceStatus, WorktreeInfo,
} from './types.js';
import * as os from 'node:os';
import {
  BACKUP_RETENTION_DAYS, DAY_MS, RUNBASE_RETENTION_DAYS, invalid, type ActiveRunOp, type Located, type WorktreeManagerOptions,
} from './managerOptions.js';

export { BACKUP_RETENTION_DAYS, RUNBASE_RETENTION_DAYS, type ActiveRunOp, type WorktreeManagerOptions };

/**
 * Worktree lifecycle for one daemon. CONCURRENCY: mutating operations are
 * serialised per repository by an in-process mutex plus pid/start-time
 * lockfiles (see `withLock`), and workspace records are re-read under that lock. The in-process mutex assumes exactly one manager instance per
 * daemon process and one daemon per user; the lockfile covers stray processes.
 * Every public method maps any failure into the closed WorktreeError set.
 */
export class WorktreeManager {
  private readonly git: HardenedGit;
  private readonly runner: GitRunner;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => Date;
  private readonly maxFile: number;
  private readonly locks = new Map<string, Promise<unknown>>();
  private gitChecked: Promise<void> | null = null;

  constructor(private readonly options: WorktreeManagerOptions) {
    this.runner = options.runner;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? (() => new Date());
    this.maxFile = options.maxSnapshotFileBytes ?? MAX_SNAPSHOT_FILE_BYTES;
    const emptyDir = options.windowsNoHooksFile ?? path.win32.join(path.win32.dirname(options.worktreeRoot), 'nohooks');
    this.git = new HardenedGit(this.runner, createHooksGuard(this.platform, emptyDir));
  }

  // ---- public API (each wrapped in the error boundary) ----------------------

  list(repoPath: string): Promise<WorktreeInfo[]> {
    return this.boundary(() => this.listImpl(repoPath));
  }

  create(input: CreateInput): Promise<CreatedWorkspace> {
    return this.boundary(() => this.createImpl(input));
  }

  status(worktreePath: string, opts: { baseline?: GitSnapshot } = {}): Promise<WorkspaceStatus> {
    return this.boundary(() => this.statusImpl(worktreePath, opts));
  }

  takeGitSnapshot(worktreePath: string, commonDir?: string): Promise<GitSnapshot> {
    return this.boundary(() => this.snapshotImpl(worktreePath, commonDir));
  }

  /** The user reviewed the drift: the current state becomes the new baseline. */
  acknowledgeDrift(worktreePath: string): Promise<GitSnapshot> {
    return this.boundary(() =>
      this.withWorkspace(worktreePath, true, null, async ({ repo, workTree }) => {
        const snap = await this.snapshotImpl(workTree, repo.commonDir);
        await writeBaseline(repo.gitDir, snap);
        return snap;
      }));
  }

  /**
   * Call before push and any other action that must not run on changed git
   * configuration: re-takes GIT-SNAP-1 and refuses (E_CONFLICT, reason
   * 'git-drift') unless it matches the acknowledged baseline. Fails closed
   * when no baseline exists.
   */
  assertNoDrift(worktreePath: string, opts: { baseline?: GitSnapshot } = {}): Promise<void> {
    return this.boundary(async () => {
      const { repo, workTree } = await this.locate(worktreePath, true);
      const baseline = opts.baseline ?? (await readBaseline(repo.gitDir));
      if (!baseline) {
        throw new WorktreeError('E_CONFLICT', 'git configuration baseline is missing', { reason: 'git-drift', baselineMissing: true, items: [] });
      }
      const drift = diffGitSnapshots(baseline, await this.snapshotImpl(workTree, repo.commonDir));
      if (drift.length > 0) {
        throw new WorktreeError('E_CONFLICT', 'git configuration or hooks changed since last acknowledged', {
          reason: 'git-drift', baselineMissing: false, items: drift.map((d) => d.id),
        });
      }
    });
  }

  /** What a finalise/remove would discard, with the fingerprint a confirmation must be bound to. */
  previewDiscard(worktreePath: string): Promise<DiscardScan> {
    return this.boundary(async () => {
      const { workTree } = await this.locate(worktreePath, true);
      return scanDiscard(this.git, workTree, this.maxFile);
    });
  }

  finalise(input: {
    path: string; outcome: FinaliseOutcome; discardConfirmation?: DiscardConfirmation;
  }): Promise<FinaliseResult> {
    return this.boundary(async () => {
      if (!['merged', 'archived', 'abandoned'].includes(input.outcome)) throw invalid('invalid outcome');
      return this.withWorkspace(input.path, true, 'finalise', async ({ repo, workTree, meta }) => {
        if (meta.state === 'FINALISED') throw new WorktreeError('E_CONFLICT', 'workspace is already finalised', { id: meta.id });
        await this.guardExecutionDrift(repo, workTree);
        const head = await this.git.text(['rev-parse', '--verify', '--end-of-options', 'HEAD'], { cwd: workTree });
        if (input.outcome === 'merged') {
          const target = meta.baseBranch;
          if (!target || !(await this.git.ok(['rev-parse', '--verify', '--quiet', '--end-of-options', target], { cwd: workTree }))) {
            throw new WorktreeError('E_CONFLICT', 'base branch is unavailable, cannot verify the merge', { reason: 'no-base-branch' });
          }
          if (!(await this.git.ok(['merge-base', '--is-ancestor', '--end-of-options', head, target], { cwd: workTree }))) {
            throw new WorktreeError('E_CONFLICT', 'workspace tip is not reachable from the base branch', { reason: 'not-merged', baseBranch: target });
          }
        }
        const scan = await scanDiscard(this.git, workTree, this.maxFile);
        const { needsBackup } = requireDiscardConfirmation('finalise', meta.id, scan, input.discardConfirmation);
        const backupRef = needsBackup ? await this.writeBackup(workTree, meta.id, 'finalise') : null;
        const archiveRef = `refs/axis/archive/${meta.id}`;
        await createRefOnce(this.git, workTree, archiveRef, head);
        await writeMeta(repo.gitDir, { ...meta, state: 'FINALISED', outcome: input.outcome });
        return { archiveRef, archiveSha: head, backupRef, outcome: input.outcome, skippedLarge: scan.skippedLarge };
      });
    });
  }

  remove(input: {
    path: string; deleteBranch?: boolean; discardConfirmation?: DiscardConfirmation;
  }): Promise<RemoveResult> {
    return this.boundary(() =>
      this.withWorkspace(input.path, true, 'remove', ({ repo, workTree, meta }) =>
        removeWorkspace(
          { git: this.git, maxFile: this.maxFile, guardExecutionDrift: (r, w) => this.guardExecutionDrift(r, w),
            writeBackup: (w, id, why) => this.writeBackup(w, id, why), now: () => this.now() },
          { repo, workTree, meta, deleteBranch: input.deleteBranch === true, token: input.discardConfirmation })));
  }

  /**
   * Restores one file to its content at the run base, after writing a backup
   * snapshot of the worktree. `runId` selects `refs/axis/runbase/<runId>`
   * (CLI runs); `expectedRunBaseSha` pins that ref's commit. By default the
   * workspace's creation snapshot is used and its recorded commit is enforced.
   */
  restoreFromRunBase(input: {
    path: string; runId?: string; expectedRunBaseSha?: string; expectedWorktree?: string;
  }): Promise<RestoreResult> {
    return this.boundary(async () => {
      assertNoTraversal(input.path, 'path');
      // A caller that has already checked ONE workspace names it: the path must lie under it with no symlinked
      // parent, and the worktree the path resolves to must be that same one (otherwise a symlink planted inside
      // workspace A would send the write to workspace B, past every check made for A).
      if (input.expectedWorktree !== undefined) await this.assertUnder(input.expectedWorktree, input.path);
      if (input.runId !== undefined && !IdSchema.safeParse(input.runId).success) throw invalid('invalid run id');
      const parent = await canonicalise(path.dirname(input.path));
      const target = path.join(parent, path.basename(input.path));
      let existing = parent;
      while (!(await fs.stat(existing).then(() => true, () => false))) existing = path.dirname(existing);
      return this.withWorkspace(existing, false, 'restore', async ({ repo, workTree, meta }) => {
        if (input.expectedWorktree !== undefined && (await canonicalise(input.expectedWorktree)) !== workTree) {
          throw new WorktreeError('E_POLICY_DENIED', 'path resolves into a different worktree', { reason: 'worktree-mismatch' });
        }
        const relPath = path.relative(workTree, target);
        if (relPath === '' || isOutsideRel(relPath) || !isSameOrInside(target, workTree, this.platform)) {
          throw new WorktreeError('E_POLICY_DENIED', 'path is outside the worktree');
        }
        const posix = relPath.split(path.sep).join('/');
        if (hasGitComponent(posix)) throw new WorktreeError('E_POLICY_DENIED', 'refusing to touch .git');
        await this.guardExecutionDrift(repo, workTree);
        const runBaseRef = `refs/axis/runbase/${input.runId ?? meta.id}`;
        // Pin the run base: resolve the ref once and use only the SHA from here on.
        const res = await this.git.run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${runBaseRef}^{commit}`], { cwd: workTree, allowFailure: true });
        const pinned = res.stdout.trim();
        if (res.code !== 0 || !pinned) throw new WorktreeError('E_NOT_FOUND', 'run base snapshot does not exist', { runBaseRef });
        const expected = input.expectedRunBaseSha ?? (input.runId === undefined ? meta.runBaseSha : undefined);
        if (expected !== undefined && expected !== pinned) {
          throw new WorktreeError('E_POLICY_DENIED', 'the run base ref no longer points at the recorded commit', { reason: 'runbase-moved', runBaseRef });
        }
        const listed = await this.git.run(['ls-tree', '-z', '--end-of-options', pinned, '--', posix], { cwd: workTree });
        const entry = parseLsTree(listed.stdout);
        if (!entry) throw new WorktreeError('E_NOT_FOUND', 'path is not in the run base (new, ignored or over the size limit)', { relPath: posix });
        if (entry.type !== 'blob') throw invalid('only files and symlinks can be restored', { relPath: posix, type: entry.type });
        const backupRef = await this.writeBackup(workTree, meta.id, `restore ${posix}`);
        const blob = await this.git.run(['cat-file', 'blob', entry.sha], { cwd: workTree });
        const written = await writeRestoredEntry(workTree, posix, entry, blob.raw);
        return { path: written, relPath: posix, runBaseRef, backupRef };
      });
    });
  }

  /**
   * Deletes expired run-base (7 days) and backup (30 days) refs by commit age,
   * each only while it still points at the commit that was inspected. Archive
   * refs are never swept. Objects are left for the user's own gc.
   */
  sweepSnapshotRefs(repoPath: string, now: Date = this.now()): Promise<string[]> {
    return this.boundary(async () => {
      const repo = await resolveRepo(repoPath);
      return this.withLock(repo.commonDir, path.join(repo.commonDir, 'axis-create.lock'), async () => {
        const cwd = repo.workTree ?? repo.commonDir;
        const out = await this.git.text(
          ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(committerdate:unix)', 'refs/axis/runbase', 'refs/axis/backup'],
          { cwd },
        );
        const deleted: string[] = [];
        for (const line of out.split('\n').filter(Boolean)) {
          const [ref = '', sha = '', secs = ''] = line.split('\t');
          const days = ref.startsWith('refs/axis/runbase/') ? RUNBASE_RETENTION_DAYS : BACKUP_RETENTION_DAYS;
          if (now.getTime() - Number(secs) * 1000 > days * DAY_MS) {
            await deleteRefIf(this.git, cwd, ref, sha);
            deleted.push(ref);
          }
        }
        return deleted;
      });
    });
  }

  /** The path is inside `expected` (lexically) and none of its parent components below it is a symlink. */
  private async assertUnder(expected: string, p: string): Promise<void> {
    assertNoTraversal(expected, 'expected worktree');
    const root = path.resolve(expected);
    const rel = path.relative(root, path.resolve(p));
    if (rel === '' || isOutsideRel(rel)) throw new WorktreeError('E_POLICY_DENIED', 'path is outside the worktree');
    let cur = root;
    for (const part of rel.split(path.sep).slice(0, -1)) {
      cur = path.join(cur, part);
      const st = await fs.lstat(cur).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
      if (st === null) return; // the rest does not exist yet: nothing to follow
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new WorktreeError('E_POLICY_DENIED', 'a parent folder of the path is a symlink', { reason: 'symlink-component' });
      }
    }
  }

  // ---- implementations -------------------------------------------------------

  private async listImpl(repoPath: string): Promise<WorktreeInfo[]> {
    const repo = await resolveRepo(repoPath);
    const entries = await this.listRaw(repo);
    const root = await canonicalise(this.options.worktreeRoot);
    const out: WorktreeInfo[] = [];
    for (const [i, e] of entries.entries()) {
      let p = e.path;
      let meta: WorkspaceMeta | null = null;
      try {
        p = await fs.realpath(e.path);
        if (i > 0 && isSameOrInside(p, root, this.platform)) meta = await readMeta((await resolveRepo(p)).gitDir);
      } catch {
        // missing or unreadable worktree: reported as-is (prunable)
      }
      out.push({
        ...e, path: p, isMain: i === 0, managed: meta !== null, external: i > 0 && meta === null,
        id: meta?.id ?? null,
      });
    }
    return out;
  }

  private async createImpl(input: CreateInput): Promise<CreatedWorkspace> {
    const slug = SlugSchema.safeParse(input.slug);
    if (!slug.success) throw invalid(slug.error.issues[0]?.message ?? 'invalid slug', { slug: input.slug });
    const id = input.id === undefined ? `ws-${randomBytes(8).toString('hex')}` : input.id;
    if (!IdSchema.safeParse(id).success) throw invalid('invalid workspace id');
    const baseRef = input.baseRef ?? 'HEAD';
    if (!/^[^\s\0-\x1f\x7f-]\S{0,254}$/.test(baseRef) || baseRef.includes('..')) {
      throw invalid('invalid base ref', { baseRef });
    }
    assertNoTraversal(input.repoPath, 'repository path');
    const repo = await resolveRepo(input.repoPath);
    const host: CreateHost = {
      git: this.git, worktreeRoot: this.options.worktreeRoot, platform: this.platform, now: this.now, maxFile: this.maxFile,
      listRaw: (r) => this.listRaw(r),
      protectedLocations: (r, local) => this.protectedLocations(r, local),
      takeGitSnapshot: (wt, common) => this.snapshotImpl(wt, common),
      assertExecutionClean: async (wt) => {
        const r = await resolveRepo(wt);
        await this.guardExecutionDrift(r, wt);
      },
      assertGitTrusted: (extra) => this.assertGitTrusted(extra),
    };
    return this.withLock(repo.commonDir, path.join(repo.commonDir, 'axis-create.lock'), () =>
      createWorkspace(host, repo, { slug: slug.data, id, baseRef }));
  }

  private async statusImpl(worktreePath: string, opts: { baseline?: GitSnapshot }): Promise<WorkspaceStatus> {
    const { repo, workTree, meta } = await this.locate(worktreePath, true);
    const cwd = workTree;
    const dirty = await readDirty(this.git, cwd);
    const head = await this.git.text(['rev-parse', '--verify', '--end-of-options', 'HEAD'], { cwd });
    const branchRes = await this.git.run(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd, allowFailure: true });
    const counts = await this.git.text(['rev-list', '--left-right', '--count', '--end-of-options', `${meta.baseSha}...HEAD`], { cwd });
    const [behind = 0, ahead = 0] = counts.split(/\s+/).map(Number);
    let baseBranchBehind: number | null = null;
    if (meta.baseBranch && await this.git.ok(['rev-parse', '--verify', '--quiet', '--end-of-options', meta.baseBranch], { cwd })) {
      baseBranchBehind = Number(await this.git.text(['rev-list', '--count', '--end-of-options', `HEAD..${meta.baseBranch}`], { cwd }));
    }
    const baseline = opts.baseline ?? (await readBaseline(repo.gitDir));
    const drift = baseline ? diffGitSnapshots(baseline, await this.snapshotImpl(cwd, repo.commonDir)) : [];
    return {
      id: meta.id, branch: branchRes.code === 0 ? branchRes.stdout.trim() : null, head,
      baseSha: meta.baseSha, state: meta.state, dirty, ahead, behind, baseBranchBehind,
      drift, baselineMissing: baseline === null, hasDrift: baseline === null || drift.length > 0,
    };
  }

  /** GIT-SNAP-1: hashes and text of the common-dir guard set for this worktree. */
  private async snapshotImpl(worktreePath: string, commonDir?: string): Promise<GitSnapshot> {
    const repo = await resolveRepo(worktreePath);
    const dir = commonDir ?? repo.commonDir;
    const workTree = repo.workTree ?? worktreePath;
    const listing = await this.git.run(
      ['config', '--show-origin', '--show-scope', '--null', '--list'],
      { cwd: worktreePath },
    );
    const all = parseConfigAll(listing.stdout);
    const files = await snapshotGuardFiles(dir);
    const primary = new Set([path.join(dir, 'config'), path.join(dir, 'config.worktree'),
      ...Object.keys(files).filter((k) => k.endsWith('config.worktree')).map((k) => path.join(dir, k))]);
    const hooksEntry = all.filter((e) => e.key.toLowerCase() === 'core.hookspath').at(-1);
    await snapshotExtraFiles(files, {
      workTree, gitDir: repo.gitDir, commonDir: dir,
      includeFiles: includedConfigFiles(all, worktreePath, primary, os.homedir()),
      hooksPath: hooksEntry ? hooksEntry.value : null,
    });
    return buildGitSnapshot(files, watchedEntries(all), this.now());
  }

  // ---- internals -----------------------------------------------------------

  /** Maps every failure into the closed error set, and pins git once. */
  private async boundary<T>(fn: () => Promise<T>): Promise<T> {
    try {
      await this.assertGitTrusted([]);
      return await fn();
    } catch (e) {
      throw toWorktreeError(e);
    }
  }

  /** The pinned git binary must not sit inside the worktree root or any protected location. */
  private assertGitTrusted(extra: readonly ProtectedLocation[]): Promise<void> {
    const gitPath = this.runner.gitPath;
    if (gitPath === undefined) return Promise.resolve();
    this.gitChecked ??= (async () => {
      const real = await fs.realpath(gitPath);
      const root = await canonicalise(this.options.worktreeRoot);
      if (isSameOrInside(real, root, this.platform)) {
        throw new WorktreeError('E_POLICY_DENIED', 'the git executable lives inside the worktree root', { reason: 'git-path' });
      }
    })().catch((e: unknown) => {
      this.gitChecked = null; // a transient failure must not poison every later call
      throw e;
    });
    return this.gitChecked.then(async () => {
      const real = await fs.realpath(gitPath);
      for (const loc of extra) {
        if (isSameOrInside(real, loc.path, this.platform)) {
          throw new WorktreeError('E_POLICY_DENIED', `the git executable lives inside ${loc.label}`, { reason: 'git-path' });
        }
      }
    });
  }

  private backupRefName(id: string): string {
    const ts = this.now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    return `refs/axis/backup/${id}/${ts}-${randomBytes(16).toString('hex')}`;
  }

  private async writeBackup(workTree: string, id: string, why: string): Promise<string> {
    const ref = this.backupRefName(id);
    const scratch = await privateDir(path.join(await canonicalise(this.options.worktreeRoot), '.axis-tmp'));
    await writeSnapshotRef(this.git, workTree, ref, `axis backup before ${why}`, this.maxFile, scratch);
    return ref;
  }

  /** Refuses daemon writes while unacknowledged drift could make git run commands. */
  private async guardExecutionDrift(repo: RepoLocation, workTree: string): Promise<void> {
    const baseline = await readBaseline(repo.gitDir);
    if (!baseline) {
      throw new WorktreeError('E_POLICY_DENIED', 'git configuration baseline is missing; review it first', { reason: 'git-drift', baselineMissing: true });
    }
    const bad = diffGitSnapshots(baseline, await this.snapshotImpl(workTree, repo.commonDir)).filter(isExecutionDrift);
    if (bad.length > 0) {
      throw new WorktreeError('E_POLICY_DENIED', 'git configuration that can run commands changed; review and acknowledge it first', {
        reason: 'git-drift', items: bad.map((d) => d.id),
      });
    }
  }

  private async listRaw(repo: RepoLocation) {
    const out = await this.git.run(['worktree', 'list', '--porcelain', '-z'], { cwd: repo.workTree ?? repo.commonDir });
    return parseWorktreeList(out.stdout);
  }

  private async protectedLocations(repo: RepoLocation, localCheckout: string | null): Promise<ProtectedLocation[]> {
    const locs: ProtectedLocation[] = [{ label: 'the repository git directory', path: repo.commonDir }];
    if (localCheckout) locs.push({ label: 'the local checkout', path: localCheckout });
    for (const r of await (this.options.registeredRepos?.() ?? [])) {
      try {
        const reg = await resolveRepo(r);
        locs.push({ label: 'a registered repository', path: reg.commonDir });
        if (reg.workTree) locs.push({ label: 'a registered repository', path: reg.workTree });
        if (path.basename(reg.commonDir) === '.git') {
          locs.push({ label: 'a registered repository', path: path.dirname(reg.commonDir) });
        }
      } catch {
        // an unreachable registered repo cannot contain the root
      }
    }
    return locs;
  }

  /** Resolves and validates an Axis-managed worktree; never the local checkout. */
  private async locate(p: string, mustBeRoot: boolean): Promise<Located> {
    assertNoTraversal(p, 'path');
    const repo = await resolveRepo(p);
    if (!repo.linked || repo.workTree === null) {
      throw new WorktreeError('E_POLICY_DENIED', 'not a linked worktree; Axis never operates on the local checkout');
    }
    const root = await canonicalise(this.options.worktreeRoot);
    if (!isSameOrInside(repo.workTree, root, this.platform)) {
      throw new WorktreeError('E_POLICY_DENIED', 'worktree is outside the Axis worktree root');
    }
    const meta = await readMeta(repo.gitDir);
    if (!meta) throw new WorktreeError('E_NOT_FOUND', 'not an Axis workspace');
    if (mustBeRoot && (await canonicalise(p)) !== repo.workTree) {
      throw invalid('path must be the worktree root');
    }
    return { repo, workTree: repo.workTree, meta };
  }

  /**
   * Runs `fn` on a workspace under the project mutex and the workspace
   * lockfile, after re-reading and re-validating its record inside the lock.
   */
  private async withWorkspace<T>(
    p: string, mustBeRoot: boolean, op: ActiveRunOp | null, fn: (l: Located) => Promise<T>,
  ): Promise<T> {
    assertNoTraversal(p, 'path');
    const first = await resolveRepo(p);
    if (!first.linked) {
      throw new WorktreeError('E_POLICY_DENIED', 'not a linked worktree; Axis never operates on the local checkout');
    }
    return this.withLock(first.commonDir, path.join(first.gitDir, 'axis.lock'), async () => {
      const located = await this.locate(p, mustBeRoot);
      if (op && this.options.refuseIfActiveRun && (await this.options.refuseIfActiveRun(located.meta.id, op))) {
        throw new WorktreeError('E_CONFLICT', 'a run is active in this workspace', { reason: 'active-run' });
      }
      return fn(located);
    });
  }

  /**
   * The in-process mutex serialises every operation of one repository. Across processes there are two
   * lockfiles: workspace operations (finalise, remove, restore, drift acknowledgement) lock
   * `<worktree admin dir>/axis.lock`, while create and sweep lock `<common dir>/axis-create.lock`. So two
   * workspace operations on the same workspace, or two creates, exclude each other across processes;
   * a create and a workspace operation do not (they touch different refs and directories).
   */
  private withLock<T>(key: string, lockFile: string, fn: () => Promise<T>): Promise<T> {
    return this.locked(key, async () => {
      const release = await acquireFileLock(lockFile, { timeoutMs: this.options.lockTimeoutMs ?? 15_000 });
      try {
        return await fn();
      } finally {
        await release();
      }
    });
  }

  private locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return next;
  }
}
