// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import { FORGE_CONTRACT, FORGE_REFUSAL_MESSAGE, FORGE_REFUSALS, FORGE_VERSION, forgeMethods, isForgeRefusal, type ForgeMethod, type ForgeRequest } from "@axis/protocol";
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

const fail = (code: "E_CANCELLED" | "E_INTERNAL" | keyof typeof FORGE_REFUSALS, reason?: string): never => {
  throw new DaemonError(code, code === "E_CANCELLED" ? "The request was cancelled." : code === "E_INTERNAL" ? "Request failed" : FORGE_REFUSAL_MESSAGE, reason === undefined ? undefined : { reason });
};

export function toForgeError(e: unknown): never {
  if (e instanceof DaemonError) throw e;
  if (e instanceof ForgeRefusal) {
    // The code comes from the protocol's closed table; a reason outside it is an internal error, never sent.
    const code = (Object.keys(FORGE_REFUSALS) as (keyof typeof FORGE_REFUSALS)[]).find((c) => isForgeRefusal(c, e.reason));
    return code === undefined ? fail("E_INTERNAL") : fail(code, e.reason);
  }
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
