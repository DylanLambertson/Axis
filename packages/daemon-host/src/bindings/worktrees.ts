// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { AuditLog } from "@axis/audit";
import { DaemonError, type ApprovalContentHook } from "@axis/daemon";
import type { Journal } from "@axis/journal";
import {
  WorktreeManager,
  createExecGitRunner,
  isWorktreeError,
  resolveRepo,
  type DiscardConfirmation,
  type GitRunner,
} from "@axis/worktrees";
import type { RandomSource } from "../ports/random.js";
import type { RunsService } from "../ports/runs.js";
import type { WorktreeLocator } from "../ports/worktree-locator.js";
import type { WorktreesService } from "../ports/worktrees.js";
import { fromWorktreeError, worktreeFailure } from "../worktrees/errors.js";
import { createWorktreeContentHooks } from "../worktrees/hooks.js";
import { assertSafeRestorePath } from "../worktrees/restore-paths.js";
import { createWorktreeLocator } from "../worktrees/locator.js";
import { ProjectMutex } from "../worktrees/project-mutex.js";
import { createWorktreesService, type ServiceJournal } from "../worktrees/service.js";
import type { ManagerShape } from "../worktrees/shapes.js";

export interface WorktreesBindingDeps {
  readonly journal: ServiceJournal & Pick<Journal, "getWorkspace" | "listRuns">;
  readonly audit: Pick<AuditLog, "append">;
  /** Runs `fn` in one database transaction (nested calls join it): `(fn) => withTransaction(db, fn)` from `@axis/audit`. */
  readonly transact: <T>(fn: () => T) => T;
  readonly random: RandomSource;
  readonly runs: Pick<RunsService, "hasActiveRun">;
  /** The ONE absolute git path of `HostServices.gitPath` (design step 5a, FU-GIT-RESOLVE): never looked up again. */
  readonly gitPath: string;
  /** A copy of the environment the git runner builds GIT-ENV-1 from. The host never reads `process.env` itself. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  /** The managed worktree root of `HostConfig`. */
  readonly worktreeRoot: string;
  /** How long a mutating call waits for another process's workspace lock (default: the package's own). */
  readonly lockTimeoutMs?: number;
  /** Told what a discard would lose, for the native dialog (`createWorktreesApprovals().onPreview`). */
  readonly onPreview?: (target: string, contentDigest: string, text: string) => void;
}

/**
 * Test seams: replace the on-disk restore path check, wrap the manager shape, force the case rule. They are NOT accepted by
 * `createWorktreesBinding` and not exported from the package index; only `createWorktreesBindingForTest` takes them, so no
 * production caller can switch a check off or reach the raw manager.
 */
export interface WorktreesTestSeams {
  readonly restorePathCheck?: (workTree: string, rel: string, platform: NodeJS.Platform) => Promise<void>;
  readonly wrapManager?: (manager: ManagerShape) => ManagerShape;
  readonly caseInsensitiveFs?: boolean;
  readonly maxReports?: number;
}

export interface WorktreesBinding {
  readonly service: WorktreesService;
  readonly locator: WorktreeLocator;
  /** For `daemon.register("axis.worktrees", 1, handlers, { content })`. */
  readonly content: { readonly finalise: ApprovalContentHook; readonly remove: ApprovalContentHook };
  /** For `createWorktreesHandlers`. */
  readonly needsAttention: (workspaceId: string, method?: string) => boolean;
  /** The one project mutex (also taken by the git handlers of ticket H9). */
  readonly mutex: ProjectMutex;
  /** The GIT-SNAP-1 re-take for a registered worktree (refuses by throwing, a closed `DaemonError`): `GitOpsDeps.assertNoDrift` of ticket H9. */
  readonly assertNoDrift: (worktree: { readonly workTree: string }) => Promise<void>;
}

/** Runs one manager call and turns what the package throws into the closed `DaemonError` set (no message is forwarded). */
async function mapped<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof DaemonError) throw e;
    if (isWorktreeError(e)) throw fromWorktreeError(e.code, e.details["reason"]);
    throw worktreeFailure("E_INTERNAL");
  }
}

const BASE_BRANCH = /^refs\/heads\/[!-~]+$/;
const REF_NAME = /^[^\s\0-\x1f\x7f-]\S{0,254}$/;

function adapt(manager: WorktreeManager, runner: GitRunner): ManagerShape {
  const git = (cwd: string, args: readonly string[]): Promise<{ code: number; stdout: string }> => runner.run(args, { cwd, timeoutMs: 30_000 });
  const cap = (c: unknown): DiscardConfirmation | undefined => c as DiscardConfirmation | undefined;
  return {
    resolveCommit: (repoPath, ref) =>
      mapped(async () => {
        if (!REF_NAME.test(ref) || ref.includes("..")) throw worktreeFailure("E_INVALID_ARGUMENT");
        const out = await git(repoPath, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
        const sha = out.stdout.trim();
        if (out.code !== 0 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) throw worktreeFailure("E_NOT_FOUND", "base_ref");
        return sha;
      }),
    isMerged: (repoPath, headSha, baseBranch) =>
      mapped(async () => {
        // Only a full local branch name: `HEAD` and short names depend on state a finished run can write.
        if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(headSha) || !BASE_BRANCH.test(baseBranch) || baseBranch.includes("..")) return false;
        return (await git(repoPath, ["merge-base", "--is-ancestor", "--end-of-options", headSha, baseBranch])).code === 0;
      }),
    listRefs: (repoPath, prefix) =>
      mapped(async () => {
        const out = await git(repoPath, ["for-each-ref", "--format=%(refname)", "--", prefix]);
        if (out.code !== 0) throw worktreeFailure("E_INTERNAL");
        return new Set(out.stdout.split("\n").filter((l) => l !== ""));
      }),
    list: (repoPath) => mapped(() => manager.list(repoPath)),
    create: ({ repoPath, slug, baseRef, id }) =>
      mapped(async () => {
        const made = await manager.create({ repoPath, slug, baseRef, id });
        return { id: made.id, branch: made.branch, path: made.path, baseSha: made.baseSha, baseBranch: made.baseBranch };
      }),
    status: (p) => mapped(() => manager.status(p)),
    previewDiscard: (p) => mapped(() => manager.previewDiscard(p)),
    assertNoDrift: (p) => mapped(() => manager.assertNoDrift(p)),
    finalise: ({ path, outcome, discardConfirmation, trustedBaseBranch }) =>
      mapped(() => manager.finalise({ path, outcome, trustedBaseBranch, ...(discardConfirmation === undefined ? {} : { discardConfirmation: cap(discardConfirmation) as DiscardConfirmation }) })),
    remove: ({ path, deleteBranch, discardConfirmation }) =>
      mapped(() => manager.remove({ path, deleteBranch, ...(discardConfirmation === undefined ? {} : { discardConfirmation: cap(discardConfirmation) as DiscardConfirmation }) })),
    restoreFromRunBase: ({ path, runId, expectedWorktree }) => mapped(() => manager.restoreFromRunBase({ path, runId, expectedWorktree })),
  };
}

/**
 * Binds the real `@axis/worktrees` (design section 7, ticket H8): the one file that imports it. It builds ONE
 * `WorktreeManager` over a git runner pinned to the host's single `gitPath`, so nothing here (or in the package) looks
 * for git again; the worktree root and the project registry's roots are what the manager protects; and
 * `refuseIfActiveRun` asks the run supervisor, so `finalise`, `remove` and restore refuse while a run is live.
 * Ids become paths only through the journal and the locator.
 */
export function createWorktreesBinding(deps: WorktreesBindingDeps): WorktreesBinding {
  return build(deps, {});
}

/** The same binding with test seams. Not exported from `src/index.ts`. */
export function createWorktreesBindingForTest(deps: WorktreesBindingDeps, seams: WorktreesTestSeams): WorktreesBinding {
  return build(deps, seams);
}

function build(deps: WorktreesBindingDeps, seams: WorktreesTestSeams): WorktreesBinding {
  const runner = createExecGitRunner({ gitPath: deps.gitPath, baseEnv: deps.env, platform: deps.platform });
  const manager = new WorktreeManager({
    runner,
    worktreeRoot: deps.worktreeRoot,
    platform: deps.platform,
    registeredRepos: () => deps.journal.listProjects().map((p) => p.path),
    refuseIfActiveRun: (workspaceId) => {
      try {
        return deps.runs.hasActiveRun(workspaceId);
      } catch {
        return true; // fail closed: a supervisor that cannot answer counts as active
      }
    },
    ...(deps.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: deps.lockTimeoutMs }),
  });
  const shape = seams.wrapManager?.(adapt(manager, runner)) ?? adapt(manager, runner);
  const mutex = new ProjectMutex();
  const locator = createWorktreeLocator({
    journal: deps.journal,
    worktreeRoot: deps.worktreeRoot,
    platform: deps.platform,
    resolveRepo: (p) => resolveRepo(p),
  });
  const runtime = createWorktreesService({
    journal: deps.journal,
    audit: deps.audit,
    transact: deps.transact,
    manager: shape,
    locator,
    mutex,
    runs: deps.runs,
    random: deps.random,
    platform: deps.platform,
    restorePathCheck: seams.restorePathCheck ?? assertSafeRestorePath,
    ...(seams.maxReports === undefined ? {} : { maxReports: seams.maxReports }),
    caseInsensitiveFs: seams.caseInsensitiveFs ?? (deps.platform === "win32" || deps.platform === "darwin"),
  });
  const content = createWorktreeContentHooks({
    journal: deps.journal,
    runs: deps.runs,
    locator,
    manager: shape,
    mutex,
    needsAttention: runtime.needsAttention,
    ...(deps.onPreview === undefined ? {} : { onPreview: deps.onPreview }),
  });
  return { service: runtime.service, locator, content, needsAttention: runtime.needsAttention, mutex, assertNoDrift: (w) => shape.assertNoDrift(w.workTree) };
}
