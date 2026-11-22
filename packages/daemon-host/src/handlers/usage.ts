// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import { USAGE_CONTRACT, USAGE_REFUSAL_MESSAGE, USAGE_VERSION, usageMethods, type UsageMethod } from "@axis/protocol";
import { UsageRefusal, createUsageService, type UsageService, type UsageServiceDeps } from "../usage/service.js";
import type { HandlerRegistrar } from "./anchor-guard.js";

/**
 * `axis.usage/1` over the bridge (ticket PV-D3). The policy row admits only `user` (not web), so the daemon refuses any other
 * caller before the handler with `E_POLICY_DENIED`, a decision that does not depend on the project id. An unregistered project
 * is `E_NOT_FOUND` (reason `not_found`, fixed text); the handler re-checks the caller and answers a refused one `E_NOT_FOUND`
 * too, as defence in depth. Anything else,
 * a total the journal refuses as out of range included, is `E_INTERNAL` with no text of its own; every answer is checked
 * against the response schema before it leaves.
 */
const fail = (code: "E_CANCELLED" | "E_INTERNAL" | "E_NOT_FOUND"): never => {
  throw new DaemonError(
    code,
    code === "E_CANCELLED" ? "The request was cancelled." : code === "E_INTERNAL" ? "Request failed" : USAGE_REFUSAL_MESSAGE,
    code === "E_NOT_FOUND" ? { reason: "not_found" } : undefined,
  );
};

export function createUsageHandlers(service: UsageService): Readonly<Record<UsageMethod, Handler>> {
  return {
    summary: async (context: HandlerContext, payload: never): Promise<unknown> => {
      if (context.signal.aborted) return fail("E_CANCELLED");
      if (context.identity.actor !== "user" || context.identity.clientKind !== "desktop") return fail("E_NOT_FOUND");
      let out: unknown;
      try {
        out = service.summary((payload as { projectId: string }).projectId);
      } catch (e) {
        return fail(e instanceof UsageRefusal ? "E_NOT_FOUND" : "E_INTERNAL");
      }
      const checked = usageMethods.summary.response.safeParse(out);
      return checked.success ? checked.data : fail("E_INTERNAL");
    },
  };
}

/** Build the service over the journal and the composer's workspace budget limits, and register `axis.usage/1`. */
export function registerUsageServing(registrar: HandlerRegistrar, deps: UsageServiceDeps): void {
  registrar.register(USAGE_CONTRACT, USAGE_VERSION, createUsageHandlers(createUsageService(deps)));
}
