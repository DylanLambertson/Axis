// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Journal } from "@axis/journal";
import type { PtyPort, PtyTerminalHandle, PtyTerminalPort } from "../ports/pty.js";
import { terminalPortOf } from "./handlers.js";
import { TerminalRegistry } from "./registry.js";

/** The host's terminals: the registry over the terminal port. Absent when the pty port lacks any of the four parts. */
export interface HostTerminals {
  readonly registry: TerminalRegistry;
  readonly port: PtyTerminalPort;
}

export function hostTerminals(pty: unknown): HostTerminals | undefined {
  const port = terminalPortOf(pty);
  return port === undefined ? undefined : Object.freeze({ registry: new TerminalRegistry({ port }), port });
}

/** A run's workspace and project, from the journal. */
export function runScope(journal: Pick<Journal, "getRun" | "getWorkspace">, runId: string): { readonly workspaceId: string; readonly projectId: string } | undefined {
  const run = journal.getRun(runId);
  const ws = run === undefined ? undefined : journal.getWorkspace(run.workspaceId);
  return ws === undefined ? undefined : { workspaceId: ws.id, projectId: ws.projectId };
}

/**
 * Terminals-contract section 8: the runs' pty port, wrapped so a CLI run's terminal is recorded (its `runId` against its
 * `terminalId`) when it spawns. The registry drops it once it ended and its group is gone. Recording never changes the spawn: a
 * handle without a valid terminal id, or a run the journal cannot place, is simply not recorded (it cannot be attached).
 */
export function recordRunTerminals(inner: PtyPort, terminals: HostTerminals | undefined, scope: (runId: string) => { readonly workspaceId: string; readonly projectId: string } | undefined): PtyPort {
  if (terminals === undefined) return inner;
  return {
    async spawn(spec) {
      const handle = await inner.spawn(spec);
      try {
        const where = scope(spec.runId);
        if (where !== undefined) terminals.registry.addCliRun(handle as PtyTerminalHandle, { runId: spec.runId, ...where });
      } catch {
        /* not recorded: the run is unaffected, and its terminal cannot be attached */
      }
      return handle;
    },
  };
}

/**
 * Terminals-contract section 2 step 4: project untrust and binding loss reach the plain terminals too. The terminals' abandonment is
 * SYNCHRONOUS, before the run stop (which queues behind the project mutex), and a failure in either never stops the other.
 */
export function withTerminalFanOut(stopRuns: (projectId: string) => void, terminals: HostTerminals | undefined): (projectId: string) => void {
  return (projectId) => {
    try {
      terminals?.registry.projectRevoked(projectId);
    } catch {
      /* the run stop below still runs */
    }
    stopRuns(projectId);
  };
}
