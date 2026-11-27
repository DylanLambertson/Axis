// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import { DaemonError, type ApprovalContentHook, type ApprovalContentLock, type HandlerContext } from "@axis/daemon";
import { MESSAGES_REFUSAL_MESSAGE, messagesMethods } from "@axis/protocol";
import type { ProjectMutex } from "../worktrees/project-mutex.js";

/**
 * The content hook of `axis.messages/1.enableCliEndpoint` (PV-M7 slice 2, `docs/design/axis-messages-shim.md` section 7): what
 * main's native dialog shows and what the approval is bound to.
 *
 * - **Refused before any challenge** on Windows (`E_UNAVAILABLE`, `endpoint_unavailable`: no endpoint exists there in 2a) and
 *   when the switch is already on (`E_CONFLICT`, `already_enabled`). No dialog is shown for either.
 * - **Bound to the switch's state.** The digest is the SHA-256 of `["axis.cli-endpoint/1", "enable", enabled]`, read under the
 *   switch mutex, which the disable takes too. At the spend the state is read again under the same hold: if it was switched on
 *   in between, the digest differs and the spend is refused; the handler's write runs inside that hold.
 * - **The dialog line** is fixed words (no daemon or user text), so nothing can be smuggled into main's dialog.
 */
export const CLI_ENDPOINT_TARGET = "messaging:cli_endpoint";
/** The key of the switch's own mutex: every writer of the switch (the enable's spend and the disable) holds it. */
export const CLI_ENDPOINT_LOCK = "messaging:cli_endpoint";
/** Main's native dialog line, verbatim (at most 80 units, the dialog's detail bound). */
export const CLI_ENDPOINT_LINE = "let command-line coding tools message your workers (marked unverified)";
const TAG = "axis.cli-endpoint/1";

export interface CliEndpointContentDeps {
  readonly enabled: () => boolean;
  readonly mutex: Pick<ProjectMutex, "run">;
  /** Records the dialog line for (target, content digest): the approvals wiring's `onPreview`. */
  readonly onPreview: (target: string, contentDigest: string, text: string) => void;
  readonly platform: NodeJS.Platform;
}

const refuse = (code: "E_UNAVAILABLE" | "E_CONFLICT" | "E_INVALID_ARGUMENT", reason?: string): never => {
  throw new DaemonError(code, MESSAGES_REFUSAL_MESSAGE, reason === undefined ? undefined : { reason });
};

/** The content digest of turning the switch on, over its state now. */
export function cliEndpointDigest(enabled: boolean): string {
  if (typeof enabled !== "boolean") throw new TypeError("cli endpoint digest: not a boolean");
  return createHash("sha256").update(JSON.stringify([TAG, "enable", enabled]), "utf8").digest("hex");
}

export function createCliEndpointContentHook(deps: CliEndpointContentDeps): ApprovalContentHook {
  return ((context: Pick<HandlerContext, "signal">, payload: unknown): ApprovalContentLock => {
    if (deps.platform === "win32") refuse("E_UNAVAILABLE", "endpoint_unavailable");
    if (!messagesMethods.enableCliEndpoint.request.safeParse(payload).success) refuse("E_INVALID_ARGUMENT");
    if (deps.enabled()) refuse("E_CONFLICT", "already_enabled");
    return {
      target: CLI_ENDPOINT_TARGET,
      // The state is read and the digest computed only once the mutex is held (no check-then-act gap).
      withLock: (fn) =>
        deps.mutex.run(
          CLI_ENDPOINT_LOCK,
          async () => {
            const now = deps.enabled();
            if (now) return refuse("E_CONFLICT", "already_enabled");
            const digest = cliEndpointDigest(now);
            deps.onPreview(CLI_ENDPOINT_TARGET, digest, CLI_ENDPOINT_LINE);
            return fn(digest);
          },
          context.signal,
        ),
    };
  }) as unknown as ApprovalContentHook;
}
