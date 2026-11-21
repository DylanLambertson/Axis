// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import {
  MESSAGES_CONTRACT,
  MESSAGES_REFUSAL_MESSAGE,
  MESSAGES_VERSION,
  isMessagesRefusal,
  messagesMethods,
  type MessagesMethod,
  type MessagesRequest,
} from "@axis/protocol";
import { MessageRefusal, type MessageCaller } from "../messages/policy.js";
import type { MessageService } from "../messages/service.js";
import { InvalidMessageRequest } from "../messages/wire.js";
import type { MessagingSettingsService } from "../messages/settings.js";
import type { HandlerRegistrar } from "./anchor-guard.js";

/**
 * `axis.messages/1` over the bridge (ticket PV-M3; docs/design/messages-contract.md). The bridge serves the user's own
 * attested desktop connection only: the policy rows admit only `user`, and every handler refuses any other actor, and a
 * web client, again with the contract's `not_found` (agents reach messaging through the broker, PV-M4, and the CLI
 * endpoint, PV-M6, with their own attested callers). The caller handed to the service is built here from `ctx.identity`, never from the payload.
 *
 * Every refusal leaves as `{ code, MESSAGES_REFUSAL_MESSAGE, details: { reason } }` with a reason of the contract's closed
 * set under its code; anything else (a stored record that does not parse, a journal error) is `E_INTERNAL` with no
 * text of its own. Every answer is checked against the method's response schema before it leaves.
 */
export interface MessagesHandlerDeps {
  readonly service: MessageService;
  readonly settings: MessagingSettingsService;
}

const fail = (code: "E_CANCELLED" | "E_INTERNAL" | "E_NOT_FOUND" | "E_CONFLICT" | "E_INVALID_ARGUMENT" | "E_BACKPRESSURE", reason?: string): never => {
  throw new DaemonError(code, code === "E_CANCELLED" ? "The request was cancelled." : code === "E_INTERNAL" ? "Request failed" : MESSAGES_REFUSAL_MESSAGE, reason === undefined ? undefined : { reason });
};

/** A refusal to its wire error, or `E_INTERNAL` for anything outside the contract's closed set. */
export function toMessagesError(e: unknown): never {
  if (e instanceof DaemonError) throw e;
  if (e instanceof MessageRefusal && isMessagesRefusal(e.code, e.reason)) return fail(e.code as "E_NOT_FOUND", e.reason);
  if (e instanceof InvalidMessageRequest) return fail("E_INVALID_ARGUMENT");
  return fail("E_INTERNAL");
}

const USER: MessageCaller = Object.freeze({ kind: "user" });

export function createMessagesHandlers(deps: MessagesHandlerDeps): Readonly<Record<MessagesMethod, Handler>> {
  const guarded =
    <M extends MessagesMethod>(method: M, call: (caller: MessageCaller, payload: MessagesRequest<M>) => unknown): Handler =>
    async (context: HandlerContext, payload: never): Promise<unknown> => {
      if (context.signal.aborted) return fail("E_CANCELLED");
      // Defence in depth behind the policy row: only the user's own attested connection.
      // A web client is refused here too, not only by WEB_ALLOWED: one mistaken allow-list line must not expose threads.
      if (context.identity.actor !== "user" || context.identity.clientKind !== "desktop") return fail("E_NOT_FOUND", "not_found");
      let out: unknown;
      try {
        out = await call(USER, payload as MessagesRequest<M>);
      } catch (e) {
        return toMessagesError(e);
      }
      const checked = messagesMethods[method].response.safeParse(out);
      if (!checked.success) return fail("E_INTERNAL");
      return checked.data;
    };
  const { service, settings } = deps;
  return {
    send: guarded("send", (c, p) => service.send(c, p)),
    thread: guarded("thread", (c, p) => service.thread(c, p)),
    threads: guarded("threads", (c, p) => service.threads(c, p)),
    read: guarded("read", (c, p) => service.read(c, p)),
    markRead: guarded("markRead", (c, p) => service.markRead(c, p)),
    pause: guarded("pause", (c, p) => settings.pause(c, p)),
    resume: guarded("resume", (c, p) => settings.resume(c, p)),
    settings: guarded("settings", (c, p) => settings.settings(c, p)),
    updateSettings: guarded("updateSettings", (c, p) => settings.updateSettings(c, p)),
  };
}

/** Register `axis.messages/1` through the host's registrar (never the daemon itself). */
export function registerMessagesHandlers(registrar: HandlerRegistrar, deps: MessagesHandlerDeps): void {
  registrar.register(MESSAGES_CONTRACT, MESSAGES_VERSION, createMessagesHandlers(deps));
}
