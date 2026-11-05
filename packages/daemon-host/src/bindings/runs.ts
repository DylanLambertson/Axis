// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { AuditSink, InstanceLock, Redactor } from "@axis/audit";
import type { Journal } from "@axis/journal";
import {
  RUN_AUDIT_ALLOWLIST,
  RunSupervisor,
  type Clock as RunsClock,
  type EnvSource,
  type PtyHandle as SupervisorPtyHandle,
  type PtyPort as SupervisorPtyPort,
  type RunSnapshotter,
  type SupervisorOptions,
  type TrustAttestation,
} from "@axis/runs";
import type { PtyHandle, PtyPort, PtySpawn } from "../ports/pty.js";
import type { RunsService, RunSummary } from "../ports/runs.js";
import type { WorktreeLocator } from "../ports/worktree-locator.js";
import { runFailure, toRunError } from "../runs/errors.js";
import type { ProjectMutex } from "../worktrees/project-mutex.js";

/**
 * The audit payload keys of the run rows (`cli_run.*`), for the host's `AuditLog` `payloadAllowlist`. Without them the log
 * keeps only a length and a hash for these actions.
 */
export const RUN_PAYLOAD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = RUN_AUDIT_ALLOWLIST;

/** Handles whose process group has not been seen gone. More than this refuses the next spawn: a run cannot leave unbounded debris. */
export const MAX_TRACKED_GROUPS = 256;

export interface RunsBindingDeps {
  readonly journal: Journal;
  /** An `AuditLog` bound to the journal's database (the supervisor writes `cli_run.*` rows through it). */
  readonly audit: AuditSink;
  /** The host's pty port: its handle can say whether a finished run's process group is gone. */
  readonly pty: PtyPort;
  /** The supervisor's clock (it also arms the stop ladder's timers). Attestations are stamped with the same clock. */
  readonly clock: RunsClock;
  /** The one locator of `bindings/worktrees.ts`. */
  readonly locator: WorktreeLocator;
  readonly snapshotter: RunSnapshotter;
  readonly env: EnvSource;
  readonly redactor: Redactor;
  /** The project mutex of the worktrees binding (`WorktreesBinding.mutex`): the same instance, or the exclusion means nothing. */
  readonly mutex: Pick<ProjectMutex, "run">;
  readonly limits?: SupervisorOptions["limits"];
  readonly managedWorktreeRoots?: SupervisorOptions["managedWorktreeRoots"];
  readonly extensionVariableNames?: SupervisorOptions["extensionVariableNames"];
  readonly platform?: NodeJS.Platform;
  readonly fs?: SupervisorOptions["fs"];
  readonly onInternalError?: SupervisorOptions["onInternalError"];
  /** Most process groups held under watch at once (default `MAX_TRACKED_GROUPS`); a spawn beyond it is refused. */
  readonly maxTrackedGroups?: number;
}

export interface RunsBinding {
  readonly service: RunsService;
  /** DMN-7 at startup, before any run starts: a run that was RUNNING becomes BLOCKED (`INTERRUPTED_BY_RESTART`). */
  recover(lock: InstanceLock): ReturnType<RunSupervisor["recover"]>;
  /** SIGKILL every live process and release every timer and listener. Process groups seen alive keep counting as active. */
  dispose(): void;
}

interface Tracked {
  readonly workspaceId: string;
  readonly handle: PtyHandle;
}

const isHandle = (h: unknown): h is PtyHandle =>
  typeof h === "object" && h !== null && typeof (h as PtyHandle).kill === "function" && typeof (h as PtyHandle).groupAlive === "function";

/**
 * Binds the real `RunSupervisor` of `@axis/runs` (design sections 4.2 and 6.2, ticket H10): the one file that imports it.
 *
 * Two guarantees beyond the package's own. (1) A finished run's processes are gone before a restore, finalise or remove:
 * `hasActiveRun` (what `refuseIfActiveRun` and the worktree guards ask) is the supervisor's live view OR a process group
 * that a spawned run's handle still reports alive, so a CLI that exits and leaves a child behind keeps the workspace
 * active until the group is gone. A handle that cannot say, or throws, counts as alive. (2) A start takes the project mutex
 * of the worktrees binding, re-reads the workspace under it and refuses unless it is READY and its journal lock is not
 * held, so a start cannot begin inside a directory a `remove` is deleting: the remove holds the mutex and the lock record
 * for its whole run, and a start that waited sees the workspace gone or locked.
 *
 * Every error is a `DaemonError` of fixed text (`toRunError`); nothing the package, the pty or the journal said is forwarded.
 */
export function createRunsBinding(deps: RunsBindingDeps): RunsBinding {
  const tracked = new Map<string, Tracked>();
  const maxTracked = deps.maxTrackedGroups ?? MAX_TRACKED_GROUPS;

  const alive = (t: Tracked): boolean => {
    try {
      return t.handle.groupAlive() !== false;
    } catch {
      return true; // fail closed: a handle that cannot answer counts as alive
    }
  };
  /** Forget the groups that are gone. A group still alive stays, so the map is bounded by what is actually running. */
  const sweep = (): void => {
    for (const [runId, t] of tracked) if (!alive(t)) tracked.delete(runId);
  };
  const groupsAlive = (workspaceId: string): boolean => {
    sweep();
    for (const t of tracked.values()) if (t.workspaceId === workspaceId) return true;
    return false;
  };

  const pty: SupervisorPtyPort = {
    async spawn(spec: PtySpawn): Promise<SupervisorPtyHandle> {
      sweep();
      if (tracked.size >= maxTracked) throw runFailure("E_UNAVAILABLE");
      const workspaceId = deps.journal.getRun(spec.runId)?.workspaceId;
      if (workspaceId === undefined) throw runFailure("E_INTERNAL");
      const handle = await deps.pty.spawn(spec);
      if (!isHandle(handle)) {
        // A process whose group cannot be asked about can never be shown gone: kill it, and report a failed spawn.
        try {
          (handle as Partial<PtyHandle> | null)?.kill?.("SIGKILL");
        } catch {
          // nothing more can be done with it
        }
        throw runFailure("E_INTERNAL");
      }
      tracked.set(spec.runId, { workspaceId, handle });
      return handle;
    },
  };

  const supervisor = new RunSupervisor({
    journal: deps.journal,
    audit: deps.audit,
    pty,
    clock: deps.clock,
    locator: deps.locator,
    snapshotter: deps.snapshotter,
    env: deps.env,
    redactor: deps.redactor,
    ...(deps.limits === undefined ? {} : { limits: deps.limits }),
    ...(deps.managedWorktreeRoots === undefined ? {} : { managedWorktreeRoots: deps.managedWorktreeRoots }),
    ...(deps.extensionVariableNames === undefined ? {} : { extensionVariableNames: deps.extensionVariableNames }),
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
    ...(deps.fs === undefined ? {} : { fs: deps.fs }),
    ...(deps.onInternalError === undefined ? {} : { onInternalError: deps.onInternalError }),
  });

  const call = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      throw toRunError(e);
    }
  };

  const service: RunsService = {
    async start(req) {
      // One read of each field: a getter cannot answer differently later.
      const { workspaceId, agent, actor, trust, idempotencyKey } = req;
      const first = call(() => deps.journal.getWorkspace(workspaceId));
      if (first === undefined || first.state === "REMOVED" || first.state === "FAILED" || first.state === "CREATING") throw runFailure("E_NOT_FOUND");
      return deps.mutex.run(first.projectId, async () => {
        // Re-read under the mutex: a remove, finalise or restore that held it has finished or not begun, and the lock record
        // it keeps around its whole call is visible to us.
        const ws = call(() => deps.journal.getWorkspace(workspaceId));
        if (ws === undefined || ws.projectId !== first.projectId || ws.state === "REMOVED" || ws.state === "FAILED" || ws.state === "CREATING") throw runFailure("E_NOT_FOUND");
        if (ws.state !== "READY") throw runFailure("E_CONFLICT", "not_ready");
        if (ws.lockState === "locked") throw runFailure("E_CONFLICT", "busy");
        if (groupsAlive(workspaceId)) throw runFailure("E_CONFLICT", "active_run");
        try {
          return await supervisor.start({
            workspaceId,
            agent,
            actor,
            trust: trust as unknown as TrustAttestation,
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          });
        } catch (e) {
          throw toRunError(e);
        }
      });
    },
    stop: (runId, actor) => call((): RunSummary => supervisor.stop(runId, actor)),
    get: (runId) => call((): RunSummary => supervisor.get(runId)),
    list: (options) => call((): readonly RunSummary[] => supervisor.list(options)),
    hasActiveRun(workspaceId) {
      return supervisor.hasActiveRun(workspaceId) || groupsAlive(workspaceId);
    },
  };

  return {
    service,
    recover: (lock) => supervisor.recover(lock),
    dispose: () => supervisor.dispose(),
  };
}
