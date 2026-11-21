// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-D2: the axis.forge/1 handlers serve the user's own desktop connection only, and their errors carry no text of their own.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { HandlerContext } from "@axis/daemon";
import { FORGE_REFUSAL_MESSAGE, ForgeRefusal, createForgeHandlers, type ForgeService } from "../src/index.js";

const CANARY = "CANARY51ab";
const ctx = (identity: Record<string, unknown>, aborted = false): HandlerContext => {
  const ac = new AbortController();
  if (aborted) ac.abort();
  return { identity, requestId: "q", correlationId: "c", signal: ac.signal } as unknown as HandlerContext;
};
const USER = { actor: "user", clientKind: "desktop" };
const service = (over: Partial<ForgeService> = {}): ForgeService => ({
  pullRequests: async () => ({ state: "no_remote" }),
  pinRepository: async () => ({ repository: { host: "github.com", owner: "acme", repo: "app" } }),
  ...over,
});
const outcome = async (p: unknown): Promise<string> => {
  try {
    return `ok:${JSON.stringify(await p)}`;
  } catch (e) {
    const x = e as { code?: string; message?: string; details?: unknown };
    return `${x.code}|${x.message}|${JSON.stringify(x.details)}`;
  }
};

test("only the user's desktop connection is served; a web client or another actor is refused as not found", async () => {
  const h = createForgeHandlers({ service: service() });
  assert.equal(await outcome(h.pullRequests(ctx(USER), { projectId: "p", trigger: "view" } as never)), 'ok:{"state":"no_remote"}');
  for (const who of [{ actor: "user", clientKind: "web" }, { actor: "agent:a1", clientKind: "desktop" }, { actor: "daemon", clientKind: "desktop" }]) {
    assert.equal(await outcome(h.pullRequests(ctx(who), { projectId: "p", trigger: "view" } as never)), `E_NOT_FOUND|${FORGE_REFUSAL_MESSAGE}|{"reason":"not_found"}`, JSON.stringify(who));
    assert.ok((await outcome(h.pinRepository(ctx(who), { projectId: "p", host: "github.com", owner: "acme", repo: "app" } as never))).startsWith("E_NOT_FOUND|"));
  }
  assert.ok((await outcome(h.pullRequests(ctx(USER, true), { projectId: "p", trigger: "view" } as never))).startsWith("E_CANCELLED|"));
});

test("refusals map to closed codes; any other error or an answer outside the schema is E_INTERNAL with no text", async () => {
  const refusing = (reason: "not_found" | "candidate_changed") => createForgeHandlers({ service: service({ pinRepository: async () => { throw new ForgeRefusal(reason); } }) });
  const pin = { projectId: "p", host: "github.com", owner: "acme", repo: "app" } as never;
  assert.equal(await outcome(refusing("not_found").pinRepository(ctx(USER), pin)), `E_NOT_FOUND|${FORGE_REFUSAL_MESSAGE}|{"reason":"not_found"}`);
  assert.equal(await outcome(refusing("candidate_changed").pinRepository(ctx(USER), pin)), `E_CONFLICT|${FORGE_REFUSAL_MESSAGE}|{"reason":"candidate_changed"}`);
  const leaky = createForgeHandlers({ service: service({ pullRequests: async () => { throw new Error(`gh said ${CANARY}`); } }) });
  const internal = await outcome(leaky.pullRequests(ctx(USER), { projectId: "p", trigger: "user" } as never));
  assert.equal(internal, "E_INTERNAL|Request failed|undefined");
  const badShape = createForgeHandlers({ service: service({ pullRequests: async () => ({ state: "ok", rows: [{ title: CANARY }] }) as never }) });
  const shape = await outcome(badShape.pullRequests(ctx(USER), { projectId: "p", trigger: "user" } as never));
  assert.equal(shape, "E_INTERNAL|Request failed|undefined");
  const noRows = createForgeHandlers({ service: service({ pullRequests: async () => ({ state: "ok" }) as never }) });
  assert.ok((await outcome(noRows.pullRequests(ctx(USER), { projectId: "p", trigger: "user" } as never))).startsWith("E_INTERNAL|"), "ok without rows is refused by the schema");
});
