// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { promises as fs } from "node:fs";
import type { Journal, Workspace } from "@axis/journal";
import type { ReconcileReason, ReconcileReport } from "../ports/worktrees.js";
import type { ProjectMutex } from "./project-mutex.js";
import type { ManagerShape } from "./shapes.js";

export interface ReconcileDeps {
  readonly journal: Pick<Journal, "listProjects" | "listWorkspaces">;
  readonly manager: Pick<ManagerShape, "list" | "listRefs" | "status">;
  readonly mutex: ProjectMutex;
  readonly platform: NodeJS.Platform;
  /** Upper bound on what one report keeps (a misbehaving repository cannot grow it). */
  readonly maxReports?: number;
}

const LIVE: ReadonlySet<Workspace["state"]> = new Set(["READY", "FINALISED", "REMOVING"]);
export const DEFAULT_MAX_REPORTS = 1000;
const key = (p: string, platform: NodeJS.Platform): string => (platform === "win32" ? p.toLowerCase() : p);

/**
 * Design section 7.3 and gate G-12: compare what git and the manager's own records say with the journal, which is the
 * authority (Q7). It reports and never repairs: it writes nothing to the repository, the worktrees or the journal (the
 * manager calls used are `list` and `status`, which only read, and ref names are listed with `for-each-ref`).
 * One report entry per workspace, with the first reason found:
 * - `missing_worktree`: the journal says the workspace is live and no managed worktree carries its id, or the
 *   directory is gone;
 * - `unknown_worktree`: a managed worktree whose id the journal has no live record of (a crash between a worktree and
 *   its journal row, or a workspace the journal gave up on);
 * - `ref_mismatch`: the worktree is there but disagrees with the journal: another path, another base commit, another
 *   state in its own `WorkspaceMeta`, or a missing `refs/axis/runbase` or (once finalised) `refs/axis/archive` ref;
 * - `failed`: it could not be read.
 * It runs under each project's mutex, one project at a time, and stops at the next step when `signal` aborts (the
 * startup budget). A REMOVING workspace is reported (its removal may or may not have finished) and left as it is.
 */
export async function reconcileWorktrees(deps: ReconcileDeps, signal: AbortSignal): Promise<ReconcileReport> {
  const cap = deps.maxReports ?? DEFAULT_MAX_REPORTS;
  const found = new Map<string, ReconcileReason>();
  const note = (id: string, reason: ReconcileReason): void => {
    if (!found.has(id) && found.size < cap) found.set(id, reason);
  };
  const live = deps.journal.listWorkspaces().filter((w) => LIVE.has(w.state));
  for (const project of deps.journal.listProjects()) {
    signal.throwIfAborted();
    const mine = live.filter((w) => w.projectId === project.id);
    await deps.mutex.run(
      project.id,
      async () => {
        let entries;
        let archive: ReadonlySet<string>;
        let runbase: ReadonlySet<string>;
        try {
          entries = await deps.manager.list(project.path);
          archive = await deps.manager.listRefs(project.path, "refs/axis/archive/");
          runbase = await deps.manager.listRefs(project.path, "refs/axis/runbase/");
        } catch {
          signal.throwIfAborted();
          for (const w of mine) note(w.id, "failed");
          return;
        }
        const byId = new Map(entries.filter((e) => e.managed && e.id !== null).map((e) => [e.id as string, e]));
        for (const e of byId.values()) {
          // A managed worktree of this repository that the journal has no live record of (a FAILED or REMOVED one included).
          if (!live.some((w) => w.id === e.id)) note(e.id as string, "unknown_worktree");
        }
        for (const w of mine) {
          signal.throwIfAborted();
          const entry = byId.get(w.id);
          if (entry === undefined || entry.prunable) {
            note(w.id, "missing_worktree");
            continue;
          }
          if (w.worktreePath === null || key(entry.path, deps.platform) !== key(w.worktreePath, deps.platform)) {
            note(w.id, "ref_mismatch");
            continue;
          }
          if (!(await fs.stat(entry.path).then((s) => s.isDirectory(), () => false))) {
            note(w.id, "missing_worktree");
            continue;
          }
          if (!runbase.has(`refs/axis/runbase/${w.id}`) || (w.state === "FINALISED" && !archive.has(`refs/axis/archive/${w.id}`))) {
            note(w.id, "ref_mismatch");
            continue;
          }
          try {
            const st = await deps.manager.status(entry.path);
            // REMOVING is the journal's crash-visibility state: its meta is still the state it started from.
            const stateOk = w.state === "REMOVING" || st.state === w.state;
            if (st.baseSha !== w.baseSha || st.id !== w.id) note(w.id, "ref_mismatch");
            else if (!stateOk) {
              // READY in the journal but finalised in git's own record (with its archive ref): a finalise interrupted before the
              // journal step. It is told apart so that an explicit finalise can repair it; anything else is a plain mismatch.
              const half = w.state === "READY" && st.state === "FINALISED" && archive.has(`refs/axis/archive/${w.id}`);
              note(w.id, half ? "finalise_incomplete" : "ref_mismatch");
            }
          } catch {
            signal.throwIfAborted();
            note(w.id, "failed");
          }
        }
      },
      signal,
    );
    // A REMOVING workspace is always worth a look, even when everything on disk agrees.
    for (const w of mine) if (w.state === "REMOVING") note(w.id, "ref_mismatch");
  }
  return { needsAttention: [...found].map(([workspaceId, reason]) => ({ workspaceId, reason })) };
}
