// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDiscardConfirmed, type DiscardConfirmation } from './confirmation.js';
import {
  parseWorktreeList, projectDirName, resolveRepo, type RepoLocation,
} from './discovery.js';
import { WorktreeError } from './errors.js';
import {
  parsePorcelainStatus, type CreateInput, type CreatedWorkspace, type DirtyFile, type FinaliseOutcome,
  type FinaliseResult, type RemoveResult, type RestoreResult, type WorkspaceStatus, type WorktreeInfo,
} from './types.js';
import type { GitRunner } from './git.js';
import {
  buildGitSnapshot, diffGitSnapshots, includedConfigFiles, parseConfigAll, snapshotExtraFiles,
  snapshotGuardFiles, watchedEntries,
  type GitSnapshot,
} from './gitSnap.js';
import { HardenedGit } from './hardenedGit.js';
import {
  IdSchema, SlugSchema, readBaseline, readMeta, writeBaseline, writeMeta, type WorkspaceMeta,
} from './meta.js';
import {
  assertNoTraversal, canonicalise, isSameOrInside, validateWorktreeRoot, type ProtectedLocation,
} from './paths.js';
import { parseLsTree, writeRestoredEntry } from './restore.js';
import { MAX_SNAPSHOT_FILE_BYTES, writeSnapshotRef } from './snapshotRef.js';

export const RUNBASE_RETENTION_DAYS = 7;
export const BACKUP_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface WorktreeManagerOptions {
  readonly runner: GitRunner;
  /** Worktree root. Defaults are the caller's job (see `defaultWorktreeRoot`). */
  readonly worktreeRoot: string;
  /** Other registered repositories the root must never sit inside. */
  readonly registeredRepos?: () => Promise<readonly string[]> | readonly string[];
  readonly now?: () => Date;
  readonly platform?: NodeJS.Platform;
  readonly maxSnapshotFileBytes?: number;
  /** An empty directory used as core.hooksPath. Created (and owned) when omitted. */
  readonly emptyHooksDir?: string;
}

interface Located {
  readonly repo: RepoLocation;
  readonly workTree: string;
  readonly meta: WorkspaceMeta;
}

function invalid(message: string, details: Record<string, unknown> = {}): WorktreeError {
  return new WorktreeError('E_INVALID_ARGUMENT', message, details);
}

export class WorktreeManager {
  private readonly git: HardenedGit;
  private readonly runner: GitRunner;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => Date;
  private readonly maxFile: number;
  private readonly ownedHooksDir: string | null;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly options: WorktreeManagerOptions) {
    this.runner = options.runner;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? (() => new Date());
    this.maxFile = options.maxSnapshotFileBytes ?? MAX_SNAPSHOT_FILE_BYTES;
    this.ownedHooksDir = options.emptyHooksDir ? null : mkdtempSync(path.join(os.tmpdir(), 'axis-nohooks-'));
    this.git = new HardenedGit(this.runner, options.emptyHooksDir ?? (this.ownedHooksDir as string));
  }

  /** Removes the private empty hooks directory, if this instance created it. */
  dispose(): void {
    if (this.ownedHooksDir) rmSync(this.ownedHooksDir, { recursive: true, force: true });
  }

  // ---- discovery -----------------------------------------------------------

  async list(repoPath: string): Promise<WorktreeInfo[]> {
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

  // ---- create --------------------------------------------------------------

  async create(input: CreateInput): Promise<CreatedWorkspace> {
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

    return this.locked(repo.commonDir, async () => {
      const cwd = repo.workTree ?? repo.commonDir;
      const entries = await this.listRaw(repo);
      const main = entries[0];
      const localCheckout = main && !main.bare ? await canonicalise(main.path) : null;

      const protectedLocs = await this.protectedLocations(repo, localCheckout);
      const root = await validateWorktreeRoot(this.options.worktreeRoot, protectedLocs, this.platform);
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      if ((await fs.realpath(root)) !== root) throw new WorktreeError('E_POLICY_DENIED', 'worktree root changed during the operation');

      const projDir = path.join(root, projectDirName(repo.commonDir, localCheckout, this.platform));
      await fs.mkdir(projDir, { recursive: true, mode: 0o700 });
      if ((await fs.realpath(projDir)) !== projDir) {
        throw new WorktreeError('E_POLICY_DENIED', 'project directory is a symlink or escapes the worktree root', { projDir });
      }
      const wtPath = path.join(projDir, slug.data);
      for (const loc of protectedLocs) {
        if (isSameOrInside(wtPath, loc.path, this.platform)) {
          throw new WorktreeError('E_POLICY_DENIED', `worktree path is inside ${loc.label}`, { path: wtPath });
        }
      }
      if (await fs.lstat(wtPath).then(() => true, () => false)) {
        throw new WorktreeError('E_CONFLICT', 'worktree path already exists', { path: wtPath });
      }

      const branch = `axis/${slug.data}`;
      if (!(await this.git.ok(['check-ref-format', '--branch', branch], { cwd }))) {
        throw invalid('slug does not form a valid branch name', { branch });
      }
      if (await this.git.ok(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd })) {
        throw new WorktreeError('E_CONFLICT', 'branch already exists', { branch });
      }
      const resolved = await this.git.run(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], { cwd, allowFailure: true });
      const baseSha = resolved.stdout.trim();
      if (resolved.code !== 0 || !baseSha) throw new WorktreeError('E_NOT_FOUND', 'base ref does not resolve to a commit', { baseRef });
      const baseBranch = await this.resolveBaseBranch(cwd, baseRef);

      await this.git.run(['worktree', 'add', '-b', branch, '--', wtPath, baseSha], { cwd });
      const runBaseRef = `refs/axis/runbase/${id}`;
      try {
        await this.git.run(['worktree', 'lock', '--reason', `axis:${id}`, '--', wtPath], { cwd });
        const wt = await resolveRepo(wtPath);
        await writeMeta(wt.gitDir, {
          version: 1, id, slug: slug.data, branch, baseRef, baseSha, baseBranch,
          createdAt: this.now().toISOString(), state: 'READY', outcome: null,
        });
        const snap = await writeSnapshotRef(this.git, wtPath, runBaseRef, `axis run base ${id}`, this.maxFile);
        await writeBaseline(wt.gitDir, await this.takeGitSnapshot(wtPath, repo.commonDir));
        return {
          id, slug: slug.data, branch, path: wtPath, baseRef, baseSha, runBaseRef,
          skippedLarge: snap.skippedLarge, localCheckout,
        };
      } catch (e) {
        await this.git.run(['worktree', 'unlock', '--', wtPath], { cwd, allowFailure: true });
        await this.git.run(['worktree', 'remove', '--force', '--', wtPath], { cwd, allowFailure: true });
        await this.git.run(['worktree', 'prune'], { cwd, allowFailure: true });
        await this.git.run(['branch', '-D', '--', branch], { cwd, allowFailure: true });
        await this.git.run(['update-ref', '-d', runBaseRef], { cwd, allowFailure: true });
        throw e;
      }
    });
  }

  // ---- status and drift ----------------------------------------------------

  async status(worktreePath: string, opts: { baseline?: GitSnapshot } = {}): Promise<WorkspaceStatus> {
    const { repo, workTree, meta } = await this.locate(worktreePath, true);
    const cwd = workTree;
    const dirty = await this.dirtyFiles(cwd);
    const head = await this.git.text(['rev-parse', 'HEAD'], { cwd });
    const branchRes = await this.git.run(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd, allowFailure: true });
    const counts = await this.git.text(['rev-list', '--left-right', '--count', `${meta.baseSha}...HEAD`], { cwd });
    const [behind = 0, ahead = 0] = counts.split(/\s+/).map(Number);
    let baseBranchBehind: number | null = null;
    if (meta.baseBranch && await this.git.ok(['rev-parse', '--verify', '--quiet', meta.baseBranch], { cwd })) {
      baseBranchBehind = Number(await this.git.text(['rev-list', '--count', `HEAD..${meta.baseBranch}`], { cwd }));
    }
    const baseline = opts.baseline ?? (await readBaseline(repo.gitDir));
    const drift = baseline ? diffGitSnapshots(baseline, await this.takeGitSnapshot(cwd, repo.commonDir)) : [];
    return {
      id: meta.id, branch: branchRes.code === 0 ? branchRes.stdout.trim() : null, head,
      baseSha: meta.baseSha, state: meta.state, dirty, ahead, behind, baseBranchBehind,
      drift, baselineMissing: baseline === null, hasDrift: baseline === null || drift.length > 0,
    };
  }

  /** GIT-SNAP-1: hashes and text of the common-dir guard set for this worktree. */
  async takeGitSnapshot(worktreePath: string, commonDir?: string): Promise<GitSnapshot> {
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

  /**
   * Call before push (and any other Axis action that must not run on changed
   * git configuration). Re-takes GIT-SNAP-1 and refuses unless it matches the
   * baseline the user last acknowledged (`acknowledgeDrift`). Fails closed
   * when no baseline exists.
   */
  async assertNoDrift(worktreePath: string, opts: { baseline?: GitSnapshot } = {}): Promise<void> {
    const { repo, workTree } = await this.locate(worktreePath, true);
    const baseline = opts.baseline ?? (await readBaseline(repo.gitDir));
    if (!baseline) {
      throw new WorktreeError('E_CONFLICT', 'git configuration baseline is missing', { reason: 'git-drift', baselineMissing: true, items: [] });
    }
    const drift = diffGitSnapshots(baseline, await this.takeGitSnapshot(workTree, repo.commonDir));
    if (drift.length > 0) {
      throw new WorktreeError('E_CONFLICT', 'git configuration or hooks changed since last acknowledged', {
        reason: 'git-drift', baselineMissing: false, items: drift.map((d) => d.id),
      });
    }
  }

  /** The user reviewed the drift: the current state becomes the new baseline. */
  async acknowledgeDrift(worktreePath: string): Promise<GitSnapshot> {
    const { repo, workTree } = await this.locate(worktreePath, true);
    return this.locked(repo.commonDir, async () => {
      const snap = await this.takeGitSnapshot(workTree, repo.commonDir);
      await writeBaseline(repo.gitDir, snap);
      return snap;
    });
  }

  // ---- finalise and remove -------------------------------------------------

  async finalise(input: {
    path: string; outcome: FinaliseOutcome; discardConfirmation?: DiscardConfirmation;
  }): Promise<FinaliseResult> {
    if (!['merged', 'archived', 'abandoned'].includes(input.outcome)) throw invalid('invalid outcome');
    const { repo, workTree, meta } = await this.locate(input.path, true);
    return this.locked(repo.commonDir, async () => {
      if (meta.state === 'FINALISED') throw new WorktreeError('E_CONFLICT', 'workspace is already finalised', { id: meta.id });
      const backupRef = await this.backupIfDirty(workTree, meta, input.discardConfirmation, 'finalise');
      const head = await this.git.text(['rev-parse', 'HEAD'], { cwd: workTree });
      if (input.outcome === 'merged') {
        const target = meta.baseBranch;
        if (!target || !(await this.git.ok(['rev-parse', '--verify', '--quiet', target], { cwd: workTree }))) {
          throw new WorktreeError('E_CONFLICT', 'base branch is unavailable, cannot verify the merge', { reason: 'no-base-branch' });
        }
        if (!(await this.git.ok(['merge-base', '--is-ancestor', head, target], { cwd: workTree }))) {
          throw new WorktreeError('E_CONFLICT', 'workspace tip is not reachable from the base branch', { reason: 'not-merged', baseBranch: target });
        }
      }
      const archiveRef = `refs/axis/archive/${meta.id}`;
      await this.git.run(['update-ref', archiveRef, head], { cwd: workTree });
      await writeMeta(repo.gitDir, { ...meta, state: 'FINALISED', outcome: input.outcome });
      return { archiveRef, archiveSha: head, backupRef, outcome: input.outcome };
    });
  }

  async remove(input: {
    path: string; deleteBranch?: boolean; discardConfirmation?: DiscardConfirmation;
  }): Promise<RemoveResult> {
    const { repo, workTree, meta } = await this.locate(input.path, true);
    return this.locked(repo.commonDir, async () => {
      if (meta.state !== 'FINALISED') {
        throw new WorktreeError('E_CONFLICT', 'workspace must be finalised before removal', { reason: 'not-finalised' });
      }
      const archiveRef = `refs/axis/archive/${meta.id}`;
      if (!(await this.git.ok(['rev-parse', '--verify', '--quiet', archiveRef], { cwd: workTree }))) {
        throw new WorktreeError('E_CONFLICT', 'archive ref is missing', { reason: 'no-archive' });
      }
      const backupRef = await this.backupIfDirty(workTree, meta, input.discardConfirmation, 'remove');
      // Run from the main checkout's path: git only reads it here and the worktree is about to vanish.
      const entries = await this.listRaw(repo);
      const main = entries[0];
      const cwd = main && !main.bare ? main.path : repo.commonDir;
      await this.git.run(['worktree', 'unlock', '--', workTree], { cwd, allowFailure: true });
      await this.git.run(['worktree', 'remove', ...(backupRef ? ['--force'] : []), '--', workTree], { cwd });
      await this.git.run(['worktree', 'prune'], { cwd });
      let branchDeleted = false;
      if (input.deleteBranch) {
        await this.git.run(['branch', '-D', '--', meta.branch], { cwd });
        branchDeleted = true;
      }
      return { removed: true, archiveRef, backupRef, branchDeleted };
    });
  }

  // ---- restore from run base -----------------------------------------------

  /**
   * Restores one file to its content at the run base, after writing a backup
   * snapshot of the worktree. `runId` selects `refs/axis/runbase/<runId>`
   * (CLI runs); by default the workspace's creation snapshot is used.
   */
  async restoreFromRunBase(input: { path: string; runId?: string }): Promise<RestoreResult> {
    assertNoTraversal(input.path, 'path');
    if (input.runId !== undefined && !IdSchema.safeParse(input.runId).success) throw invalid('invalid run id');
    const parent = await canonicalise(path.dirname(input.path));
    const target = path.join(parent, path.basename(input.path));
    let existing = parent;
    while (!(await fs.stat(existing).then(() => true, () => false))) existing = path.dirname(existing);
    const { repo, workTree, meta } = await this.locate(existing, false);
    const relPath = path.relative(workTree, target);
    if (relPath === '' || relPath.startsWith('..') || path.isAbsolute(relPath) || !isSameOrInside(target, workTree, this.platform)) {
      throw new WorktreeError('E_POLICY_DENIED', 'path is outside the worktree', { path: input.path });
    }
    const posix = relPath.split(path.sep).join('/');
    if (posix === '.git' || posix.startsWith('.git/')) throw new WorktreeError('E_POLICY_DENIED', 'refusing to touch .git');

    return this.locked(repo.commonDir, async () => {
      const runBaseRef = `refs/axis/runbase/${input.runId ?? meta.id}`;
      if (!(await this.git.ok(['rev-parse', '--verify', '--quiet', `${runBaseRef}^{commit}`], { cwd: workTree }))) {
        throw new WorktreeError('E_NOT_FOUND', 'run base snapshot does not exist', { runBaseRef });
      }
      const listed = await this.git.run(['ls-tree', '-z', runBaseRef, '--', posix], { cwd: workTree });
      const entry = parseLsTree(listed.stdout);
      if (!entry) {
        throw new WorktreeError('E_NOT_FOUND', 'path is not in the run base (new, ignored or over the size limit)', { relPath: posix });
      }
      if (entry.type !== 'blob') throw invalid('only files and symlinks can be restored', { relPath: posix, type: entry.type });
      const backupRef = this.backupRefName(meta.id);
      await writeSnapshotRef(this.git, workTree, backupRef, `axis backup before restore ${posix}`, this.maxFile);
      const blob = await this.git.run(['cat-file', 'blob', entry.sha], { cwd: workTree });
      await writeRestoredEntry(workTree, target, entry, blob.raw);
      return { path: target, relPath: posix, runBaseRef, backupRef };
    });
  }

  /**
   * Deletes expired run-base (7 days) and backup (30 days) refs by commit age.
   * Archive refs are never swept. Objects are left for the user's own gc.
   */
  async sweepSnapshotRefs(repoPath: string, now: Date = this.now()): Promise<string[]> {
    const repo = await resolveRepo(repoPath);
    return this.locked(repo.commonDir, async () => {
      const cwd = repo.workTree ?? repo.commonDir;
      const out = await this.git.text(
        ['for-each-ref', '--format=%(refname)%09%(committerdate:unix)', 'refs/axis/runbase', 'refs/axis/backup'],
        { cwd },
      );
      const deleted: string[] = [];
      for (const line of out.split('\n').filter(Boolean)) {
        const [ref = '', secs = ''] = line.split('\t');
        const days = ref.startsWith('refs/axis/runbase/') ? RUNBASE_RETENTION_DAYS : BACKUP_RETENTION_DAYS;
        if (now.getTime() - Number(secs) * 1000 > days * DAY_MS) {
          await this.git.run(['update-ref', '-d', ref], { cwd });
          deleted.push(ref);
        }
      }
      return deleted;
    });
  }

  // ---- internals -----------------------------------------------------------

  private backupRefName(id: string): string {
    const ts = this.now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    return `refs/axis/backup/${id}/${ts}-${randomBytes(2).toString('hex')}`;
  }

  /** Dirty worktrees need a minted confirmation; a backup ref is written first. */
  private async backupIfDirty(
    workTree: string, meta: WorkspaceMeta, confirmation: unknown, op: string,
  ): Promise<string | null> {
    const dirty = await this.dirtyFiles(workTree);
    if (dirty.length === 0) return null;
    if (!isDiscardConfirmed(confirmation)) {
      throw new WorktreeError('E_CONFLICT', `workspace has uncommitted changes; ${op} needs a verified confirmation`, {
        reason: 'dirty', files: dirty.slice(0, 50).map((d) => d.path), count: dirty.length,
      });
    }
    const ref = this.backupRefName(meta.id);
    await writeSnapshotRef(this.git, workTree, ref, `axis backup before ${op}`, this.maxFile);
    return ref;
  }

  private async dirtyFiles(cwd: string): Promise<DirtyFile[]> {
    const out = await this.git.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd, noOptionalLocks: true });
    return parsePorcelainStatus(out.stdout);
  }

  private async resolveBaseBranch(cwd: string, baseRef: string): Promise<string | null> {
    if (baseRef === 'HEAD') {
      const sym = await this.git.run(['symbolic-ref', '-q', 'HEAD'], { cwd, allowFailure: true });
      return sym.code === 0 ? sym.stdout.trim() : null;
    }
    const full = baseRef.startsWith('refs/heads/') ? baseRef : `refs/heads/${baseRef}`;
    return (await this.git.ok(['show-ref', '--verify', '--quiet', full], { cwd })) ? full : null;
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
      throw new WorktreeError('E_POLICY_DENIED', 'not a linked worktree; Axis never operates on the local checkout', { path: p });
    }
    const root = await canonicalise(this.options.worktreeRoot);
    if (!isSameOrInside(repo.workTree, root, this.platform)) {
      throw new WorktreeError('E_POLICY_DENIED', 'worktree is outside the Axis worktree root', { path: p });
    }
    const meta = await readMeta(repo.gitDir);
    if (!meta) throw new WorktreeError('E_NOT_FOUND', 'not an Axis workspace', { path: p });
    if (mustBeRoot && (await canonicalise(p)) !== repo.workTree) {
      throw invalid('path must be the worktree root', { path: p });
    }
    return { repo, workTree: repo.workTree, meta };
  }

  /** One mutating Axis git operation at a time per project (design 5.3 invariant 7). */
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
