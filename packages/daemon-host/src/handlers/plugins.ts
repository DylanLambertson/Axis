// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import type { PluginPermission, PluginState } from "@axis/journal";
import { PLUGINS_CONTRACT, PLUGINS_VERSION, pluginsMethods, type PluginsMethod, type PluginsRequest } from "@axis/protocol";
import type { GrantAction } from "../plugins/grant-action.js";
import { createGrantContentHooks } from "../plugins/grant-content.js";
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
 * - **Increases at tier 4, switched off** (K2-g2). `grant` and `enable` run only inside a spent approval, after main's native
 *   confirmation, under the project mutex their content hook holds (`plugins/grant-content.ts`). Both refuse with `E_UNAVAILABLE`
 *   (`plugin_grants_off`) unless `grantsEnabled` (the host's `pluginGrants` option, off in production until K2-enable).
 * - **The accepted availability risk** (section 2): any code in a renderer of the user's window can revoke or disable, and so
 *   withdraw the plugin's open approvals; getting them back takes a tier-4 grant or enable (K2-g2), which no renderer can do alone.
 */
export interface PluginsHandlerDeps {
  readonly journal: {
    getProject(id: string): { readonly displayName: string } | undefined;
    readonly plugins: {
      list(projectId: string): Array<PluginState & { readonly pluginId: string }>;
      state(pluginId: string, projectId: string): PluginState | undefined;
      revoke(pluginId: string, projectId: string, permission: PluginPermission): boolean;
      /** Only ever called with `false` here: switching a plugin on goes through `grantAction`. */
      setEnabled(pluginId: string, projectId: string, enabled: false): void;
    };
  };
  readonly mutex: Pick<ProjectMutex, "run">;
  /** Ends the plugin's open challenges in the project (`Approvals.endPlugin`). */
  readonly endPlugin: (pluginId: string, projectId: string) => unknown;
  /**
   * The only way this handler writes an increase (K2-g3): the approved grant action, which holds the journal's mint. Absent,
   * `grant` and `enable` are refused like grants that are off.
   */
  readonly grantAction?: GrantAction;
  /** `grant` and `enable` are served only when this is true: the host's `pluginGrants` option (K2-enable turns it on). */
  readonly grantsEnabled?: boolean;
  /** Records a grant's or an enable's dialog line for (target, content digest): the approvals wiring's `onPreview`. */
  readonly onPreview?: (target: string, contentDigest: string, text: string) => void;
}

const NOT_FOUND = "That project or plugin was not found.";

function fail(code: "E_NOT_FOUND" | "E_CANCELLED" | "E_INTERNAL" | "E_CONFLICT" | "E_UNAVAILABLE", message: string, reason?: string): never {
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
    grant: guarded("grant", (req, context) => {
      // Only inside a spent approval (tier 4, native confirmation); the content hook holds the project mutex around this call.
      if (deps.grantsEnabled !== true || deps.grantAction === undefined) fail("E_UNAVAILABLE", "Plugin grants are not available.", "plugin_grants_off");
      if (context.approved === undefined) fail("E_NOT_FOUND", NOT_FOUND);
      project(req.projectId);
      return deps.mutex.run(
        req.projectId,
        async () => {
          const now = deps.journal.plugins.state(req.pluginId, req.projectId);
          if (now === undefined) fail("E_NOT_FOUND", NOT_FOUND);
          if ((now as PluginState).permissions.includes(req.permission as PluginPermission)) fail("E_CONFLICT", "That permission is already granted.", "already_granted");
          (deps.grantAction as GrantAction).grant(req.pluginId, req.projectId, req.permission as PluginPermission);
          return { plugin: view(req.pluginId, deps.journal.plugins.state(req.pluginId, req.projectId) as PluginState) };
        },
        context.signal,
      );
    }),
    enable: guarded("enable", (req, context) => {
      if (deps.grantsEnabled !== true || deps.grantAction === undefined) fail("E_UNAVAILABLE", "Plugin grants are not available.", "plugin_grants_off");
      if (context.approved === undefined) fail("E_NOT_FOUND", NOT_FOUND);
      project(req.projectId);
      return deps.mutex.run(
        req.projectId,
        async () => {
          const now = deps.journal.plugins.state(req.pluginId, req.projectId);
          if (now === undefined) fail("E_NOT_FOUND", NOT_FOUND);
          if ((now as PluginState).enabled) fail("E_CONFLICT", "That plugin is already on.", "already_enabled");
          (deps.grantAction as GrantAction).enable(req.pluginId, req.projectId);
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

/** Register `axis.plugins/1` through the host's registrar, with the content hooks of `grant` and `enable` (K2-g2). */
export function registerPluginsHandlers(registrar: HandlerRegistrar, deps: PluginsHandlerDeps): void {
  const content = createGrantContentHooks({ journal: deps.journal, mutex: deps.mutex, onPreview: deps.onPreview ?? (() => undefined), grantsEnabled: deps.grantsEnabled === true });
  registrar.register(PLUGINS_CONTRACT, PLUGINS_VERSION, createPluginsHandlers(deps), { content });
}
