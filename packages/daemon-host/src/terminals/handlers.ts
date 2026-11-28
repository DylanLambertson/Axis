// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Handler, HandlerContext } from "@axis/daemon";
import { TERMINALS_CONTRACT, TERMINALS_VERSION, type Terminal, type TerminalsMethod, type TerminalsRequest } from "@axis/protocol";
import { projectGated } from "../gate/project-trust.js";
import type { HandlerRegistrar } from "../handlers/anchor-guard.js";
import { WEB_WINDOW_ID } from "../policy/rule-table-policy.js";
import type { PtyTerminalPort } from "../ports/pty.js";
import { terminalFailure } from "./errors.js";
import type { TerminalRecord } from "./registry.js";
import { attachTerminal, closeTerminal, openTerminal, type TerminalServiceDeps } from "./service.js";

/**
 * The installed trust-registry routing of DC-3c (terminal-trust-revocation.md section 6.1): `active()` is true only while its
 * listener is registered. DC-3a defines the shape; only DC-3c's `installTerminalRevocationRouting` makes one.
 */
export interface TerminalRevocationRouting {
  active(): boolean;
}

/** The terminal port's four parts (terminals-contract.md section 8), or `undefined` when any is missing. */
export function terminalPortOf(pty: unknown): PtyTerminalPort | undefined {
  if (typeof pty !== "object" || pty === null) return undefined;
  const p = pty as Record<string, unknown>;
  return typeof p["spawn"] === "function" && typeof p["grant"] === "function" && typeof p["revoke"] === "function" && p["lateSpawnReports"] === true ? (pty as PtyTerminalPort) : undefined;
}

/**
 * The one predicate (section 8; terminal-trust-revocation.md section 6.1): every part of the terminal port AND an installed, active
 * routing. Production and every test composition use this function; nothing else lets the handlers register.
 */
export function terminalsServable(pty: unknown, routing: TerminalRevocationRouting | undefined): boolean {
  if (terminalPortOf(pty) === undefined || routing === undefined) return false;
  try {
    return routing.active() === true;
  } catch {
    return false;
  }
}

function wire(r: TerminalRecord): Terminal {
  return { terminalId: r.terminalId, workspaceId: r.workspaceId, projectId: r.projectId, kind: r.kind, runId: r.runId, state: r.state };
}

/**
 * `axis.terminals/1`. Every method refuses, again behind the policy row, any caller but the user's own desktop connection, and
 * any call once the routing is no longer active, with the same `not_found`.
 */
export function createTerminalsHandlers(deps: TerminalServiceDeps, routing: TerminalRevocationRouting): Readonly<Record<TerminalsMethod, Handler>> {
  const guarded =
    <M extends TerminalsMethod>(call: (payload: TerminalsRequest<M>, context: HandlerContext) => Promise<unknown> | unknown): Handler =>
    async (context: HandlerContext, payload: never): Promise<unknown> => {
      if (context.signal.aborted) throw terminalFailure("cancelled");
      const id = context.identity;
      if (id.actor !== "user" || id.clientKind !== "desktop" || id.windowId === WEB_WINDOW_ID) throw terminalFailure("not_found");
      if (!terminalsServable(deps.port, routing)) throw terminalFailure("not_found");
      return call(payload as TerminalsRequest<M>, context);
    };
  return {
    open: projectGated(guarded<"open">(async (req, context) => ({ terminal: wire(await openTerminal(deps, req, context)) }))),
    list: guarded<"list">((req) => ({ terminals: deps.registry.list(req.workspaceId).map(wire) })),
    close: guarded<"close">((req) => (closeTerminal(deps, req.terminalId), { closed: true })),
    attach: guarded<"attach">((req, context) => (attachTerminal(deps, req.terminalId, req.conn, context), { attached: true })),
  };
}

/** Registers `axis.terminals/1` only when `terminalsServable` holds; returns whether it did. */
export function registerTerminalsServing(registrar: HandlerRegistrar, pty: unknown, routing: TerminalRevocationRouting | undefined, deps: (port: PtyTerminalPort) => TerminalServiceDeps): boolean {
  const port = terminalPortOf(pty);
  if (port === undefined || routing === undefined || !terminalsServable(pty, routing)) return false;
  registrar.register(TERMINALS_CONTRACT, TERMINALS_VERSION, createTerminalsHandlers(deps(port), routing));
  return true;
}
