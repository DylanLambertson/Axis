// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { bindingMatches, readRepositoryBinding } from "../projects/binding.js";
import { mintTicket } from "./project-ticket.js";
import { untrusted, type ProjectTrustGate, type ProjectTrustGateDeps } from "./project-trust.js";

/**
 * The project trust gate's factories (docs/design/project-registration-and-trust.md §5.4). Only the composition
 * (`compose-serving.ts`) loads this file (import rules in test/packages/imports.test.mjs and scripts/code-oss/stage-scan.mjs), so no
 * handler, service or binding can build a gate over permissive inputs and mint genuine tickets.
 */
/** W: the worktree belongs to the repository whose common directory is `commonDir`. False on anything unexpected. */
export async function worktreeBelongs(worktree: string, commonDir: string, fs = { lstat, readFile, realpath }): Promise<boolean> {
  try {
    const dotGit = join(worktree, ".git");
    const st = await fs.lstat(dotGit);
    if (!st.isFile() || st.size > 4096) return false;
    const m = /^gitdir: (.+?)\r?\n?$/.exec(await fs.readFile(dotGit, "utf8"));
    if (m === null) return false;
    const target = m[1] as string;
    const gitDir = await fs.realpath(isAbsolute(target) ? target : resolve(worktree, target));
    if (dirname(gitDir) !== join(commonDir, "worktrees")) return false;
    const common = (await fs.readFile(join(gitDir, "commondir"), "utf8")).trim();
    return (await fs.realpath(isAbsolute(common) ? common : resolve(gitDir, common))) === commonDir;
  } catch {
    return false;
  }
}

export function createProjectTrustGate(deps: ProjectTrustGateDeps): ProjectTrustGate {
  return {
    async admit({ projectId, windowId, workspaceId, signal }) {
      if (typeof windowId !== "string" || windowId === "") throw untrusted();
      const row = deps.journal.getProject(projectId);
      if (row === undefined || !row.trusted) throw untrusted();
      const b = await deps.binding(row.path, signal);
      if (!b.ok || !bindingMatches(row, b.binding)) {
        // Only a binding that is really gone drops the record; a filesystem that did not answer refuses this call only.
        if (b.ok || b.reason === "not_a_repository") {
          try {
            deps.journal.setProjectTrust({ id: projectId, trusted: false, via: "binding_lost" });
          } catch {
            // the refusal below stands either way
          }
          try {
            deps.onRevoked?.(projectId);
          } catch {
            // stopping runs never changes the gate's answer
          }
        }
        throw untrusted();
      }
      if (workspaceId !== undefined) {
        const ws = deps.journal.getWorkspace(workspaceId);
        if (ws === undefined || ws.projectId !== projectId || ws.worktreePath === null) throw untrusted();
        if (row.commonDir === null || !(await worktreeBelongs(ws.worktreePath, row.commonDir, deps.fs))) throw untrusted();
      }
      signal.throwIfAborted();
      await deps.trustCheck({ windowId, projectId, projectPath: row.path, ...(workspaceId === undefined ? {} : { workspaceId }) }, { signal });
      // After the LAST await, synchronously, and nothing awaited before the mint: the record (T1, and the row the binding was
      // checked for) and the registry revoke (T4) are read again. An untrust or a revoke recorded while the binding was read or main
      // was asked refuses here, so no ticket outlives the decision it was checked against.
      const still = deps.journal.getProject(projectId);
      if (still === undefined || !still.trusted || still.path !== row.path || still.commonDir !== row.commonDir || still.gitDirId !== row.gitDirId) throw untrusted();
      if (workspaceId !== undefined) {
        const ws = deps.journal.getWorkspace(workspaceId);
        if (ws === undefined || ws.projectId !== projectId || ws.worktreePath === null) throw untrusted();
      }
      if (deps.registry.isRevoked({ windowId, ...(workspaceId === undefined ? {} : { workspaceId }) })) throw untrusted();
      return mintTicket(projectId, workspaceId, deps.now());
    },
  };
}

/** The host's gate: the real binding reader (this process's uid), main's `trust.check`, the registry and the monotonic clock. */
export function createHostProjectTrustGate(o: {
  readonly journal: ProjectTrustGateDeps["journal"];
  readonly control: { trustCheck: ProjectTrustGateDeps["trustCheck"] };
  readonly registry: ProjectTrustGateDeps["registry"];
  readonly platform: NodeJS.Platform;
  readonly now: () => number;
  readonly onRevoked?: (projectId: string) => void;
}): ProjectTrustGate {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return createProjectTrustGate({
    journal: o.journal,
    binding: (path, signal) => readRepositoryBinding(path, { platform: o.platform, uid, signal }),
    trustCheck: (request, options) => o.control.trustCheck(request, options),
    registry: o.registry,
    now: o.now,
    ...(o.onRevoked === undefined ? {} : { onRevoked: o.onRevoked }),
  });
}
