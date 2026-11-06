// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { HandlerContext } from "@axis/daemon";
import { providersListResponseSchema, runEventSchema, type RunEvent } from "@axis/protocol";
import { createMockProvider, guardProvider, NO_SECRETS, type GuardedProvider, type MockProviderOptions, type ModelInfo } from "@axis/providers";
import { createComposerService, createProvidersListHandler } from "../src/index.js";
import { allEvents, composerRig, START, until, type ComposerRig } from "./composer-rig.js";

const CANARY = ["cred", "ential", "-canary-", "value"].join("");
const MOCK_TEXT = "Local mock provider; no data leaves the device.";

const ctx = (signal: AbortSignal = new AbortController().signal): HandlerContext => ({ identity: { kind: "user" }, requestId: "r1", correlationId: "c1", signal }) as unknown as HandlerContext;
const guarded = (o: MockProviderOptions = {}) => guardProvider(createMockProvider({ credential: CANARY, ...o }), { redactor: NO_SECRETS });
/** A provider whose model list is whatever the test says; everything else is the guarded mock. */
const listing = (connectionId: string, list: () => Promise<readonly ModelInfo[]>): Pick<GuardedProvider, "descriptor" | "listModels"> => {
  const p = guarded({ connectionId });
  return { descriptor: p.descriptor, listModels: list };
};
const list = async (providers: readonly Pick<GuardedProvider, "descriptor" | "listModels">[], c = ctx()) => providersListResponseSchema.parse(await createProvidersListHandler({ providers: () => providers })(c, {} as never));

// ---- C5: models per connection ----

test("C5: the mock is listed with its models and the status ready", async () => {
  const out = await list([guarded({ connectionId: "mock-a", models: [{ id: "mock-model", displayName: "Mock model" }, { id: "mock-small" }] })]);
  assert.deepEqual(out.providers[0]?.models, [{ modelId: "mock-model", displayName: "Mock model" }, { modelId: "mock-small" }]);
  assert.equal(out.providers[0]?.status, "ready");
  assert.ok(!JSON.stringify(out).includes(CANARY));
});

test("C5: a connection that cannot list is unavailable with no models, and the others are still listed", async () => {
  const out = await list([listing("zz-broken", async () => { throw new Error(CANARY); }), guarded({ connectionId: "aa-ok" })]);
  assert.deepEqual(out.providers.map((p) => [p.connectionId, p.status, p.models.length]), [["aa-ok", "ready", 1], ["zz-broken", "unavailable", 0]]);
  assert.ok(!JSON.stringify(out).includes(CANARY));
});

test("C5: a model list outside the contract (odd id, duplicate, too many) makes only that connection unavailable", async () => {
  const bad: Array<readonly ModelInfo[]> = [
    [{ id: "https://user:pw@host.example/m" }],
    [{ id: "m 1" }],
    [{ id: "dup" }, { id: "dup" }],
    Array.from({ length: 201 }, (_, i) => ({ id: `m${i}` })),
    [{ id: "ok", displayName: "line\nbreak" }],
  ];
  for (const models of bad) {
    const out = await list([listing("c1", async () => models), guarded({ connectionId: "c2" })]);
    assert.deepEqual(out.providers.map((p) => [p.connectionId, p.status]), [["c1", "unavailable"], ["c2", "ready"]], JSON.stringify(models).slice(0, 60));
    assert.deepEqual(out.providers[0]?.models, []);
  }
  const exactly = await list([listing("c1", async () => Array.from({ length: 200 }, (_, i) => ({ id: `m${i}` })))]);
  assert.equal(exactly.providers[0]?.models.length, 200, "exactly the cap is allowed");
});

test("C5: only the contract's fields of a model entry are copied", async () => {
  const entry = { id: "m1", displayName: "Model", apiKey: CANARY, url: "https://u:p@h.example" } as ModelInfo;
  const out = await list([listing("c1", async () => [entry])]);
  assert.deepEqual(out.providers[0]?.models, [{ modelId: "m1", displayName: "Model" }]);
  assert.ok(!JSON.stringify(out).includes(CANARY));
});

test("C5: a request cancelled while a connection lists is E_CANCELLED, not a list of unavailable connections", async () => {
  const ac = new AbortController();
  const hanging = listing("c1", () => new Promise((_, reject) => ac.signal.addEventListener("abort", () => reject(new Error("aborted")))));
  const pending = createProvidersListHandler({ providers: () => [hanging] })(ctx(ac.signal), {} as never) as Promise<unknown>;
  ac.abort();
  await assert.rejects(pending, (e: { code?: string }) => e.code === "E_CANCELLED");
});

test("C5: the composed registry and the list answer from the same providers (the mock is listed, not [])", async (t) => {
  const c = await rigged(t, []);
  const out = await list(c.agent.providers());
  assert.deepEqual(out.providers.map((p) => [p.providerId, p.status, p.models.map((m) => m.modelId)]), [["mock", "ready", ["mock-model"]]]);
  assert.equal(c.agent.provider("mock"), c.agent.providers()[0]);
});

// ---- C9: destination per request, no fallback ----

async function rigged(t: TestContext, replies: MockProviderOptions["replies"] & object): Promise<ComposerRig> {
  const c = await composerRig({ replies: replies as never });
  t.after(() => c.cleanup());
  return c;
}
const requests = (events: readonly RunEvent[]) => events.filter((e): e is Extract<RunEvent, { type: "request" }> => e.type === "request");
const ended = (c: ComposerRig, id: string) => () => !c.service.get(id).live && ["REVIEWING", "FAILED", "CANCELLED"].includes(c.service.get(id).state);

test("C9/PRV-4: every provider request is shown with its destination, before its usage, one event per request", async (t) => {
  const c = await rigged(t, [{ kind: "tool_use", name: "read_file", input: { path: "src/a.txt" } }, { kind: "text", text: "done" }]);
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await until(ended(c, run.runId));
  const events = allEvents(c, run.runId);
  for (const e of events) runEventSchema.parse(e);
  assert.deepEqual(requests(events).map((e) => [e.request, e.providerId, e.connectionId, e.destination]), [[1, "mock", "mock-connection", MOCK_TEXT], [2, "mock", "mock-connection", MOCK_TEXT]]);
  assert.equal(requests(events).length, c.wire(), "one event per request that reached the provider");
  const order = events.map((e) => e.type).filter((x) => x === "request" || x === "usage");
  assert.deepEqual(order, ["request", "usage", "request", "usage"]);
});

test("C9/PRV-4: a request the budget refuses is not shown as sent", async (t) => {
  const c = await composerRig({ replies: [{ kind: "tool_use", name: "read_file", input: { path: "src/a.txt" } }, { kind: "text", text: "never" }], budget: { maxRequests: 1 } });
  t.after(() => c.cleanup());
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await until(ended(c, run.runId));
  assert.equal(c.service.get(run.runId).reason, "BUDGET_REQUESTS");
  assert.equal(c.wire(), 1);
  assert.equal(requests(allEvents(c, run.runId)).length, 1);
});

/** A service over two providers and no tools: `alpha` (the one the test breaks) and `beta`. */
function twoProviders(c: ComposerRig, alpha: MockProviderOptions, extra: Partial<MockProviderOptions> = {}) {
  const a = guarded({ providerId: "alpha", connectionId: "conn-alpha", ...alpha });
  const bRaw = createMockProvider({ providerId: "beta", connectionId: "conn-beta", ...extra });
  const b = guardProvider(bRaw, { redactor: NO_SECRETS });
  const map = new Map<string, GuardedProvider>([["alpha", a], ["beta", b]]);
  const service = createComposerService({ journal: c.journal, engine: { provider: (id) => map.get(id), prepare: async () => () => { throw new Error("no tools"); } }, now: () => c.r.clock.now() });
  return { service, beta: bRaw };
}

test("C9/PRV-4: an unavailable selected connection is refused, creates nothing, and no other provider is asked", async (t) => {
  const c = await rigged(t, []);
  const { beta } = twoProviders(c, {});
  const raw = createMockProvider({ providerId: "alpha", connectionId: "conn-alpha" });
  const unreachable = guardProvider({ ...raw, descriptor: raw.descriptor, listModels: async () => { throw new Error(CANARY); } } as never, { redactor: NO_SECRETS });
  const beta2 = guardProvider(beta, { redactor: NO_SECRETS });
  const service = createComposerService({ journal: c.journal, engine: { provider: (id) => (id === "alpha" ? unreachable : id === "beta" ? beta2 : undefined), prepare: async () => () => { throw new Error("no tools"); } }, now: () => c.r.clock.now() });
  const reason = (e: unknown): unknown => (e as { details?: Record<string, unknown> }).details?.["reason"];
  await assert.rejects(service.start(START(c.workspaceId, { providerId: "alpha", mode: "ask" }), new AbortController().signal), (e: Error & { code?: string }) => reason(e) === "provider_unavailable" && e.code === "E_UNAVAILABLE" && !JSON.stringify(e).includes(CANARY));
  assert.equal(beta.requests.length, 0, "the other provider was never asked");
  assert.equal(c.journal.listRuns({ workspaceId: c.workspaceId }).length, 0, "the refused start created nothing");
  service.dispose();
});

test("C9/PRV-4: a provider that fails mid-run fails the run; the other provider is never asked", async (t) => {
  const c = await rigged(t, []);
  const { service, beta } = twoProviders(c, { replies: [{ kind: "error", code: "server_error", status: 500 }] });
  const { run } = await service.start(START(c.workspaceId, { providerId: "alpha", mode: "ask" }), new AbortController().signal);
  const done = () => ["FAILED", "REVIEWING"].includes(service.get(run.runId).state) && !service.get(run.runId).live;
  await until(done);
  assert.equal(service.get(run.runId).state, "FAILED");
  assert.match(service.get(run.runId).reason ?? "", /^PROVIDER_/);
  assert.equal(beta.requests.length, 0);
  assert.ok(service.events(run.runId, 0, 200).events.every((e) => e.type !== "request" || (e.providerId === "alpha" && e.connectionId === "conn-alpha")));
  service.dispose();
  await service.idle();
});

test("C9/PRV-4: the shown destination is the adapter's https origin when it has one", async (t) => {
  const c = await rigged(t, []);
  const raw = createMockProvider({ providerId: "alpha", connectionId: "conn-alpha" });
  const withOrigin = { ...raw, descriptor: { ...raw.descriptor, destination: { origin: "https://api.example.com", description: "Example API" } } };
  const p = guardProvider(withOrigin as never, { redactor: NO_SECRETS });
  const service = createComposerService({ journal: c.journal, engine: { provider: () => p, prepare: async () => () => { throw new Error("no tools"); } }, now: () => c.r.clock.now() });
  const { run } = await service.start(START(c.workspaceId, { providerId: "alpha", mode: "ask" }), new AbortController().signal);
  await until(() => !service.get(run.runId).live);
  assert.deepEqual(requests(service.events(run.runId, 0, 200).events).map((e) => e.destination), ["https://api.example.com"]);
  service.dispose();
  await service.idle();
});

test("C9/PRV-4: a descriptor that cannot be shown safely (a URL with a password as the connection id) refuses the start", async (t) => {
  const c = await rigged(t, []);
  const raw = createMockProvider({ providerId: "alpha", connectionId: "https://user:pw@host.example/x" });
  const p = guardProvider(raw, { redactor: NO_SECRETS });
  const service = createComposerService({ journal: c.journal, engine: { provider: () => p, prepare: async () => () => { throw new Error("no tools"); } }, now: () => c.r.clock.now() });
  await assert.rejects(service.start(START(c.workspaceId, { providerId: "alpha", mode: "ask" }), new AbortController().signal), (e) => (e as { details?: Record<string, unknown> }).details?.["reason"] === "provider_unavailable");
  assert.equal(raw.requests.length, 0);
  assert.equal(c.journal.listRuns({ workspaceId: c.workspaceId }).length, 0);
  service.dispose();
});
