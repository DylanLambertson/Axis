// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { trustCallOf } from "../src/gate/project-trust.js";
import { createProjectTrustGate } from "../src/gate/project-trust-gate.js";
import type { ProjectTrustGate, ProjectTrustTicket } from "../src/gate/project-trust.js";

/**
 * TESTS ONLY: a REAL project trust gate (`createProjectTrustGate`) over inputs in which every condition holds: a trusted, bound
 * row for any project, a matching binding, a worktree that belongs, main answering true, no revoke. Tests of everything behind
 * the gate (ports, handlers, runs) use it to obtain genuine tickets; the gate's own refusals are tested in project-trust.test.ts.
 */
export function openTrustGate(now: () => number = () => performance.now()): ProjectTrustGate {
  return {
    admit: (call) => {
      const row = { id: call.projectId, path: "/open/repo", trusted: true, commonDir: "/open/repo/.git", gitDirId: "1:1" };
      const gate = createProjectTrustGate({
        journal: {
          getProject: () => row as never,
          getWorkspace: (id: string) => ({ id, projectId: call.projectId, worktreePath: "/open/wt" }) as never,
          setProjectTrust: () => row as never,
        },
        binding: async () => ({ ok: true, binding: { path: row.path, commonDir: row.commonDir, gitDirId: row.gitDirId } }),
        trustCheck: async () => undefined,
        registry: { isRevoked: () => false },
        now,
        fs: {
          lstat: (async () => ({ isFile: () => true, size: 32 })) as never,
          readFile: (async (p: string) => (String(p).endsWith(".git") ? "gitdir: /open/repo/.git/worktrees/w\n" : "/open/repo/.git\n")) as never,
          realpath: (async (p: string) => String(p)) as never,
        },
      });
      return gate.admit(call);
    },
  };
}

/** A genuine, fresh ticket for these facts (spend it within the ticket's 1 s). */
export function ticketFor(projectId: string, workspaceId?: string, now?: () => number): Promise<ProjectTrustTicket> {
  return openTrustGate(now).admit({ projectId, caller: trustCallOf({ windowId: "win-1", clientKind: "desktop" }), ...(workspaceId === undefined ? {} : { workspaceId }), signal: new AbortController().signal });
}
