// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AuditActor, AuditLog } from "@axis/audit";
import type { Journal, Workspace } from "@axis/journal";
import type { RunsService } from "../ports/runs.js";
import type { RandomSource } from "../ports/random.js";
import type { WorktreeLocator } from "../ports/worktree-locator.js";
import type { DiscardPreview, WorktreesService } from "../ports/worktrees.js";
import { worktreeFailure } from "./errors.js";
import { assertNoActiveRun, liveWorkspace } from "./guards.js";
import { assertSafeRestorePath } from "./restore-paths.js";
import { externalInfo, workspaceInfo, type WorktreeInfo } from "./info.js";
import type { ProjectMutex } from "./project-mutex.js";
import { reconcileWorktrees } from "./reconcile.js";
import type { ManagerShape } from "./shapes.js";
import { workspaceSlug } from "./slug.js";

export type ServiceJournal = Pick<
  Journal,
  | "getProject" | "listProjects" | "getWorkspace" | "listWorkspaces" | "createWorkspace" | "setWorktreePath"
  | "transitionWorkspace" | "lockWorkspace" | "unlockWorkspace" | "getRun" | "listRuns"
>;

export interface WorktreesServiceDeps {
  readonly journal: ServiceJournal;
  readonly audit: Pick<AuditLog, "append">;
  /** Runs `fn` in one database transaction (nested calls join it), so a journal change and its audit event commit together. */
  readonly transact: <T>(fn: () => T) => T;
  readonly manager: ManagerShape;
  readonly locator: WorktreeLocator;
  readonly mutex: ProjectMutex;
  readonly runs: Pick<RunsService, "hasActiveRun">;
  readonly random: RandomSource;
  readonly platform: NodeJS.Platform;
}

export interface WorktreesRuntime {
  readonly service: WorktreesService;
  /** True while the last reconcile found this workspace in disagreement: its methods answer `E_UNAVAILABLE`. */
  needsAttention(workspaceId: string): boolean;
}

const MAX_LIST = 1000;
const exists = (p: string | null): Promise<boolean> => (p === null ? Promise.resolve(false) : fs.stat(p).then(() => true, () => false));

/**
 * The host's `WorktreesService` over the manager shape. The journal is the authority (Q7): a state change is written
 * to it `CREATING`/`REMOVING` BEFORE the repository changes and finished after, with its audit event in the same
 * transaction, so a crash at any point leaves a state `recover()` and `reconcile` can see. A workspace is locked in
 * the journal around every mutating call and the project mutex serialises the host's own calls. The caller is only
 * ever `ctx.caller` (the attested identity); no request names a path.
 */
export function createWorktreesService(deps: WorktreesServiceDeps): WorktreesRuntime {
  const { journal, manager, locator, mutex } = deps;
  let attention: ReadonlyMap<string, string> = new Map();
  const actorOf = (ctx: { caller: { actor: string } }): AuditActor => ctx.caller.actor as AuditActor;

  /** The lock record around one mutating call (advisory: the mutex and the manager's file lock are the real locks). */
  async function withLockRecord<T>(id: string, actor: AuditActor, fn: () => Promise<T>): Promise<T> {
    try {
      journal.lockWorkspace(id, actor);
    } catch {
      throw worktreeFailure("E_CONFLICT", "busy");
    }
    try {
      return await fn();
    } finally {
      try {
        journal.unlockWorkspace(id, actor);
      } catch {
        // the workspace may be gone (REMOVED clears its lock); recovery clears a stale record
      }
    }
  }

  async function inspect(ws: Workspace, signal: AbortSignal): Promise<WorktreeInfo> {
    try {
      const ref = await locator.locate(ws.id);
      return workspaceInfo(ws, await manager.status(ref.workTree), true);
    } catch {
      signal.throwIfAborted();
      return workspaceInfo(ws, undefined, await exists(ws.worktreePath));
    }
  }

  const service: WorktreesService = {
    async list(req, ctx) {
      const project = journal.getProject(req.projectId);
      if (project === undefined) throw worktreeFailure("E_NOT_FOUND");
      const worktrees: WorktreeInfo[] = [];
      for (const ws of journal.listWorkspaces().filter((w) => w.projectId === project.id && (w.state === "READY" || w.state === "FINALISED" || w.state === "REMOVING"))) {
        ctx.signal.throwIfAborted();
        if (worktrees.length >= MAX_LIST) break;
        worktrees.push(await inspect(ws, ctx.signal));
      }
      try {
        for (const e of await manager.list(project.path)) {
          if (!e.isMain && !e.managed && e.external && worktrees.length < MAX_LIST) worktrees.push(externalInfo(e, project.id));
        }
      } catch {
        ctx.signal.throwIfAborted(); // the repository could not be listed: the recorded workspaces are still shown
      }
      return { worktrees };
    },

    async status(req, ctx) {
      const rows = req.ids.map((id) => {
        const ws = journal.getWorkspace(id);
        if (ws === undefined || ws.state === "FAILED" || ws.state === "CREATING") throw worktreeFailure("E_NOT_FOUND");
        return ws;
      });
      const worktrees: WorktreeInfo[] = [];
      for (const ws of rows) {
        ctx.signal.throwIfAborted();
        worktrees.push(ws.state === "REMOVED" ? workspaceInfo(ws, undefined, false) : await inspect(ws, ctx.signal));
      }
      return { worktrees };
    },

    async create(req, ctx) {
      const project = journal.getProject(req.projectId);
      if (project === undefined) throw worktreeFailure("E_NOT_FOUND");
      const actor = actorOf(ctx);
      return mutex.run(
        project.id,
        async () => {
          const slug = workspaceSlug(req.name, deps.random);
          const baseRef = req.baseRef ?? "HEAD";
          const branch = `axis/${slug}`;
          const baseSha = await manager.resolveCommit(project.path, baseRef);
          ctx.signal.throwIfAborted();
          // Journal first: the row exists (CREATING) before the repository changes, so a crash leaves a visible state.
          const id = journal.createWorkspace({ projectId: project.id, branch, baseRef, baseSha, createdBy: actor }).value.id;
          try {
            const info = await withLockRecord(id, actor, async () => {
              const made = await manager.create({ repoPath: project.path, slug, baseRef, id });
              if (made.baseSha !== baseSha || made.branch !== branch || made.id !== id) throw worktreeFailure("E_CONFLICT", "base_moved");
              return deps.transact(() => {
                journal.setWorktreePath(id, made.path, actor);
                const ws = journal.transitionWorkspace(id, "READY", { actor, expectedFrom: "CREATING" });
                deps.audit.append({
                  actor, action: "worktree.create", target: `workspace:${id}`, outcome: "success",
                  payload: { workspaceId: id, projectId: project.id, branch, baseRef, baseSha },
                });
                return ws;
              });
            });
            return { id, worktree: await inspect(info, ctx.signal) };
          } catch (e) {
            try {
              journal.transitionWorkspace(id, "FAILED", { actor, reason: "CREATE_FAILED", expectedFrom: "CREATING" });
            } catch {
              // recovery marks a CREATING row FAILED on the next start
            }
            throw e;
          }
        },
        ctx.signal,
      );
    },

    async finalise(req, ctx) {
      const first = liveWorkspace(journal, req.id);
      const actor = actorOf(ctx);
      return mutex.run(
        first.projectId,
        async () => {
          const ws = liveWorkspace(journal, req.id);
          if (ws.state === "FINALISED") throw worktreeFailure("E_CONFLICT", "already_finalised");
          if (ws.state !== "READY") throw worktreeFailure("E_CONFLICT", "not_ready");
          assertNoActiveRun(journal, deps.runs, ws.id);
          const ref = await locator.locate(ws.id);
          return withLockRecord(ws.id, actor, async () => {
            // The manager's own record is read first: a record that already says FINALISED while the journal says READY is
            // what a crash (or a failed journal write) between the two steps leaves. It is completed here, without git.
            const live = await manager.status(ref.workTree);
            if (live.id !== ws.id) throw worktreeFailure("E_CONFLICT", "path_changed");
            const archiveRef = `refs/axis/archive/${ws.id}`;
            let backupRef: string | null = null;
            let skippedLarge = 0;
            if (live.state === "FINALISED") {
              if (!(await manager.listRefs(journal.getProject(ws.projectId)?.path ?? "", "refs/axis/archive/")).has(archiveRef)) {
                throw worktreeFailure("E_CONFLICT", "no_archive");
              }
            } else {
              // Journal first: the intent is recorded and audited BEFORE git changes. If this write fails, git is untouched.
              deps.audit.append({
                actor, action: "worktree.finalise", target: `workspace:${ws.id}`, outcome: "success",
                payload: { workspaceId: ws.id, outcome: req.outcome, phase: "begin" },
              });
              const done = await manager.finalise({ path: ref.workTree, outcome: req.outcome, discardConfirmation: ctx.confirmation });
              backupRef = done.backupRef;
              skippedLarge = done.skippedLarge.length;
            }
            deps.transact(() => {
              journal.transitionWorkspace(ws.id, "FINALISED", { actor, outcome: req.outcome, expectedFrom: "READY" });
              deps.audit.append({
                actor, action: "worktree.finalise", target: `workspace:${ws.id}`, outcome: "success",
                payload: { workspaceId: ws.id, outcome: req.outcome, phase: "done", backupRef, skippedLarge },
              });
            });
            return { id: ws.id, state: "FINALISED" as const, archiveRef };
          });
        },
        ctx.signal,
      );
    },

    async remove(req, ctx) {
      const first = liveWorkspace(journal, req.id);
      const actor = actorOf(ctx);
      return mutex.run(
        first.projectId,
        async () => {
          const ws = liveWorkspace(journal, req.id);
          if (ws.state !== "FINALISED") throw worktreeFailure("E_CONFLICT", "not_finalised");
          assertNoActiveRun(journal, deps.runs, ws.id);
          const ref = await locator.locate(ws.id);
          // Journal first: REMOVING is written (and audited by the transition record) before the repository changes.
          journal.transitionWorkspace(ws.id, "REMOVING", { actor, reason: "REMOVE_REQUESTED", expectedFrom: "FINALISED" });
          try {
            return await withLockRecord(ws.id, actor, async () => {
              const done = await manager.remove({ path: ref.workTree, deleteBranch: req.deleteBranch === true, discardConfirmation: ctx.confirmation });
              deps.transact(() => {
                journal.transitionWorkspace(ws.id, "REMOVED", { actor, expectedFrom: "REMOVING" });
                deps.audit.append({
                  actor, action: "worktree.remove", target: `workspace:${ws.id}`, outcome: "success",
                  payload: {
                    workspaceId: ws.id, deleteBranch: done.branchDeleted, backupRef: done.backupRef, dirty: done.backupRef !== null,
                    branchBackupRef: done.branchBackupRef, skippedLarge: done.skippedLarge.length, ignored: done.ignored.length,
                    skippedUnsupported: done.skippedUnsupported.length,
                  },
                });
              });
              return { id: ws.id, state: "CLEANED" as const, ...(done.backupRef === null ? {} : { backupRef: done.backupRef }) };
            });
          } catch (e) {
            // Refused or failed with the worktree still in place: back to where it started. If the directory is gone the
            // removal may have half happened, so the row stays REMOVING for recovery and reconcile to report.
            const intact = await locator.locate(ws.id).then(() => true, () => false);
            if (intact) {
              try {
                journal.transitionWorkspace(ws.id, "FINALISED", { actor, reason: "REMOVE_REFUSED", expectedFrom: "REMOVING" });
              } catch {
                // left REMOVING: reconcile reports it
              }
            }
            throw e;
          }
        },
        ctx.signal,
      );
    },

    async restoreFromRunBase(req, ctx) {
      const first = liveWorkspace(journal, req.id);
      const actor = actorOf(ctx);
      return mutex.run(
        first.projectId,
        async () => {
          const ws = liveWorkspace(journal, req.id);
          if (ws.state !== "READY") throw worktreeFailure("E_CONFLICT", "not_ready");
          // The run must be this workspace's: refs/axis/runbase/<runId> is shared by every worktree of the repository.
          const run = journal.getRun(req.runId);
          if (run === undefined || run.workspaceId !== ws.id) throw worktreeFailure("E_NOT_FOUND");
          assertNoActiveRun(journal, deps.runs, ws.id);
          const ref = await locator.locate(ws.id);
          // Before any write: every path must be a plain file path inside THIS workspace (a symlink in it could lead elsewhere).
          for (const rel of req.paths) await assertSafeRestorePath(ref.workTree, rel, deps.platform);
          return withLockRecord(ws.id, actor, async () => {
            const restored: string[] = [];
            let backupRef: string | undefined;
            try {
              for (const rel of req.paths) {
                ctx.signal.throwIfAborted();
                const one = await manager.restoreFromRunBase({ path: path.join(ref.workTree, ...rel.split("/")), runId: run.id, expectedWorktree: ref.workTree });
                if (one.relPath !== rel) throw worktreeFailure("E_INTERNAL");
                restored.push(one.relPath);
                backupRef ??= one.backupRef; // the first backup holds the state before anything was restored
              }
            } catch (e) {
              if (restored.length === 0) throw e;
              throw worktreeFailure("E_CONFLICT", "partial_restore");
            } finally {
              if (restored.length > 0) {
                deps.audit.append({
                  actor, action: "worktree.restore", target: `workspace:${ws.id}`, outcome: "success",
                  payload: { workspaceId: ws.id, runId: run.id, fileCount: restored.length, backupRef: backupRef ?? null },
                });
              }
            }
            return { backupRef: backupRef as string, restored };
          });
        },
        ctx.signal,
      );
    },

    async previewDiscard(workspaceId, ctx): Promise<DiscardPreview> {
      const ws = liveWorkspace(journal, workspaceId);
      return mutex.run(
        ws.projectId,
        async () => {
          const scan = await manager.previewDiscard((await locator.locate(ws.id)).workTree);
          return {
            fingerprint: scan.fingerprint, dirtyFiles: scan.dirty.length, skippedLarge: scan.skippedLarge.length,
            ignored: scan.ignored.length, skippedUnsupported: scan.skippedUnsupported.length,
          };
        },
        ctx.signal,
      );
    },

    async assertNoDrift(workspaceId, ctx) {
      const ws = liveWorkspace(journal, workspaceId);
      await mutex.run(ws.projectId, async () => manager.assertNoDrift((await locator.locate(ws.id)).workTree), ctx.signal);
    },

    async reconcile(signal) {
      const report = await reconcileWorktrees({ journal, manager, mutex, platform: deps.platform }, signal);
      attention = new Map(report.needsAttention.map((n) => [n.workspaceId, n.reason]));
      return report;
    },
  };

  return { service, needsAttention: (id) => attention.has(id) };
}
