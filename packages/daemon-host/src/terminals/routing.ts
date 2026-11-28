// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { AuditEventInput } from "@axis/audit";
import type { TrustRevocation, TrustRevocationSource } from "../ports/trust.js";
import type { TerminalRevocationRouting } from "./handlers.js";
import type { TerminalRegistry } from "./registry.js";

/** An installed routing: `active()` attests to the live subscription; `dispose()` removes it (idempotent). */
export interface InstalledTerminalRevocationRouting extends TerminalRevocationRouting {
  dispose(): void;
}

function source(trust: unknown): TrustRevocationSource | undefined {
  return typeof trust === "object" && trust !== null && typeof (trust as { onRevoked?: unknown }).onRevoked === "function" ? (trust as TrustRevocationSource) : undefined;
}

/**
 * DC-3c (terminal-trust-revocation.md section 6.1): registers the terminal registry's listener on the trust registry's revocation
 * event. A source without `onRevoked` gives no routing at all. The listener does only the registry's synchronous scan
 * (`TerminalRegistry.revoked`); the audit rows are written after it, in a microtask, each caught on its own (`onAuditError`).
 */
export function installTerminalRevocationRouting(
  trust: unknown,
  registry: TerminalRegistry,
  audit: (event: AuditEventInput) => void,
  onAuditError?: () => void,
): InstalledTerminalRevocationRouting | undefined {
  const src = source(trust);
  if (src === undefined) return undefined;
  let live = true;
  const sub = src.onRevoked((event: TrustRevocation) => {
    if (!live) return;
    const outcomes = registry.revoked(event);
    if (outcomes.length === 0) return;
    queueMicrotask(() => {
      for (const o of outcomes) {
        try {
          audit({
            actor: "daemon",
            action: "terminal.revoked",
            target: o.terminalId === null ? `workspace:${o.workspaceId}` : `terminal:${o.terminalId}`,
            outcome: "success",
            payload: { ...(o.terminalId === null ? {} : { terminalId: o.terminalId }), workspaceId: o.workspaceId, projectId: o.projectId, level: event.kind, outcome: o.outcome },
          });
        } catch {
          onAuditError?.();
        }
      }
    });
  });
  return {
    active: () => live,
    dispose: () => {
      if (!live) return;
      live = false;
      sub.dispose();
    },
  };
}
