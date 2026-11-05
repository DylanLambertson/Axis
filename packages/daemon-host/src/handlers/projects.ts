// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import { MAX_PROJECTS, projectsListResponseSchema, type ProjectInfo } from "@axis/protocol";

/**
 * `axis.projects/1.list` (design section 4.2): read only, tier 0. A project is registered by main over the control channel
 * (`projects.register`), never by a request, so this contract has no write method. It answers ids, display names and trust
 * only, never a path, and checks its own answer against the protocol schema: a reply that fails it is an internal error.
 */
export interface ProjectsHandlerDeps {
  readonly projects: () => readonly { readonly id: string; readonly displayName: string; readonly trusted: boolean }[];
}

const fail = (code: "E_CANCELLED" | "E_INTERNAL" | "E_NOT_FOUND", message: string): never => {
  throw new DaemonError(code, message);
};

export function createProjectsListHandler(deps: ProjectsHandlerDeps): Handler {
  return (context: HandlerContext) => {
    if (context.signal.aborted) return fail("E_CANCELLED", "The request was cancelled.");
    // Defence in depth behind the policy row: only the user's own attested connection lists projects.
    if (context.identity.actor !== "user") return fail("E_NOT_FOUND", "This project list is not available.");
    let rows: ProjectInfo[];
    try {
      const sources = deps.projects();
      if (sources.length > MAX_PROJECTS) return fail("E_INTERNAL", "The project list is unavailable.");
      rows = sources.map((p) => ({ id: p.id, name: p.displayName, trusted: p.trusted }));
    } catch {
      return fail("E_INTERNAL", "The project list is unavailable.");
    }
    const answer = projectsListResponseSchema.safeParse({ projects: rows });
    if (!answer.success) return fail("E_INTERNAL", "The project list is unavailable.");
    return answer.data;
  };
}

export function createProjectsHandlers(deps: ProjectsHandlerDeps): { readonly list: Handler } {
  return { list: createProjectsListHandler(deps) };
}
