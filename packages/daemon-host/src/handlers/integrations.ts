// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import type { Journal } from "@axis/journal";
import { INTEGRATIONS_CONTRACT, INTEGRATIONS_REFUSAL_MESSAGE, INTEGRATIONS_VERSION, integrationsMethods } from "@axis/protocol";
import { consumeTicket, projectGated, trustCallOf, type ProjectTrustGate } from "../gate/project-trust.js";
import { IntegrationRefusal, wireCode, type IntegrationReason } from "../integrations/wire.js";
import type { IntegrationsService } from "../integrations/service.js";
import type { HandlerRegistrar } from "./anchor-guard.js";

/**
 * `axis.integrations/1` list, status and read (PV-N1f read slice, docs/design/net-read-slice.md). The policy rows admit only
 * `user` (not web, and no plugin permission names them); the handler re-checks a desktop user as defence in depth. An
 * unregistered project is `not_found`. `read` is gated on project trust: the gate admits it, and its ticket is spent here,
 * before anything is revealed. Every refusal is `INTEGRATIONS_REFUSAL_MESSAGE` with `details: { reason }`, or `E_CANCELLED`
 * or `E_INTERNAL` with a fixed text; every answer is checked against the response schema before it leaves.
 */
export interface IntegrationsHandlerDeps {
  readonly service: IntegrationsService;
  readonly journal: Pick<Journal, "getProject">;
  readonly gate: ProjectTrustGate;
  /** Monotonic milliseconds, for the trust ticket. */
  readonly now: () => number;
}

type Served = "list" | "status" | "read";

const fail = (reason: IntegrationReason): never => {
  const code = wireCode(reason);
  if (code === "E_CANCELLED") throw new DaemonError("E_CANCELLED", "The request was cancelled.");
  if (code === "E_INTERNAL") throw new DaemonError("E_INTERNAL", "Request failed");
  throw new DaemonError(code, INTEGRATIONS_REFUSAL_MESSAGE, { reason });
};

/**
 * A refusal keeps its reason; the project trust gate's refusal (`E_POLICY_DENIED` `untrusted`, which a handler may not raise) is
 * `E_CONFLICT` `untrusted`, as for the other gated handlers; anything else is internal.
 */
const settle = (e: unknown, signal: AbortSignal): never => {
  if (e instanceof IntegrationRefusal) return fail(e.reason);
  if (e instanceof AxisError && e.code === "E_POLICY_DENIED" && e.detail["reason"] === "untrusted") return fail("untrusted");
  return fail(signal.aborted ? "cancelled" : "internal");
};

export function createIntegrationsHandlers(deps: IntegrationsHandlerDeps): Readonly<Record<Served, Handler>> {
  const checked = <M extends Served>(method: M, body: (payload: never, context: HandlerContext) => Promise<unknown>): Handler =>
    async (context: HandlerContext, payload: never): Promise<unknown> => {
      if (context.signal.aborted) return fail("cancelled");
      if (context.identity.actor !== "user" || context.identity.clientKind !== "desktop") return fail("not_found");
      if (deps.journal.getProject((payload as { projectId: string }).projectId) === undefined) return fail("not_found");
      let out: unknown;
      try {
        out = await body(payload, context);
      } catch (e) {
        return settle(e, context.signal);
      }
      const ok = integrationsMethods[method].response.safeParse(out);
      return ok.success ? ok.data : fail("internal");
    };
  return {
    list: checked("list", async (p: { projectId: string }) => ({ integrations: await deps.service.list(p.projectId) })),
    status: checked("status", async (p: { projectId: string; integrationId: string }) => ({ integration: await deps.service.status(p.projectId, p.integrationId) })),
    read: projectGated(
      checked("read", async (p: { projectId: string; integrationId: string; operation: string; args?: Record<string, string | number | boolean> }, context) => {
        const ticket = await deps.gate.admit({ projectId: p.projectId, caller: trustCallOf(context.identity), signal: context.signal });
        consumeTicket(ticket, { projectId: p.projectId }, deps.now);
        return deps.service.read({ projectId: p.projectId, integrationId: p.integrationId, operation: p.operation, ...(p.args === undefined ? {} : { args: p.args }) }, context.signal);
      }),
    ),
  };
}

export function registerIntegrationsServing(registrar: HandlerRegistrar, deps: IntegrationsHandlerDeps): void {
  registrar.register(INTEGRATIONS_CONTRACT, INTEGRATIONS_VERSION, createIntegrationsHandlers(deps));
}
