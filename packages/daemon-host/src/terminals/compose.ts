// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { AuditEventInput } from "@axis/audit";
import type { Journal } from "@axis/journal";
import { contracts, TERMINALS_CONTRACT } from "@axis/protocol";
import { InMemoryTrustRegistry } from "../policy/trust-registry.js";
import type { PtyPort, PtyTerminalHandle, PtyTerminalPort } from "../ports/pty.js";
import type { TrustRegistry } from "../ports/trust.js";
import { isTerminalDataBroker, type TerminalDataBroker } from "../ports/terminal-broker.js";
export type { TerminalDataBroker } from "../ports/terminal-broker.js";
import { terminalPortOf } from "./handlers.js";
import { TerminalRegistry } from "./registry.js";
import { installTerminalRevocationRouting, type InstalledTerminalRevocationRouting } from "./routing.js";

/** The host's terminals: the registry over the terminal port. Absent when the pty port lacks any of the four parts. */
export interface HostTerminals {
  readonly registry: TerminalRegistry;
  readonly port: PtyTerminalPort;
  /** DC-3b's data-port broker attestation (absent: terminals exist for the run wrapper and the guards, but are never served). */
  readonly broker?: TerminalDataBroker;
}

/**
 * DC-3c: the composition's one decision, before the host is built (terminal-trust-revocation.md section 6.1). The trust registry
 * the host will use is fixed here (the injected one, or a new `InMemoryTrustRegistry`), so the routing is later installed on the
 * very object policy reads. Terminals exist only when the pty port has all four parts AND that registry offers `onRevoked`; when
 * they do not, `axis.terminals` is dropped from what the host serves (nothing advertised, no rows, no handlers). It is dropped as
 * well without DC-3b's data-port `broker` attestation: without it no terminal could ever be viewed (decision recorded with DC-3c).
 */
export function composeTerminals<C extends { readonly contracts?: readonly string[] | undefined }, P extends { readonly trust?: TrustRegistry | undefined }>(
  config: C,
  ports: P,
  pty: unknown,
  observe?: (terminals: HostTerminals) => void,
  broker?: unknown,
): { readonly terminals: HostTerminals | undefined; readonly config: C; readonly ports: P & { readonly trust: TrustRegistry } } {
  const trust = ports.trust ?? new InMemoryTrustRegistry();
  const withTrust = { ...ports, trust };
  const capable = typeof (trust as { onRevoked?: unknown }).onRevoked === "function";
  const terminals = capable ? hostTerminals(pty, broker) : undefined;
  if (terminals !== undefined && terminals.broker !== undefined) {
    observe?.(terminals);
    return { terminals, config, ports: withTrust };
  }
  const ids = config.contracts ?? [...new Set(Object.keys(contracts).map((k) => k.slice(0, k.indexOf("/"))))];
  if (terminals !== undefined) observe?.(terminals);
  return { terminals, config: { ...config, contracts: ids.filter((c) => c !== TERMINALS_CONTRACT) }, ports: withTrust };
}

/**
 * DC-3c: installs the routing on the host's trust registry once the host is up, and registers its cleanup: at shutdown the routing
 * is disposed FIRST (the handlers then answer not_found), then the registry abandons pending opens and closes live plain terminals.
 */
export function installTerminals(
  terminals: HostTerminals | undefined,
  trust: unknown,
  audit: (event: AuditEventInput) => void,
  onAuditError: () => void,
  cleanups: Array<() => void>,
): InstalledTerminalRevocationRouting | undefined {
  if (terminals === undefined) return undefined;
  const routing = installTerminalRevocationRouting(trust, terminals.registry, audit, onAuditError);
  cleanups.push(() => {
    routing?.dispose();
    terminals.registry.shutdown();
  });
  return routing;
}

export function hostTerminals(pty: unknown, broker?: unknown): HostTerminals | undefined {
  const port = terminalPortOf(pty);
  if (port === undefined) return undefined;
  return Object.freeze({ registry: new TerminalRegistry({ port }), port, ...(isTerminalDataBroker(broker) ? { broker } : {}) });
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
