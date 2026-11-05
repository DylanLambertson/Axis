// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ApprovalContentHook } from "@axis/daemon";
import type { Journal } from "@axis/journal";
import type { RunsService } from "../ports/runs.js";
import type { WorktreeLocator } from "../ports/worktree-locator.js";
import { worktreeFailure } from "./errors.js";
import { assertNoActiveRun, liveWorkspace } from "./guards.js";
import type { ProjectMutex } from "./project-mutex.js";
import type { ManagerShape } from "./shapes.js";

export interface WorktreeHookDeps {
  readonly journal: Pick<Journal, "getWorkspace" | "listRuns">;
  readonly runs: Pick<RunsService, "hasActiveRun">;
  readonly locator: WorktreeLocator;
  readonly manager: Pick<ManagerShape, "previewDiscard" | "assertNoDrift">;
  readonly mutex: ProjectMutex;
  /**
   * Told what a call would discard, in words, at the moment its content digest was taken (under the lock). The
   * gate's `describe` callback shows it in the native dialog (`gate/worktrees-confirm.ts`). Display text only,
   * built from the branch the host named and counts, never from file names.
   */
  readonly onPreview?: (target: string, contentDigest: string, text: string) => void;
}

/** What a workspace discard call would lose, as one short line of counts (no file names, nothing an agent wrote). */
function previewText(branch: string, scan: { dirty: readonly unknown[]; skippedLarge: readonly string[]; ignored: readonly string[]; skippedUnsupported: readonly string[] }): string {
  const unbacked = scan.skippedLarge.length + scan.ignored.length + scan.skippedUnsupported.length;
  return `${branch}: ${scan.dirty.length} changed, ${unbacked} not backed up`;
}

/**
 * The approval content hooks of `finalise` and `remove` (design section 7.2, `docs/packages.md` "Calling
 * `@axis/worktrees` from the daemon"). The target is `workspace:<id>`, never a path. `withLock(fn)` takes the project
 * mutex, refuses while a run is active (BEFORE `fn`, so a refusal never spends an approval), checks that the git
 * configuration did not drift (`assertNoDrift`), then hands `fn` the `previewDiscard` fingerprint as the content
 * digest: the same read at issue and again at execute under the same lock, so a file added, removed or changed after
 * the user confirmed makes the spend refuse. The handler then runs inside this lock (the mutex is re-entrant for
 * it). A workspace the caller cannot name is `E_NOT_FOUND` and nothing is issued.
 */
export function createWorktreeContentHooks(deps: WorktreeHookDeps): { readonly finalise: ApprovalContentHook; readonly remove: ApprovalContentHook } {
  const hook: ApprovalContentHook = (context, payload) => {
    const id = (payload as { id?: unknown }).id;
    if (typeof id !== "string") throw worktreeFailure("E_INVALID_ARGUMENT");
    const ws = liveWorkspace(deps.journal, id);
    const target = `workspace:${ws.id}`;
    return {
      target,
      withLock: <T>(fn: (contentDigest: string) => Promise<T>): Promise<T> =>
        deps.mutex.run(
          ws.projectId,
          async () => {
            assertNoActiveRun(deps.journal, deps.runs, ws.id);
            const ref = await deps.locator.locate(ws.id);
            await deps.manager.assertNoDrift(ref.workTree);
            const scan = await deps.manager.previewDiscard(ref.workTree);
            deps.onPreview?.(target, scan.fingerprint, previewText(ws.branch, scan));
            return fn(scan.fingerprint);
          },
          context.signal,
        ),
    };
  };
  return { finalise: hook, remove: hook };
}
