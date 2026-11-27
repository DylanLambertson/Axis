// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { copyBytes, isBytes } from "../../src/net/bytes.js";

// PV-N1d slice B review 3 nit 1: a caller's byte array is recognised and copied by its internal slots; no species,
// getter, method override or Proxy trap of the caller's object runs or changes the copy.

test("only a real Uint8Array is bytes", () => {
  for (const ok of [new Uint8Array(2), Buffer.from("ab"), new (class extends Uint8Array {})(3)]) assert.equal(isBytes(ok), true);
  for (const bad of [new Proxy(new Uint8Array(2), {}), new DataView(new ArrayBuffer(2)), new Uint16Array(2), new Int8Array(2), [1, 2], { length: 2, 0: 1 }, "ab", null, undefined, new ArrayBuffer(2)]) {
    assert.equal(isBytes(bad), false, Object.prototype.toString.call(bad));
  }
});

test("the copy runs no caller code and holds the real bytes", () => {
  let ran = 0;
  class Sneaky extends Uint8Array {}
  const hit = <T>(v: T) => () => (ran++, v);
  Object.defineProperty(Sneaky, Symbol.species, { get: hit(Uint8Array) });
  for (const [name, value] of [["byteLength", 73], ["length", 73]] as const) Object.defineProperty(Sneaky.prototype, name, { get: hit(value) });
  Object.defineProperty(Sneaky.prototype, "slice", { value: hit(new Uint8Array(73)) });
  Object.defineProperty(Sneaky.prototype, "set", { value: hit(undefined) });
  const s = new Sneaky([1, 2, 3, 4]);
  const copy = copyBytes(s);
  assert.deepEqual([...copy], [1, 2, 3, 4]);
  assert.equal(copy.byteLength, 4);
  assert.equal(Object.getPrototypeOf(copy), Uint8Array.prototype);
  assert.equal(ran, 0, "no getter, species or method of the caller ran");
  s[0] = 9;
  assert.equal(copy[0], 1, "a copy, not a view");
  const view = new Uint8Array(new Uint8Array([0, 5, 6, 7]).buffer, 1, 2);
  assert.deepEqual([...copyBytes(view)], [5, 6], "a view's own bytes only");
});
