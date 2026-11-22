// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import type { Journal } from "@axis/journal";
import type { TrustCheckRequest } from "../control/client.js";
import type { BindingResult } from "../projects/binding.js";
import { spendTicket, type ProjectTrustTicket } from "./project-ticket.js";
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

/** The ticket type (its brand and state live in project-ticket.ts, which only the gate modules load). */
export type { ProjectTrustTicket };

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
  readonly fs?: { lstat: typeof import("node:fs/promises").lstat; readFile: typeof import("node:fs/promises").readFile; realpath: typeof import("node:fs/promises").realpath };
}

export interface ProjectTrustGate {
  /** Every condition, in order; a fresh ticket, or `untrusted`. */
  admit(call: { readonly projectId: string; readonly windowId: string; readonly workspaceId?: string; readonly signal: AbortSignal }): Promise<ProjectTrustTicket>;
}

/** At a port's entry: the ticket is real, unspent, fresh and for this project and workspace; it is spent here. */
export function consumeTicket(ticket: unknown, scope: { readonly projectId: string; readonly workspaceId?: string }, now: () => number): void {
  if (!spendTicket(ticket, scope, now, TICKET_TTL_MS)) throw untrusted();
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
