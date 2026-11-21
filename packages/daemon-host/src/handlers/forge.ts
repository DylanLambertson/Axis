// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import { FORGE_CONTRACT, FORGE_VERSION, forgeMethods, type ForgeMethod, type ForgeRequest } from "@axis/protocol";
import { ForgeRefusal, type ForgeService } from "../forge/service.js";
import type { HandlerRegistrar } from "./anchor-guard.js";

/**
 * `axis.forge/1` over the bridge (ticket PV-D2, docs/design/forge-pr-list.md). The policy rows admit only `user`; every
 * handler refuses any other actor and a web client again. A refusal leaves with a fixed message and a closed reason; anything
 * else is `E_INTERNAL` with no text of its own, so nothing from a remote, a pull request or `gh` can reach an error. Every
 * answer is checked against the method's response schema before it leaves.
 */
export interface ForgeHandlerDeps {
  readonly service: ForgeService;
}

export const FORGE_REFUSAL_MESSAGE = "The forge request was refused.";

const fail = (code: "E_CANCELLED" | "E_INTERNAL" | "E_NOT_FOUND" | "E_CONFLICT", reason?: string): never => {
  throw new DaemonError(code, code === "E_CANCELLED" ? "The request was cancelled." : code === "E_INTERNAL" ? "Request failed" : FORGE_REFUSAL_MESSAGE, reason === undefined ? undefined : { reason });
};

export function toForgeError(e: unknown): never {
  if (e instanceof DaemonError) throw e;
  if (e instanceof ForgeRefusal) return e.reason === "not_found" ? fail("E_NOT_FOUND", "not_found") : fail("E_CONFLICT", "candidate_changed");
  return fail("E_INTERNAL");
}

export function createForgeHandlers(deps: ForgeHandlerDeps): Readonly<Record<ForgeMethod, Handler>> {
  const guarded =
    <M extends ForgeMethod>(method: M, call: (payload: ForgeRequest<M>) => Promise<unknown>): Handler =>
    async (context: HandlerContext, payload: never): Promise<unknown> => {
      if (context.signal.aborted) return fail("E_CANCELLED");
      if (context.identity.actor !== "user" || context.identity.clientKind !== "desktop") return fail("E_NOT_FOUND", "not_found");
      let out: unknown;
      try {
        out = await call(payload as ForgeRequest<M>);
      } catch (e) {
        return toForgeError(e);
      }
      const checked = forgeMethods[method].response.safeParse(out);
      if (!checked.success) return fail("E_INTERNAL");
      return checked.data;
    };
  return {
    pullRequests: guarded("pullRequests", (p) => deps.service.pullRequests(p.projectId, p.trigger)),
    pinRepository: guarded("pinRepository", (p) => deps.service.pinRepository(p.projectId, { host: p.host, owner: p.owner, repo: p.repo })),
  };
}

/** Register `axis.forge/1` through the host's registrar (slice 2, once the pty process serves `forge-list`). */
export function registerForgeHandlers(registrar: HandlerRegistrar, deps: ForgeHandlerDeps): void {
  registrar.register(FORGE_CONTRACT, FORGE_VERSION, createForgeHandlers(deps));
}
