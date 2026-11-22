// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import {
  AGENT_GROUPS_CONTRACT,
  AGENT_GROUPS_VERSION,
  AGENTS_CONTRACT,
  AGENTS_REFUSAL_MESSAGE,
  AGENTS_VERSION,
  agentGroupsMethods,
  agentsMethods,
  isAgentsRefusal,
  type AgentGroupsMethod,
  type AgentsMethod,
} from "@axis/protocol";
import { AgentRefusal, createAgentsService, type AgentsCaller, type AgentsService, type AgentsServiceDeps } from "../agents/service.js";
import type { HandlerRegistrar } from "./anchor-guard.js";

/**
 * `axis.agents/1` and `axis.agent-groups/1` over the bridge (ticket PV-G3; docs/design/agents-contract.md). Only the user's
 * own attested desktop connection reaches them: the policy rows admit only `user`, and every handler refuses any other
 * actor, and a web client, again with `not_found` (no agent, plugin or message creates, changes or groups an agent).
 * Every refusal leaves as `{ code, AGENTS_REFUSAL_MESSAGE, details: { reason } }` with a reason of the contract's closed set;
 * anything else is `E_INTERNAL` with no text of its own, and every answer is checked against the response schema.
 */
const fail = (code: "E_CANCELLED" | "E_INTERNAL" | "E_NOT_FOUND" | "E_CONFLICT", reason?: string): never => {
  throw new DaemonError(code, code === "E_CANCELLED" ? "The request was cancelled." : code === "E_INTERNAL" ? "Request failed" : AGENTS_REFUSAL_MESSAGE, reason === undefined ? undefined : { reason });
};

export function toAgentsError(e: unknown): never {
  if (e instanceof DaemonError && e.code === "E_CANCELLED") throw e;
  if (e instanceof AgentRefusal && isAgentsRefusal(e.code, e.reason)) return fail(e.code, e.reason);
  return fail("E_INTERNAL");
}

function callerOf(context: HandlerContext): AgentsCaller {
  const { identity, signal } = context;
  return {
    ctx: { caller: { actor: identity.actor, connectionId: identity.connectionId, windowId: identity.windowId }, signal },
    trusted: identity.trusted === true,
    windowId: identity.windowId,
    ...(identity.workspaceId === undefined ? {} : { workspaceId: identity.workspaceId }),
  };
}

function guard(schema: { safeParse(v: unknown): { success: boolean; data?: unknown } }, call: (caller: AgentsCaller, payload: never) => Promise<unknown>): Handler {
  return async (context: HandlerContext, payload: never): Promise<unknown> => {
    if (context.signal.aborted) return fail("E_CANCELLED");
    // Defence in depth behind the policy rows: the user's own attested desktop connection only.
    if (context.identity.actor !== "user" || context.identity.clientKind !== "desktop") return fail("E_NOT_FOUND", "not_found");
    let out: unknown;
    try {
      out = await call(callerOf(context), payload);
    } catch (e) {
      return toAgentsError(e);
    }
    const checked = schema.safeParse(out);
    if (!checked.success) return fail("E_INTERNAL");
    return checked.data;
  };
}

export function createAgentsHandlers(service: AgentsService): { agents: Readonly<Record<AgentsMethod, Handler>>; groups: Readonly<Record<AgentGroupsMethod, Handler>> } {
  const a = service.agents;
  const g = service.groups;
  const am = agentsMethods;
  const gm = agentGroupsMethods;
  return {
    agents: {
      list: guard(am.list.response, a.list),
      get: guard(am.get.response, a.get),
      create: guard(am.create.response, a.create),
      update: guard(am.update.response, a.update),
      archive: guard(am.archive.response, a.archive),
      restore: guard(am.restore.response, a.restore),
    },
    groups: {
      list: guard(gm.list.response, g.list),
      create: guard(gm.create.response, g.create),
      rename: guard(gm.rename.response, g.rename),
      reorder: guard(gm.reorder.response, g.reorder),
      delete: guard(gm.delete.response, g.delete),
      assign: guard(gm.assign.response, g.assign),
    },
  };
}

/** A fresh journal id: a letter, then 20 URL-safe characters from the CSPRNG. */
export const newAgentId = (): string => `a${randomBytes(15).toString("base64url")}`;

/** Register both contracts through the host's registrar (never the daemon itself). */
export function registerAgentsHandlers(registrar: HandlerRegistrar, deps: Omit<AgentsServiceDeps, "newId"> & { readonly newId?: () => string }): void {
  const handlers = createAgentsHandlers(createAgentsService({ ...deps, newId: deps.newId ?? newAgentId }));
  registrar.register(AGENTS_CONTRACT, AGENTS_VERSION, handlers.agents);
  registrar.register(AGENT_GROUPS_CONTRACT, AGENT_GROUPS_VERSION, handlers.groups);
}
