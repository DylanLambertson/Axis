// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/*
 * Byte arrays from a caller, read without running caller code (PV-N1d slice B review 3 nit 1). `slice()`, `new
 * Uint8Array(x)` and `x.byteLength` can each run a subclass's `Symbol.species`, an overridden getter or a Proxy trap; these
 * use the intrinsic %TypedArray% accessors, which read the internal slots only.
 */

const TYPED_PROTO = Object.getPrototypeOf(Uint8Array.prototype) as object;
const getter = (name: PropertyKey): ((this: unknown) => unknown) => Object.getOwnPropertyDescriptor(TYPED_PROTO, name)?.get as (this: unknown) => unknown;
const TAG = getter(Symbol.toStringTag);
const BYTE_LENGTH = getter("byteLength");

/** True for a real Uint8Array (a Buffer or a subclass included); false for a Proxy, a DataView, another typed array or anything else. */
export function isBytes(value: unknown): value is Uint8Array {
  return typeof value === "object" && value !== null && Reflect.apply(TAG, value, []) === "Uint8Array";
}

/** A fresh copy of the bytes, by the internal slots: no species, getter or trap of the caller's object runs. */
export function copyBytes(value: Uint8Array): Uint8Array {
  const length = Reflect.apply(BYTE_LENGTH, value, []) as number;
  const out = new Uint8Array(length);
  out.set(value); // `out` is our own array, so this is the intrinsic set, which reads the source by its slots
  return out;
}
