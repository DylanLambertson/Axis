// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { AxisError } from "@axis/audit";
import type { Journal } from "@axis/journal";
import type { TrustCheckRequest } from "../control/client.js";
import { bindingMatches, readRepositoryBinding, type BindingResult } from "../projects/binding.js";
import type { TrustSubject } from "../ports/trust.js";

/**
 * The project trust gate (docs/design/project-registration-and-trust.md §5.4). A gated call is trusted only when ALL hold, read
 * in this order at the call:
 *   T1  the journal's run-trust record is `trusted` (set only by main's dialog, `projects.trust`);
 *   T2  the project folder is still the repository it was bound to (`<path>/.git`, its `<dev>:<ino>`); a failure drops the record
 *       (`binding_lost`, audited) and stops the project's live runs;
 *   W   for a call on a workspace: its worktree's `.git` is a `gitdir:` file into `<common_dir>/worktrees/<name>`, whose
 *       `commondir` resolves to the project's `common_dir` (a run cannot repoint its worktree at another repository);
 *   T3  main answers `trust.check` true: the window is live and the path is inside a folder the Workspace Trust model trusts;
 *   T4  no registry revoke for the window or workspace, re-read here (one recorded during a push's confirmation refuses).
 * A refusal is `E_POLICY_DENIED` (`reason: "untrusted"`) INTERNALLY; handlers answer it `E_CONFLICT` `untrusted` on the wire
 * (a handler cannot raise `E_POLICY_DENIED`: `packages/daemon/src/errors.ts`).
 *
 * The gate mints a `ProjectTrustTicket`: single use, bound to `{ projectId, workspaceId? }`, valid for 1 s on the monotonic clock.
 * Every gated side-effect port takes one and `consume`s it at its entry, before any work of its own, so a handler cannot reach
 * the side effect without calling the gate, and it calls the gate inside the project mutex after any confirmation.
 */
export const TICKET_TTL_MS = 1_000;

const STATE = new WeakMap<object, { readonly projectId: string; readonly workspaceId: string | undefined; readonly at: number; spent: boolean }>();

/** The key only this module holds: no other code can construct a ticket. */
const MINT: unique symbol = Symbol("project-trust-ticket");

/** Minted only by `ProjectTrustGate.admit`; the brand is the private field (a structural copy is refused). */
export class ProjectTrustTicket {
  readonly #brand = true;
  constructor(key: typeof MINT) {
    if (key !== MINT) throw untrusted();
  }
  static isTicket(v: unknown): v is ProjectTrustTicket {
    return typeof v === "object" && v !== null && #brand in v;
  }
}

function mint(projectId: string, workspaceId: string | undefined, at: number): ProjectTrustTicket {
  const t = new ProjectTrustTicket(MINT);
  STATE.set(t, { projectId, workspaceId, at, spent: false });
  return t;
}

export const untrusted = (): AxisError => new AxisError("E_POLICY_DENIED", "The project is not trusted", { reason: "untrusted" });

export interface ProjectTrustGateDeps {
  readonly journal: Pick<Journal, "getProject" | "getWorkspace" | "setProjectTrust">;
  /** The repository binding of a project folder (`readRepositoryBinding` with the host's platform and uid). */
  readonly binding: (path: string, signal: AbortSignal) => Promise<BindingResult>;
  /** Main's half (T3): resolves when trusted, rejects otherwise (`ControlClient.trustCheck`). */
  readonly trustCheck: (request: TrustCheckRequest, options: { readonly signal: AbortSignal }) => Promise<void>;
  readonly registry: { isRevoked(subject: TrustSubject): boolean };
  /** Monotonic milliseconds. */
  readonly now: () => number;
  /** Called after a lost binding dropped the record: stop the project's live runs. Never throws into the gate. */
  readonly onRevoked?: (projectId: string) => void;
  /** Test seam: the filesystem the workspace binding reads. */
  readonly fs?: { lstat: typeof lstat; readFile: typeof readFile; realpath: typeof realpath };
}

export interface ProjectTrustGate {
  /** Every condition, in order; a fresh ticket, or `untrusted`. */
  admit(call: { readonly projectId: string; readonly windowId: string; readonly workspaceId?: string; readonly signal: AbortSignal }): Promise<ProjectTrustTicket>;
}

/** At a port's entry: the ticket is real, unspent, fresh and for this project and workspace; it is spent here. */
export function consumeTicket(ticket: unknown, scope: { readonly projectId: string; readonly workspaceId?: string }, now: () => number): void {
  const s = ProjectTrustTicket.isTicket(ticket) ? STATE.get(ticket) : undefined;
  if (s === undefined || s.spent) throw untrusted();
  s.spent = true;
  if (now() - s.at > TICKET_TTL_MS || s.at > now() || s.projectId !== scope.projectId || s.workspaceId !== scope.workspaceId) throw untrusted();
}

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
      if (deps.registry.isRevoked({ windowId, ...(workspaceId === undefined ? {} : { workspaceId }) })) throw untrusted();
      return mint(projectId, workspaceId, deps.now());
    },
  };
}

/**
 * The composer's `start` as the `axis.runs/1` handler sees it: the ticket is spent first, for the workspace's project, then the
 * service starts the run. The handler holds no other way to start one.
 */
export function ticketedStart<I extends { readonly workspaceId: string }, R>(
  start: (input: I, signal: AbortSignal) => R,
  projectOf: (workspaceId: string) => string | undefined,
  now: () => number,
): (input: I, signal: AbortSignal, ticket: unknown) => R {
  return (input, signal, ticket) => {
    consumeTicket(ticket, { projectId: projectOf(input.workspaceId) ?? "", workspaceId: input.workspaceId }, now);
    return start(input, signal);
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

const GATED = new WeakSet<object>();

/**
 * Marks a handler of a gated row (`project` or `per-start`): it reaches its side effect only through the gate. The coverage
 * check (`checkCoverage`'s `gated`) fails the start, exit 70, unless exactly the gated rows are registered with marked handlers.
 */
export function projectGated<H extends object>(handler: H): H {
  GATED.add(handler);
  return handler;
}

export function isProjectGated(handler: unknown): boolean {
  return typeof handler === "object" || typeof handler === "function" ? GATED.has(handler as object) : false;
}
