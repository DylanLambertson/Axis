// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import { PAGES_CONTRACT, PAGES_REFUSAL_MESSAGE, PAGES_VERSION, pagesMethods, type PagesMethod, type PagesRequest } from "@axis/protocol";
import { PagesRefusal, type PageCaller, type PagesService } from "../pages/service.js";
import type { HandlerRegistrar } from "./anchor-guard.js";

/**
 * `axis.pages/1` over the bridge (ticket PV-Q1 slice 2, ADR 0010, docs/design/pages-store.md §5). The user's own attested
 * desktop connection only: the rows admit only `user`, and every handler refuses any other actor and a web client again
 * with `not_found`. The caller is built here from `ctx.identity`, never from the payload. `markReviewed` and `delete` are
 * tier 4: the daemon's pipeline has the challenge confirmed in main's native dialog (with its proof) before the handler
 * runs, so a renderer request and its own `resolve` never mark a version reviewed or delete a page (threat-model-phase2a
 * O-4). Tier 3 would not do: its challenge is released by `resolve` alone.
 *
 * Every refusal leaves as `{ code, PAGES_REFUSAL_MESSAGE, details: { reason } }` of the contract's closed set; anything else
 * (a store reason the contract does not have, a database error) is `E_INTERNAL` with no text of its own. Every answer is
 * checked against the method's response schema before it leaves.
 */
const fail = (code: "E_CANCELLED" | "E_INTERNAL" | "E_NOT_FOUND" | "E_CONFLICT" | "E_INVALID_ARGUMENT", reason?: string): never => {
  throw new DaemonError(code, code === "E_CANCELLED" ? "The request was cancelled." : code === "E_INTERNAL" ? "Request failed" : PAGES_REFUSAL_MESSAGE, reason === undefined ? undefined : { reason });
};

export function toPagesError(e: unknown): never {
  if (e instanceof DaemonError) throw e;
  if (e instanceof PagesRefusal) return fail(e.code as "E_NOT_FOUND", e.reason);
  return fail("E_INTERNAL");
}

const USER: PageCaller = Object.freeze({ kind: "user" });

export function createPagesHandlers(service: PagesService): Readonly<Record<PagesMethod, Handler>> {
  const guarded =
    <M extends PagesMethod>(method: M, call: (payload: PagesRequest<M>) => unknown): Handler =>
    async (context: HandlerContext, payload: never): Promise<unknown> => {
      if (context.signal.aborted) return fail("E_CANCELLED");
      if (context.identity.actor !== "user" || context.identity.clientKind !== "desktop") return fail("E_NOT_FOUND", "not_found");
      let out: unknown;
      try {
        out = call(payload as PagesRequest<M>);
      } catch (e) {
        return toPagesError(e);
      }
      const checked = pagesMethods[method].response.safeParse(out);
      if (!checked.success) return fail("E_INTERNAL");
      return checked.data;
    };
  return {
    list: guarded("list", (p) => service.list(p)),
    get: guarded("get", (p) => service.get(p)),
    versions: guarded("versions", (p) => service.versions(p)),
    create: guarded("create", (p) => service.create(USER, p)),
    update: guarded("update", (p) => service.update(USER, p)),
    restore: guarded("restore", (p) => service.restore(p)),
    markReviewed: guarded("markReviewed", (p) => service.markReviewed(p)),
    delete: guarded("delete", (p) => service.delete(p)),
  };
}

/** Register `axis.pages/1` through the host's registrar (never the daemon itself). */
export function registerPagesHandlers(registrar: HandlerRegistrar, service: PagesService): void {
  registrar.register(PAGES_CONTRACT, PAGES_VERSION, createPagesHandlers(service));
}
