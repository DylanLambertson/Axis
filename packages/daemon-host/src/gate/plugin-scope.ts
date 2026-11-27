// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * The scope a plugin call may act in (ADR 0008 decision 6, "Scope is forced, not trusted"; ticket PV-K1c). A plugin connection is
 * attested with the project it is enabled in (`identity.workspaceId`); every plugin handler takes its project from there. A request
 * that names no project gets the plugin's; one that names the plugin's own project, or a workspace of it, passes; anything else is
 * refused with one closed reason that never echoes the requested id. A window or web identity is not a plugin's and passes as asked.
 * No plugin row exists until PV-K1b, which applies this in every plugin handler.
 */

export type ForcedScope = { readonly ok: true; readonly projectId?: string; readonly workspaceId?: string } | { readonly ok: false; readonly reason: "out_of_scope" };

const OUT: ForcedScope = Object.freeze({ ok: false, reason: "out_of_scope" });

export function forcedScope(
  identity: { readonly clientKind: string; readonly workspaceId?: string },
  requested: { readonly projectId?: string; readonly workspaceId?: string },
  projectOfWorkspace: (workspaceId: string) => string | undefined,
): ForcedScope {
  if (identity.clientKind !== "plugin") return { ok: true, ...requested };
  const pinned = identity.workspaceId;
  if (typeof pinned !== "string" || pinned === "") return OUT;
  if (requested.projectId !== undefined && requested.projectId !== pinned) return OUT;
  if (requested.workspaceId !== undefined) {
    let owner: string | undefined;
    try {
      owner = projectOfWorkspace(requested.workspaceId);
    } catch {
      return OUT;
    }
    if (owner !== pinned) return OUT;
    return { ok: true, projectId: pinned, workspaceId: requested.workspaceId };
  }
  return { ok: true, projectId: pinned };
}
