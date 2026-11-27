// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError, type ApprovalContentHook, type Handler, type HandlerContext } from "@axis/daemon";
import type { CliEndpointSwitchRecords } from "@axis/journal";
import { MESSAGES_REFUSAL_MESSAGE, messagesMethods } from "@axis/protocol";
import type { CliEndpointSwitchAction } from "../messages/cli-endpoint-action.js";
import { CLI_ENDPOINT_LOCK, CLI_ENDPOINT_TARGET, createCliEndpointContentHook } from "../messages/cli-endpoint-content.js";
import type { ProjectMutex } from "../worktrees/project-mutex.js";

/**
 * `axis.messages/1.enableCliEndpoint` and `disableCliEndpoint` (PV-M7 slice 2, `docs/design/axis-messages-shim.md` section 7):
 * the user's one global switch for CLI messaging endpoints.
 *
 * - **The user's desktop connection only.** The policy rows are user rows, neither method is in `WEB_ALLOWED`, both are on the
 *   plugin deny list, and these handlers refuse every other caller again with `not_found`.
 * - **On:** tier 4, only inside a spent approval for this target (main's native confirmation; `cli-endpoint-content.ts`), through
 *   the approved enable action, the one holder of the journal's switch mint. The write runs inside the content hook's hold.
 * - **Off:** tier 1, at once, under the same mutex; no token (a decrease). After the write, every live endpoint is revoked at
 *   once (`onChanged`); and the relay reads the switch at every mint and every relayed message, so none serves after it is off.
 *
 * What the switch turns on is exactly the CLI endpoint path: its relay, its own run-to-worker lookup and minting for an enabled
 * CLI worker. It turns on nothing else: delivery into runs and the composer's message tools stay with `messaging.enabled`.
 */
export interface CliEndpointSwitchDeps {
  readonly action: CliEndpointSwitchAction;
  readonly store: Pick<CliEndpointSwitchRecords, "enabled" | "switchOff">;
  readonly mutex: Pick<ProjectMutex, "run">;
  readonly platform: NodeJS.Platform;
  readonly onPreview?: (target: string, contentDigest: string, text: string) => void;
  /** After a committed change: the live wiring turns on (the next CLI run gets an endpoint) or off (every endpoint revoked). */
  readonly onChanged?: (enabled: boolean) => void;
}

/** Tell the live wiring; its failure never undoes the committed change (the relay reads the switch at every mint and message). */
function changed(deps: CliEndpointSwitchDeps, enabled: boolean): void {
  try {
    deps.onChanged?.(enabled);
  } catch {
    // The backstop holds: nothing is minted while off, and every endpoint is revoked at its next message.
  }
}

type SwitchMethod = "enableCliEndpoint" | "disableCliEndpoint";

const fail = (code: "E_CANCELLED" | "E_NOT_FOUND" | "E_INVALID_ARGUMENT" | "E_UNAVAILABLE" | "E_INTERNAL", reason?: string): never => {
  throw new DaemonError(code, code === "E_CANCELLED" ? "The request was cancelled." : code === "E_INTERNAL" ? "Request failed" : MESSAGES_REFUSAL_MESSAGE, reason === undefined ? undefined : { reason });
};

function guarded(method: SwitchMethod, call: (context: HandlerContext) => Promise<unknown>): Handler {
  return async (context: HandlerContext, payload: never): Promise<unknown> => {
    if (context.signal.aborted) return fail("E_CANCELLED");
    // Defence in depth behind the policy rows: only the user's own attested desktop connection.
    if (context.identity.actor !== "user" || context.identity.clientKind !== "desktop") return fail("E_NOT_FOUND", "not_found");
    if (!messagesMethods[method].request.safeParse(payload).success) return fail("E_INVALID_ARGUMENT");
    const out = await call(context);
    const checked = messagesMethods[method].response.safeParse(out);
    if (!checked.success) return fail("E_INTERNAL");
    return checked.data;
  };
}

/** The two handlers; with no switch (`deps` undefined) both refuse `endpoint_unavailable`. */
export function createCliEndpointSwitchHandlers(deps: CliEndpointSwitchDeps | undefined): Readonly<Record<SwitchMethod, Handler>> {
  return Object.freeze({
    enableCliEndpoint: guarded("enableCliEndpoint", async (context) => {
      if (deps === undefined || deps.platform === "win32") return fail("E_UNAVAILABLE", "endpoint_unavailable");
      // Only inside a spent approval for this target: the content hook holds the switch mutex around this call.
      if (context.approved?.target !== CLI_ENDPOINT_TARGET) return fail("E_NOT_FOUND", "not_found");
      const out = { enabled: true, changed: deps.action.switchOn().changed };
      changed(deps, true);
      return out;
    }),
    disableCliEndpoint: guarded("disableCliEndpoint", async (context) => {
      if (deps === undefined) return fail("E_UNAVAILABLE", "endpoint_unavailable");
      return deps.mutex.run(
        CLI_ENDPOINT_LOCK,
        async () => {
          const out = { enabled: false, changed: deps.store.switchOff().changed };
          changed(deps, false);
          return out;
        },
        context.signal,
      );
    }),
  });
}

/** The enable's content hook; with no switch, a hook that refuses before any challenge. */
export function createCliEndpointSwitchContent(deps: CliEndpointSwitchDeps | undefined): { readonly enableCliEndpoint: ApprovalContentHook } {
  const off = { enabled: () => false, mutex: { run: <T>(_k: string, fn: () => Promise<T>): Promise<T> => fn() }, onPreview: () => undefined, platform: "win32" as NodeJS.Platform };
  const d = deps === undefined ? off : { enabled: () => deps.store.enabled(), mutex: deps.mutex, onPreview: deps.onPreview ?? (() => undefined), platform: deps.platform };
  return { enableCliEndpoint: createCliEndpointContentHook(d) };
}
