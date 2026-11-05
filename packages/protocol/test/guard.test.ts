// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { INVALID_PAYLOAD_MESSAGE, copyBounded, guarded, inspectMessage } from "../src/index.js";
import { errorText } from "./suite.js";

const strict = z.strictObject({ a: z.string(), n: z.number().int().optional() });

test("control: a bare strict schema echoes an unknown key, the guarded one does not", () => {
  const input = { a: "x", CANARY_KEY: 1 };
  const bare = strict.safeParse(input);
  assert.equal(bare.success, false);
  assert.ok(errorText(bare).includes("CANARY_KEY"), "the control must echo, or the no-echo checks prove nothing");
  const wrapped = guarded(strict).safeParse(input);
  assert.equal(wrapped.success, false);
  assert.equal(errorText(wrapped).includes("CANARY_KEY"), false);
  if (!wrapped.success) assert.deepEqual(wrapped.error.issues.map((i) => [i.code, i.message, i.path]), [["custom", INVALID_PAYLOAD_MESSAGE, []]]);
});

test("control: a bare strict schema accepts a getter, the guarded one refuses it without calling it", () => {
  let reads = 0;
  const o: Record<string, unknown> = {};
  Object.defineProperty(o, "a", { get: () => (++reads, "x"), enumerable: true });
  assert.equal(strict.safeParse(o).success, true, "the control must accept, or the getter checks prove nothing");
  reads = 0;
  assert.equal(guarded(strict).safeParse(o).success, false);
  assert.equal(reads, 0, "the getter must never run");
});

test("guarded returns a copy of the input and never the input", () => {
  const nested = z.strictObject({ list: z.array(z.strictObject({ k: z.string() })) });
  const input = { list: [{ k: "v" }] };
  const r = guarded(nested).safeParse(input);
  assert.equal(r.success, true);
  if (!r.success) return;
  assert.deepEqual(r.data, input);
  assert.notEqual(r.data, input);
  assert.notEqual(r.data.list, input.list);
  assert.notEqual(r.data.list[0], input.list[0]);
  input.list[0]!.k = "changed";
  assert.equal(r.data.list[0]!.k, "v");
});

test("guarded never throws: Proxies with throwing traps, revoked Proxies, throwing refinements", () => {
  const trap = (): never => { throw new Error("CANARY"); };
  const hostile = [
    new Proxy({ a: "x" }, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap, has: trap }),
    new Proxy({ a: "x" }, {}),
    (() => { const r = Proxy.revocable({ a: "x" }, {}); r.revoke(); return r.proxy; })(),
    new Proxy([], {}),
  ];
  for (const h of hostile) {
    const r = guarded(strict).safeParse(h);
    assert.equal(r.success, false);
    assert.equal(errorText(r).includes("CANARY"), false);
  }
  const throwing = guarded(z.string().refine(() => { throw new Error("CANARY"); }));
  const r = throwing.safeParse("fine");
  assert.equal(r.success, false);
  assert.equal(errorText(r).includes("CANARY"), false);
});

test("guarded: top-level values that are not plain JSON data are refused", () => {
  for (const bad of [undefined, () => 1, Symbol("s"), 1n, Number.NaN, new Date(0), new Map(), Object.create({ a: "x" })]) {
    assert.equal(guarded(z.unknown()).safeParse(bad).success, false, String(bad));
  }
  assert.equal(guarded(z.string()).safeParse("x").success, true);
});

test("guarded keeps the fields of an object schema as `shape`, and adds none to others", () => {
  assert.equal((guarded(strict) as { shape?: unknown }).shape, strict.shape);
  assert.equal("shape" in guarded(z.string()), false);
});

test("copyBounded: the walk's limits apply and a failure carries nothing", () => {
  assert.deepEqual(copyBounded({ a: 1 }), { ok: true, value: { a: 1 } });
  assert.deepEqual(copyBounded({ a: "x".repeat(300_000) }), { ok: false });
  assert.deepEqual(copyBounded(JSON.parse('{"__proto__":{"x":1}}')), { ok: false });
  const shared = { x: 1 };
  assert.deepEqual(copyBounded({ a: shared, b: shared }), { ok: false });
  assert.deepEqual(copyBounded({ a: "x".repeat(40) }, { maxStringBytes: 8 }), { ok: false });
});

test("inspectMessage: a symbol-keyed property on an array is refused, like one on an object", () => {
  const withSymbol = Object.assign([1, 2], { [Symbol("s")]: "hidden" });
  assert.deepEqual(inspectMessage(withSymbol), { ok: false, reason: "invalid" });
  assert.deepEqual(inspectMessage(Object.assign({ a: 1 }, { [Symbol("s")]: 1 })), { ok: false, reason: "invalid" });
  assert.deepEqual(inspectMessage([1, 2]), { ok: true });
});
