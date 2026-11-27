// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { DaemonError, type ApprovalContentHook, type ApprovalContentLock, type HandlerContext } from "@axis/daemon";
import type { PluginPermission, PluginState } from "@axis/journal";
import { pluginsMethods } from "@axis/protocol";
import type { ProjectMutex } from "../worktrees/project-mutex.js";
import { DialogOverflow, ENABLE_WORDING, GRANT_WORDING, grantLine, isDangerous } from "./grant-line.js";

/**
 * The content hooks of `axis.plugins/1.grant` and `enable` (PV-K2 K2-g2, `docs/design/plugin-grant-contract.md` section 3).
 *
 * - **Off until K2-enable.** With `grantsEnabled` false (the production default, `ComposeOptions.pluginGrants`), the hook refuses
 *   before any challenge exists: `E_UNAVAILABLE`, reason `plugin_grants_off`. No dialog is ever shown.
 * - **Bound to the whole state.** The content digest is the SHA-256 of a versioned tuple of fixed shape, its members type-checked:
 *   `["axis.plugin-grant/1", method, pluginId, projectId, permission or null, generation, enabled, sorted permissions]`. A revoke,
 *   a disable, another grant or an enable between the dialog and the spend changes it, and the spend is refused.
 * - **The lock.** `withLock` takes the project mutex, then reads the state and computes the digest, then runs the step inside it.
 *   At issue that step only checks the digest, so the mutex is released before the user answers. At the spend it is the whole
 *   approval action: the comparison, the spend, the daemon's audit hand-off and the handler's write, under one hold that every
 *   writer of the plugin rows also takes.
 * - **The dialog line** is section 3.1's (`grant-line.ts`), built under the mutex from the state read there: the wording first,
 *   never cut; a line that cannot fit is refused at issue.
 */
export interface GrantContentDeps {
  readonly journal: {
    getProject(id: string): { readonly displayName: string } | undefined;
    readonly plugins: { state(pluginId: string, projectId: string): PluginState | undefined };
  };
  readonly mutex: Pick<ProjectMutex, "run">;
  /** Records the dialog line for (target, content digest): the approvals wiring's `onPreview`. */
  readonly onPreview: (target: string, contentDigest: string, text: string) => void;
  readonly grantsEnabled: boolean;
}

export type GrantMethod = "grant" | "enable";

/**
 * The digest the approval in progress was spent on (audit A, L1). The daemon runs the spend and then the handler inside the hook's
 * `withLock`, so the handler reads it here and compares it with the live state right before it writes: a revoke or a disable,
 * which no longer waits for the project mutex, then always wins over an increase approved before it.
 */
const spent = new AsyncLocalStorage<string>();
export function spentGrantDigest(): string | undefined {
  return spent.getStore();
}
const TAG = "axis.plugin-grant/1";

const refuse = (code: "E_UNAVAILABLE" | "E_NOT_FOUND" | "E_CONFLICT" | "E_INVALID_ARGUMENT", reason?: string): never => {
  throw new DaemonError(code, code === "E_NOT_FOUND" ? "Not found" : "Refused", reason === undefined ? undefined : { reason });
};

/** The content digest of a grant or an enable over the plugin's whole state. Throws on any member of the wrong type. */
export function grantDigest(method: GrantMethod, pluginId: string, projectId: string, permission: string | null, state: PluginState): string {
  const perms = [...state.permissions];
  const ok =
    (method === "grant" || method === "enable") &&
    typeof pluginId === "string" &&
    typeof projectId === "string" &&
    (permission === null || typeof permission === "string") &&
    Number.isSafeInteger(state.generation) &&
    state.generation >= 1 &&
    typeof state.enabled === "boolean" &&
    perms.every((p) => typeof p === "string");
  if (!ok) throw new TypeError("grant digest: a member of the wrong type");
  const tuple = [TAG, method, pluginId, projectId, permission, state.generation, state.enabled, perms.sort()];
  return createHash("sha256").update(JSON.stringify(tuple), "utf8").digest("hex");
}

export function createGrantContentHooks(deps: GrantContentDeps): { readonly grant: ApprovalContentHook; readonly enable: ApprovalContentHook } {
  const hook = (method: GrantMethod): ApprovalContentHook =>
    ((context: Pick<HandlerContext, "signal">, payload: unknown): ApprovalContentLock => {
      if (!deps.grantsEnabled) refuse("E_UNAVAILABLE", "plugin_grants_off");
      const req = pluginsMethods[method].request.safeParse(payload);
      if (!req.success) return refuse("E_INVALID_ARGUMENT");
      const { projectId, pluginId } = req.data;
      const permission = method === "grant" ? (req.data as unknown as { permission: PluginPermission }).permission : null;
      const now = deps.journal.plugins.state(pluginId, projectId);
      if (deps.journal.getProject(projectId) === undefined || now === undefined) return refuse("E_NOT_FOUND");
      if (permission !== null && now.permissions.includes(permission)) refuse("E_CONFLICT", "already_granted");
      if (method === "enable" && now.enabled) refuse("E_CONFLICT", "already_enabled");
      const target = `plugin:${projectId}/${pluginId}`;
      return {
        target,
        // The state is read and the digest computed only once the mutex is held: never before it (no check-then-act gap).
        withLock: (fn) =>
          deps.mutex.run(
            projectId,
            async () => {
              const state = deps.journal.plugins.state(pluginId, projectId);
              const shown = deps.journal.getProject(projectId);
              if (state === undefined || shown === undefined) return refuse("E_NOT_FOUND");
              const digest = grantDigest(method, pluginId, projectId, permission, state);
              // The dialog line, the danger marker included, is built from the state read under the mutex (review K2-g2 N3).
              let line: string;
              try {
                line = grantLine({
                  wording: permission === null ? ENABLE_WORDING : GRANT_WORDING[permission],
                  dangerous: permission !== null && isDangerous([...state.permissions, permission]),
                  pluginId,
                  projectName: shown.displayName,
                });
              } catch (e) {
                if (e instanceof DialogOverflow) return refuse("E_INVALID_ARGUMENT", "dialog_overflow");
                throw e;
              }
              deps.onPreview(target, digest, line);
              return spent.run(digest, () => fn(digest));
            },
            context.signal,
          ),
      };
    }) as unknown as ApprovalContentHook;
  return { grant: hook("grant"), enable: hook("enable") };
}
