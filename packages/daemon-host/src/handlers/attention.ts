// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import { ATTENTION_CONTRACT, ATTENTION_REFUSAL_MESSAGE, ATTENTION_VERSION, attentionMethods, type AttentionMethod } from "@axis/protocol";
import { AttentionRefusal, createAttentionService, type AttentionService, type AttentionServiceDeps } from "../attention/service.js";
import type { HandlerRegistrar } from "./anchor-guard.js";

/**
 * `axis.attention/1` over the bridge (ticket PV-D4). The policy row admits only `user`; the handler refuses any other actor
 * and a web client again, with the same answer as an unknown project (`E_NOT_FOUND`, reason `not_found`, fixed text), so
 * nothing shows which projects exist. Anything else is `E_INTERNAL` with no text of its own, and every answer is checked
 * against the response schema before it leaves.
 */
const fail = (code: "E_CANCELLED" | "E_INTERNAL" | "E_NOT_FOUND"): never => {
  throw new DaemonError(
    code,
    code === "E_CANCELLED" ? "The request was cancelled." : code === "E_INTERNAL" ? "Request failed" : ATTENTION_REFUSAL_MESSAGE,
    code === "E_NOT_FOUND" ? { reason: "not_found" } : undefined,
  );
};

export function createAttentionHandlers(service: AttentionService): Readonly<Record<AttentionMethod, Handler>> {
  return {
    summary: async (context: HandlerContext, payload: never): Promise<unknown> => {
      if (context.signal.aborted) return fail("E_CANCELLED");
      if (context.identity.actor !== "user" || context.identity.clientKind !== "desktop") return fail("E_NOT_FOUND");
      let out: unknown;
      try {
        out = service.summary((payload as { projectId: string }).projectId);
      } catch (e) {
        return fail(e instanceof AttentionRefusal ? "E_NOT_FOUND" : "E_INTERNAL");
      }
      const checked = attentionMethods.summary.response.safeParse(out);
      return checked.success ? checked.data : fail("E_INTERNAL");
    },
  };
}

/** Build the service over the journal and the live run services, and register `axis.attention/1` (the composition's one call). */
export function registerAttentionServing(registrar: HandlerRegistrar, deps: AttentionServiceDeps): void {
  registrar.register(ATTENTION_CONTRACT, ATTENTION_VERSION, createAttentionHandlers(createAttentionService(deps)));
}
