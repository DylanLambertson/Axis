// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Daemon, DaemonError, MemoryIdempotencyStore, memoryPair, type HandlerContext, type Identity } from "@axis/daemon";
import { contracts, ERROR_CODES, lookupMethod, providersListResponseSchema } from "@axis/protocol";
import { createMockProvider, guardProvider, NO_SECRETS, type AdapterDescriptor, type GuardedProvider } from "@axis/providers";
import { createProvidersHandlers, createProvidersListHandler } from "../src/index.js";

const CANARY = ["cred", "ential", "-canary-", "value"].join("");

const ctx = (signal: AbortSignal = new AbortController().signal): HandlerContext =>
  ({ identity: { kind: "user" }, requestId: "r1", correlationId: "c1", signal }) as unknown as HandlerContext;

const fake = (descriptor: AdapterDescriptor) => ({ descriptor, listModels: async () => [] as const });
const mock = (connectionId = "mock-conn") => guardProvider(createMockProvider({ connectionId, credential: CANARY }), { redactor: NO_SECRETS });
const call = async (h: ReturnType<typeof createProvidersListHandler>, payload: unknown = {}, c = ctx()): Promise<unknown> => h(c, payload as never);

async function errorOf(fn: () => unknown): Promise<{ code: string; message: string; detail: unknown }> {
  try { await fn(); } catch (e) { const x = e as { code: string; message: string; detail: unknown }; return { code: x.code, message: x.message, detail: x.detail }; }
  return assert.fail("did not throw");
}

test("the contract is served as declared: tier 0, read, no idempotency", async () => {
  const spec = lookupMethod("axis.providers", 1, "list");
  assert.ok(spec);
  assert.equal(spec.tier, 0);
  assert.equal(spec.sideEffect, "read");
  assert.equal(spec.idempotency, "none");
  assert.ok(contracts["axis.providers/1"]);
});

test("list over the guarded mock conforms to the protocol response schema and names the mock", async () => {
  const h = createProvidersHandlers({ providers: () => [mock()] }).list;
  const out = await call(h);
  const parsed = providersListResponseSchema.parse(out);
  assert.equal(parsed.providers.length, 1);
  assert.equal(parsed.providers[0]?.providerId, "mock");
  assert.equal(parsed.providers[0]?.connectionId, "mock-conn");
  assert.deepEqual(Object.keys(parsed.providers[0] ?? {}).sort(), ["apiVersion", "connectionId", "destination", "displayName", "models", "providerId", "status"]);
  assert.ok(!JSON.stringify(out).includes(CANARY));
  assert.deepEqual(await call(createProvidersListHandler({ providers: () => [] })), { providers: [] });
});

test("an empty provider set and several providers (sorted by connection id) both conform", async () => {
  const h = createProvidersListHandler({ providers: () => [mock("zeta"), mock("alpha"), mock("mid")] });
  const out = providersListResponseSchema.parse(await call(h));
  assert.deepEqual(out.providers.map((p) => p.connectionId), ["alpha", "mid", "zeta"]);
});

test("extra properties on a descriptor (a label, a credential) never reach the output", async () => {
  const p = mock();
  const d = { ...p.descriptor, label: "my personal key", apiKey: CANARY, destination: { ...p.descriptor.destination, token: CANARY } };
  const out = await call(createProvidersListHandler({ providers: () => [fake(d as AdapterDescriptor)] }));
  const text = JSON.stringify(out);
  assert.ok(!text.includes(CANARY) && !text.includes("personal") && !text.includes("label"));
  providersListResponseSchema.parse(out);
});

test("an https origin is passed through and a wrong one fails the whole answer", async () => {
  const p = mock();
  const withOrigin = fake({ ...p.descriptor, destination: { origin: "https://api.example.com", description: "Example" } });
  const out = providersListResponseSchema.parse(await call(createProvidersListHandler({ providers: () => [withOrigin] })));
  assert.equal(out.providers[0]?.destination.origin, "https://api.example.com");
  const bad = fake({ ...p.descriptor, destination: { origin: "https://user:pw@api.example.com/x", description: "Example" } });
  const e = await errorOf(() => call(createProvidersListHandler({ providers: () => [bad] })));
  assert.equal(e.code, "E_INTERNAL");
  assert.ok(!e.message.includes("pw"));
});

test("a cancelled request is E_CANCELLED and reads no provider", async () => {
  let reads = 0;
  const h = createProvidersListHandler({ providers: () => { reads++; return []; } });
  const ac = new AbortController();
  ac.abort();
  assert.equal((await errorOf(() => call(h, {}, ctx(ac.signal)))).code, "E_CANCELLED");
  assert.equal(reads, 0);
  try { await call(h, {}, ctx(ac.signal)); } catch (e) { assert.ok(e instanceof DaemonError); }
});

test("a hostile descriptor (throwing getter, Proxy) gives a fixed E_INTERNAL that echoes nothing", async () => {
  const getter = { get descriptor(): AdapterDescriptor { throw new Error(CANARY); }, listModels: async () => [] as const };
  const proxy = { descriptor: new Proxy({}, { get() { throw new Error(CANARY); } }) as AdapterDescriptor, listModels: async () => [] as const };
  const source = { providers: (): never => { throw new Error(CANARY); } };
  for (const deps of [{ providers: () => [getter] }, { providers: () => [proxy] }, source]) {
    const e = await errorOf(() => call(createProvidersListHandler(deps)));
    assert.equal(e.code, "E_INTERNAL");
    assert.equal(e.message, "The provider list is unavailable.");
    assert.ok(!JSON.stringify(e).includes(CANARY));
  }
});

test("every error code the handler throws is in the closed set", async () => {
  const h = createProvidersListHandler({ providers: () => [{ descriptor: undefined as never, listModels: async () => [] as const }] });
  const ac = new AbortController();
  ac.abort();
  const codes = [(await errorOf(() => call(h))).code, (await errorOf(() => call(h, {}, ctx(ac.signal)))).code];
  for (const c of codes) assert.ok((ERROR_CODES as readonly string[]).includes(c), c);
});

test("more providers than the contract allows fails closed instead of truncating", async () => {
  const many = Array.from({ length: 65 }, (_, i) => mock(`conn-${i}`));
  assert.equal((await errorOf(() => call(createProvidersListHandler({ providers: () => many })))).code, "E_INTERNAL");
});

test("two providers on one connection id fail closed", async () => {
  assert.equal((await errorOf(() => call(createProvidersListHandler({ providers: () => [mock("same"), mock("same")] })))).code, "E_INTERNAL");
});

// Through the real daemon: only a DaemonError keeps its code and message on the wire.
const user: Identity = { connectionId: "conn-1".padEnd(22, "_"), windowId: "win-1", actorId: "actor-1", actor: "user", trusted: true, clientKind: "desktop" };

async function overWire(providers: () => readonly Pick<GuardedProvider, "descriptor" | "listModels">[], payload: unknown): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }> {
  const internal: unknown[] = [];
  const daemon = new Daemon({
    identity: { verify: () => user },
    audit: { append: () => undefined },
    idempotency: new MemoryIdempotencyStore(),
    policy: { evaluate: () => ({ effect: "allow" }) },
    onInternalError: (_id, e) => void internal.push(e),
  });
  daemon.register("axis.providers", 1, createProvidersHandlers({ providers }));
  const { client, server } = memoryPair();
  const replies: Array<{ id?: string; type?: string; ok?: boolean; result?: unknown; error?: { code: string; message: string } }> = [];
  client.on("message", (m) => void replies.push(m as never));
  daemon.accept(server, "attestation");
  try {
    client.postMessage({ type: "hello", protocolVersions: [1], contracts: [{ id: "axis.providers", versions: [1] }] });
    for (let i = 0; i < 200 && !replies.some((r) => r.type === "welcome"); i++) await new Promise((r) => setTimeout(r, 5));
    client.postMessage({ v: 1, id: "q1", contract: "axis.providers", contractVersion: 1, method: "list", payload });
    for (let i = 0; i < 200 && !replies.some((r) => r.id === "q1"); i++) await new Promise((r) => setTimeout(r, 5));
    const r = replies.find((x) => x.id === "q1");
    assert.ok(r, "no response");
    return r as never;
  } finally {
    daemon.stop();
    client.close();
  }
}

test("on the wire: a list succeeds", async () => {
  const r = await overWire(() => [mock()], {});
  assert.equal(r.ok, true);
  providersListResponseSchema.parse(r.result);
});

test("on the wire: a bad request is E_INVALID_ARGUMENT (the daemon validates it, not the handler)", async () => {
  const r = await overWire(() => [mock()], { x: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, "E_INVALID_ARGUMENT");
});

test("on the wire: an internal failure keeps the handler's fixed code and message, not the opaque default", async () => {
  const r = await overWire(() => Array.from({ length: 65 }, (_, i) => mock(`conn-${i}`)), {});
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, "E_INTERNAL");
  assert.equal(r.error?.message, "The provider list is unavailable.");
});
