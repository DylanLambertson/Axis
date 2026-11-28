// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { AuditEventInput } from "@axis/audit";
import type { HandlerContext } from "@axis/daemon";
import type { Journal, Project, Workspace } from "@axis/journal";
import { buildPlainTerminalEnv } from "@axis/pty-policy";
import { consumeTicket, trustCallOf, type ProjectTrustGate } from "../gate/project-trust.js";
import type { PtyTerminalHandle, PtyTerminalPort } from "../ports/pty.js";
import type { TrustRegistry } from "../ports/trust.js";
import type { WorktreeLocator } from "../ports/worktree-locator.js";
import type { ProjectMutex } from "../worktrees/project-mutex.js";
import { terminalFailure } from "./errors.js";
import type { TerminalRecord, TerminalRegistry } from "./registry.js";

export interface TerminalServiceDeps {
  readonly registry: TerminalRegistry;
  readonly port: PtyTerminalPort;
  readonly journal: Pick<Journal, "getWorkspace" | "getProject">;
  /** The shared worktree locator (DMN-2): canonical path, inside the real managed root, a linked worktree of its own. */
  readonly locator: WorktreeLocator;
  /** The repository binding: the worktree's `.git` is a worktree of the project's common directory (`worktreeBelongs`). */
  readonly belongs: (worktree: string, commonDir: string) => Promise<boolean>;
  /** The project trust gate (T1 to T4); its single-use ticket is consumed in the final admission. */
  readonly gate: ProjectTrustGate;
  /** The trust registry's revocations, re-read in the final admission. */
  readonly trust: Pick<TrustRegistry, "isRevoked">;
  readonly mutex: Pick<ProjectMutex, "run">;
  readonly needsAttention?: (workspaceId: string, method?: string) => boolean;
  /** The shell rule (section 3); `undefined` refuses `shell_unavailable`. */
  readonly shell: () => Promise<string | undefined>;
  /** The terminal's environment (section 3): exactly `plainTerminalEnv` of the daemon's own environment. */
  readonly env: () => Readonly<Record<string, string>>;
  /** The monotonic clock the ticket was minted on. */
  readonly now: () => number;
  readonly audit: (event: AuditEventInput) => void;
}

/** Section 3: the daemon's own environment, no user environment, no shell integration, no passthrough, secret names stripped. */
export function plainTerminalEnv(daemonEnv: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): Readonly<Record<string, string>> {
  return buildPlainTerminalEnv(daemonEnv, { stripSecretNames: true, platform }).env;
}

/**
 * The audit payload fields of `axis.terminals/1` (contract section 6, review S3): ids only, never a path, the shell, the
 * environment or any data. Without this allow-list the audit log reduces the payload to a summary and the ids are lost.
 */
export const TERMINALS_PAYLOAD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "terminal.open": Object.freeze(["terminalId", "workspaceId", "projectId"]),
  "terminal.close": Object.freeze(["terminalId", "workspaceId", "projectId"]),
  "terminal.attach": Object.freeze(["terminalId", "conn"]),
  // DC-3c: a revoke reached a terminal (or a pending open: no terminal id); the level is the revoke's kind, never a window id.
  "terminal.revoked": Object.freeze(["terminalId", "workspaceId", "projectId", "level", "outcome"]),
});

const notFound = () => terminalFailure("not_found");
let seq = 0;

/** The workspace as it must be for a terminal: live, READY, with its recorded path. */
function usable(ws: Workspace | undefined): ws is Workspace & { worktreePath: string } {
  return ws !== undefined && ws.state === "READY" && ws.worktreePath !== null;
}

async function locate(deps: TerminalServiceDeps, workspaceId: string): Promise<string> {
  try {
    return (await deps.locator.locate(workspaceId)).workTree;
  } catch {
    throw notFound();
  }
}

/**
 * Section 2 step 3: the final admission, after the last await and with none before the dispatch. The live state is read again: the
 * project's trust and binding identity now (not the gate's earlier answer), the registry's revocations for the caller's windows, the
 * workspace's READY state, path and lock identity, and the request's cancellation. Throws to refuse.
 */
function finalAdmission(deps: TerminalServiceDeps, context: HandlerContext, project: Project, start: Workspace, workTree: string): void {
  if (context.signal.aborted) throw terminalFailure("cancelled");
  const p = deps.journal.getProject(project.id);
  if (p === undefined || !p.trusted || p.path !== project.path || p.commonDir !== project.commonDir || p.gitDirId !== project.gitDirId) throw notFound();
  if (revokedFor(deps.trust, context, start.id, project.id)) throw notFound();
  const ws = deps.journal.getWorkspace(start.id);
  if (!usable(ws) || ws.projectId !== project.id || ws.worktreePath !== workTree || ws.lockState !== start.lockState || ws.lockedAt !== start.lockedAt) throw notFound();
}

/**
 * `open` (section 2): resolve the workspace through the locator, admit through the trust gate, check the locator and the binding
 * again, then the synchronous final admission, the slot, the ticket and the dispatch. The spawn's `cwd` is the locator's canonical
 * path. A cancellation while the spawn is pending abandons it logically: its handle, whenever it comes, is never published.
 */
export async function openTerminal(deps: TerminalServiceDeps, req: { readonly workspaceId: string; readonly cols: number; readonly rows: number }, context: HandlerContext): Promise<TerminalRecord> {
  const ws = deps.journal.getWorkspace(req.workspaceId);
  if (!usable(ws)) throw notFound();
  if (deps.needsAttention?.(req.workspaceId, "open") === true) throw terminalFailure("needs_attention");
  const shell = await deps.shell();
  if (shell === undefined) throw terminalFailure("shell_unavailable");
  return deps.mutex.run(
    ws.projectId,
    async () => {
      const start = deps.journal.getWorkspace(req.workspaceId);
      const project = deps.journal.getProject(ws.projectId);
      if (!usable(start) || start.projectId !== ws.projectId || project === undefined || project.commonDir === null) throw notFound();
      await locate(deps, req.workspaceId);
      let ticket: unknown;
      try {
        ticket = await deps.gate.admit({ projectId: project.id, caller: trustCallOf(context.identity), workspaceId: req.workspaceId, signal: context.signal });
      } catch (e) {
        context.signal.throwIfAborted();
        throw e;
      }
      const workTree = await locate(deps, req.workspaceId);
      if (!(await deps.belongs(workTree, project.commonDir).catch(() => false))) throw notFound();
      // ---- synchronous from here to the dispatch: no await ----
      finalAdmission(deps, context, project, start, workTree);
      const op = deps.registry.reserve(req.workspaceId, project.id, context.identity.windowId); // DC-3c: the opener's window
      if (op === undefined) throw terminalFailure("too_many_terminals");
      try {
        consumeTicket(ticket, { projectId: project.id, workspaceId: req.workspaceId }, deps.now);
      } catch (e) {
        deps.registry.failed(op, { definitive: true });
        throw e;
      }
      let spawned: Promise<PtyTerminalHandle>;
      try {
        spawned = deps.port.spawn({ runId: `term_${++seq}`, argv: [shell], cwd: workTree, env: deps.env(), cols: req.cols, rows: req.rows }, (late) => deps.registry.late(op, late));
      } catch (e) {
        deps.registry.failed(op, e);
        throw terminalFailure("spawn_failed");
      }
      // ---- the dispatch is made; the outcome is the registry's, whatever this call does next ----
      const outcome = spawned.then(
        (h) => deps.registry.publish(op, h),
        (e: unknown) => (deps.registry.failed(op, e), undefined),
      );
      const aborted = new Promise<"aborted">((resolve) => {
        if (context.signal.aborted) resolve("aborted");
        context.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      });
      const rec = await Promise.race([outcome, aborted]);
      if (rec === "aborted") {
        // Review S2: the answer may have published the terminal in the same turn; abandon ends it then, and it is audited as closed.
        // Review 2 nit 2: the shell existed, so its open is audited too, then its close.
        const ended = deps.registry.abandon(op);
        if (ended !== undefined) (auditOpen(deps, ended), auditClose(deps, ended));
        throw terminalFailure("cancelled"); // thrown while aborted: the daemon keeps the key outcome-unknown
      }
      if (rec === undefined) throw terminalFailure("spawn_failed");
      auditOpen(deps, rec);
      return rec;
    },
    context.signal,
  );
}

function auditOpen(deps: Pick<TerminalServiceDeps, "audit">, rec: TerminalRecord): void {
  deps.audit({ actor: "user", action: "terminal.open", target: `terminal:${rec.terminalId}`, outcome: "success", payload: { terminalId: rec.terminalId, workspaceId: rec.workspaceId, projectId: rec.projectId } });
}

function auditClose(deps: Pick<TerminalServiceDeps, "audit">, rec: TerminalRecord): void {
  deps.audit({ actor: "user", action: "terminal.close", target: `terminal:${rec.terminalId}`, outcome: "success", payload: { terminalId: rec.terminalId, workspaceId: rec.workspaceId, projectId: rec.projectId } });
}

/** `close` (section 4): a plain terminal only; idempotent. */
export function closeTerminal(deps: Pick<TerminalServiceDeps, "registry" | "audit">, terminalId: string): void {
  const rec = deps.registry.get(terminalId);
  if (rec === undefined || rec.kind !== "plain" || !deps.registry.close(terminalId)) throw notFound();
  auditClose(deps, rec);
}

/**
 * True when a registry revoke covers the caller's windows for the workspace or the project (terminal-trust-revocation.md 4.2).
 * Review N6: the host-window branch is defence in depth only. `hostWindowId` is present exactly for a plugin client, which the
 * handlers refuse first, so no admitted caller reaches it today, and its tests do not claim it.
 */
function revokedFor(trust: Pick<TrustRegistry, "isRevoked">, context: HandlerContext, workspaceId: string, projectId: string): boolean {
  const { windowId, hostWindowId } = context.identity;
  for (const w of hostWindowId === undefined ? [windowId] : [windowId, hostWindowId]) {
    for (const subject of [workspaceId, projectId]) if (trust.isRevoked({ windowId: w, workspaceId: subject })) return true;
  }
  return false;
}

/**
 * `attach` (section 5): only an `open` terminal is granted, and not under a registry revoke of the caller's windows for its workspace
 * or project. Both are read immediately before the grant, with no await between.
 */
export function attachTerminal(deps: Pick<TerminalServiceDeps, "registry" | "port" | "audit" | "trust" | "journal">, terminalId: string, conn: string, context: HandlerContext): void {
  const rec = deps.registry.attachable(terminalId);
  if (rec === undefined || revokedFor(deps.trust, context, rec.workspaceId, rec.projectId)) throw notFound();
  // Review N2: the project's trust now, from the journal. An untrust closes plain terminals at once, but a CLI run's terminal stays
  // open until its run's stop, which queues behind the project mutex: it is not attachable meanwhile.
  if (deps.journal.getProject(rec.projectId)?.trusted !== true) throw notFound();
  deps.registry.noteWindow(terminalId, context.identity.windowId); // DC-3c: a revoke of this window now reaches it
  deps.port.grantTerminal(terminalId, conn);
  deps.audit({ actor: "user", action: "terminal.attach", target: `terminal:${terminalId}`, outcome: "success", payload: { terminalId, conn } });
}
