// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ERROR_CODES } from "@axis/audit";
import type { HandlerContext } from "@axis/daemon";
import { contracts, lookupMethod, providersListResponseSchema } from "@axis/protocol";
import { createMockProvider, guardProvider, NO_SECRETS, type AdapterDescriptor } from "@axis/providers";
import { createProvidersHandlers, createProvidersListHandler } from "../src/index.js";

const CANARY = ["cred", "ential", "-canary-", "value"].join("");

const ctx = (signal: AbortSignal = new AbortController().signal): HandlerContext =>
  ({ identity: { kind: "user" }, requestId: "r1", correlationId: "c1", signal }) as unknown as HandlerContext;

const mock = (connectionId = "mock-conn") => guardProvider(createMockProvider({ connectionId, credential: CANARY }), { redactor: NO_SECRETS });
const call = (h: ReturnType<typeof createProvidersListHandler>, payload: unknown = {}, c = ctx()) => h(c, payload as never) as unknown;

function errorOf(fn: () => unknown): { code: string; message: string; detail: unknown } {
  try { fn(); } catch (e) { const x = e as { code: string; message: string; detail: unknown }; return { code: x.code, message: x.message, detail: x.detail }; }
  return assert.fail("did not throw");
}

test("the contract is served as declared: tier 0, read, no idempotency", () => {
  const spec = lookupMethod("axis.providers", 1, "list");
  assert.ok(spec);
  assert.equal(spec.tier, 0);
  assert.equal(spec.sideEffect, "read");
  assert.equal(spec.idempotency, "none");
  assert.ok(contracts["axis.providers/1"]);
});

test("list over the guarded mock conforms to the protocol response schema and names the mock", () => {
  const h = createProvidersHandlers({ providers: () => [mock()] }).list;
  const out = call(h);
  const parsed = providersListResponseSchema.parse(out);
  assert.equal(parsed.providers.length, 1);
  assert.equal(parsed.providers[0]?.providerId, "mock");
  assert.equal(parsed.providers[0]?.connectionId, "mock-conn");
  assert.deepEqual(Object.keys(parsed.providers[0] ?? {}).sort(), ["apiVersion", "connectionId", "destination", "displayName", "providerId"]);
  assert.ok(!JSON.stringify(out).includes(CANARY));
  assert.deepEqual(call(createProvidersListHandler({ providers: () => [] })), { providers: [] });
});

test("an empty provider set and several providers (sorted by connection id) both conform", () => {
  const h = createProvidersListHandler({ providers: () => [mock("zeta"), mock("alpha")] });
  const out = providersListResponseSchema.parse(call(h));
  assert.deepEqual(out.providers.map((p) => p.connectionId), ["alpha", "zeta"]);
});

test("extra properties on a descriptor (a label, a credential) never reach the output", () => {
  const p = mock();
  const d = { ...p.descriptor, label: "my personal key", apiKey: CANARY, destination: { ...p.descriptor.destination, token: CANARY } };
  const out = call(createProvidersListHandler({ providers: () => [{ descriptor: d as AdapterDescriptor }] }));
  const text = JSON.stringify(out);
  assert.ok(!text.includes(CANARY) && !text.includes("personal") && !text.includes("label"));
  providersListResponseSchema.parse(out);
});

test("an https origin is passed through and a wrong one fails the whole answer", () => {
  const p = mock();
  const withOrigin = { descriptor: { ...p.descriptor, destination: { origin: "https://api.example.com", description: "Example" } } };
  const out = providersListResponseSchema.parse(call(createProvidersListHandler({ providers: () => [withOrigin] })));
  assert.equal(out.providers[0]?.destination.origin, "https://api.example.com");
  const bad = { descriptor: { ...p.descriptor, destination: { origin: "https://user:pw@api.example.com/x", description: "Example" } } };
  const e = errorOf(() => call(createProvidersListHandler({ providers: () => [bad] })));
  assert.equal(e.code, "E_INTERNAL");
  assert.ok(!e.message.includes("pw"));
});

test("a non-empty or malformed request is refused with E_INVALID_ARGUMENT and a fixed message", () => {
  const h = createProvidersListHandler({ providers: () => [mock()] });
  for (const payload of [{ x: 1 }, null, [], "s", { __proto__: { a: 1 }, extra: CANARY }, { get a() { return 1; } }]) {
    const e = errorOf(() => call(h, payload));
    assert.equal(e.code, "E_INVALID_ARGUMENT");
    assert.equal(e.message, "The request is not valid.");
    assert.ok(!JSON.stringify(e).includes(CANARY));
  }
});

test("a cancelled request is E_CANCELLED and reads no provider", () => {
  let reads = 0;
  const h = createProvidersListHandler({ providers: () => { reads++; return []; } });
  const ac = new AbortController();
  ac.abort();
  assert.equal(errorOf(() => call(h, {}, ctx(ac.signal))).code, "E_CANCELLED");
  assert.equal(reads, 0);
});

test("a hostile descriptor (throwing getter, Proxy) gives a fixed E_INTERNAL that echoes nothing", () => {
  const getter = { get descriptor(): AdapterDescriptor { throw new Error(CANARY); } };
  const proxy = { descriptor: new Proxy({}, { get() { throw new Error(CANARY); } }) as AdapterDescriptor };
  const source = { providers: (): never => { throw new Error(CANARY); } };
  for (const deps of [{ providers: () => [getter] }, { providers: () => [proxy] }, source]) {
    const e = errorOf(() => call(createProvidersListHandler(deps)));
    assert.equal(e.code, "E_INTERNAL");
    assert.equal(e.message, "The provider list is unavailable.");
    assert.ok(!JSON.stringify(e).includes(CANARY));
  }
});

test("every error code the handler throws is in the closed set", () => {
  const h = createProvidersListHandler({ providers: () => [{ descriptor: undefined as never }] });
  const ac = new AbortController();
  ac.abort();
  const codes = [errorOf(() => call(h, 1)).code, errorOf(() => call(h)).code, errorOf(() => call(h, {}, ctx(ac.signal))).code];
  for (const c of codes) assert.ok((ERROR_CODES as readonly string[]).includes(c), c);
});

test("more providers than the contract allows fails closed instead of truncating", () => {
  const many = Array.from({ length: 65 }, (_, i) => mock(`conn-${i}`));
  assert.equal(errorOf(() => call(createProvidersListHandler({ providers: () => many }))).code, "E_INTERNAL");
});

test("two providers on one connection id fail closed", () => {
  assert.equal(errorOf(() => call(createProvidersListHandler({ providers: () => [mock("same"), mock("same")] }))).code, "E_INTERNAL");
});
