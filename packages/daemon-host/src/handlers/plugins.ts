// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import type { PluginPermission, PluginState } from "@axis/journal";
import { PLUGINS_CONTRACT, PLUGINS_VERSION, pluginsMethods, type PluginsMethod, type PluginsRequest } from "@axis/protocol";
import type { ProjectMutex } from "../worktrees/project-mutex.js";
import type { HandlerRegistrar } from "./anchor-guard.js";

/**
 * `axis.plugins/1` (PV-K2 slice K2-g1, `docs/design/plugin-grant-contract.md` sections 2 and 4): `list`, `revoke` and `disable`.
 *
 * - **The user's alone.** The policy rows are user rows; a web client is outside `WEB_ALLOWED`, and a plugin is refused by the
 *   deny list (`axis.plugins/`). The handlers refuse every caller but the user's desktop connection too, with `E_NOT_FOUND`.
 * - **Decreases only.** `revoke` removes one permission and `disable` turns the plugin off; each bumps the generation (the v16
 *   triggers; a disable of a plugin already off changes nothing). Both run under the project mutex, the one every writer of the
 *   plugin rows takes, and then end that plugin's open challenges in the project at once (`endPlugin`), never another's.
 * - **The accepted availability risk** (section 2): any code in a renderer of the user's window can revoke or disable, and so
 *   withdraw the plugin's open approvals; getting them back takes a tier-4 grant or enable (K2-g2), which no renderer can do alone.
 */
export interface PluginsHandlerDeps {
  readonly journal: {
    getProject(id: string): unknown;
    readonly plugins: {
      list(projectId: string): Array<PluginState & { readonly pluginId: string }>;
      state(pluginId: string, projectId: string): PluginState | undefined;
      revoke(pluginId: string, projectId: string, permission: PluginPermission): boolean;
      setEnabled(pluginId: string, projectId: string, enabled: boolean): void;
    };
  };
  readonly mutex: Pick<ProjectMutex, "run">;
  /** Ends the plugin's open challenges in the project (`Approvals.endPlugin`). */
  readonly endPlugin: (pluginId: string, projectId: string) => unknown;
}

const NOT_FOUND = "That project or plugin was not found.";

function fail(code: "E_NOT_FOUND" | "E_CANCELLED" | "E_INTERNAL", message: string, reason?: string): never {
  throw new DaemonError(code, message, reason === undefined ? undefined : { reason });
}

const view = (pluginId: string, s: PluginState) => ({ pluginId, enabled: s.enabled, generation: s.generation, permissions: [...s.permissions].sort() });

export function createPluginsHandlers(deps: PluginsHandlerDeps): Readonly<Record<PluginsMethod, Handler>> {
  const guarded =
    <M extends PluginsMethod>(method: M, call: (req: PluginsRequest<M>, context: HandlerContext) => unknown): Handler =>
    async (context: HandlerContext, payload: never): Promise<unknown> => {
      if (context.signal.aborted) return fail("E_CANCELLED", "The request was cancelled.");
      // Defence in depth behind the policy rows: the user's desktop connection only.
      if (context.identity.actor !== "user" || context.identity.clientKind !== "desktop") return fail("E_NOT_FOUND", NOT_FOUND);
      const req = pluginsMethods[method].request.safeParse(payload);
      if (!req.success) return fail("E_NOT_FOUND", NOT_FOUND);
      const out = await call(req.data as PluginsRequest<M>, context);
      const checked = pluginsMethods[method].response.safeParse(out);
      if (!checked.success) return fail("E_INTERNAL", "The plugin list could not be read.");
      return checked.data;
    };
  const project = (projectId: string): void => {
    if (deps.journal.getProject(projectId) === undefined) fail("E_NOT_FOUND", NOT_FOUND);
  };
  // After a decrease, the plugin's open challenges in the project end at once. A failure there must not undo the write.
  const end = (pluginId: string, projectId: string): void => {
    try {
      deps.endPlugin(pluginId, projectId);
    } catch {
      // `endPlugin` never throws by contract; the challenges are refused lazily by their binding anyway.
    }
  };
  return Object.freeze({
    list: guarded("list", (req) => {
      project(req.projectId);
      return { plugins: deps.journal.plugins.list(req.projectId).map((p) => view(p.pluginId, p)) };
    }),
    revoke: guarded("revoke", (req, context) => {
      project(req.projectId);
      return deps.mutex.run(
        req.projectId,
        async () => {
          if (deps.journal.plugins.state(req.pluginId, req.projectId) === undefined) fail("E_NOT_FOUND", NOT_FOUND);
          if (!deps.journal.plugins.revoke(req.pluginId, req.projectId, req.permission as PluginPermission)) fail("E_NOT_FOUND", "That permission is not granted.", "not_granted");
          end(req.pluginId, req.projectId);
          return { plugin: view(req.pluginId, deps.journal.plugins.state(req.pluginId, req.projectId) as PluginState) };
        },
        context.signal,
      );
    }),
    disable: guarded("disable", (req, context) => {
      project(req.projectId);
      return deps.mutex.run(
        req.projectId,
        async () => {
          if (deps.journal.plugins.state(req.pluginId, req.projectId) === undefined) fail("E_NOT_FOUND", NOT_FOUND);
          deps.journal.plugins.setEnabled(req.pluginId, req.projectId, false);
          end(req.pluginId, req.projectId);
          return { plugin: view(req.pluginId, deps.journal.plugins.state(req.pluginId, req.projectId) as PluginState) };
        },
        context.signal,
      );
    }),
  });
}

/** Register `axis.plugins/1` through the host's registrar. */
export function registerPluginsHandlers(registrar: HandlerRegistrar, deps: PluginsHandlerDeps): void {
  registrar.register(PLUGINS_CONTRACT, PLUGINS_VERSION, createPluginsHandlers(deps));
}
