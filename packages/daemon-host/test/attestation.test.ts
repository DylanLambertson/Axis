// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import type { Identity } from "@axis/daemon";
import { createAttestationVerifier, MAX_AGE_MS, MAX_SKEW_MS, signAttestation } from "../src/index.js";
import { fakeClock } from "./helpers.js";

const key = randomBytes(32);
const identity = (over: Partial<Identity> = {}): Identity => ({
  connectionId: randomBytes(16).toString("base64url"),
  windowId: "win-1",
  actorId: "person-1",
  actor: "user",
  workspaceId: "ws-1",
  trusted: true,
  clientKind: "desktop",
  ...over,
});

function setup(ringSize?: number) {
  const clock = fakeClock();
  const verifier = createAttestationVerifier({ key, clock, ...(ringSize === undefined ? {} : { ringSize }) });
  return { clock, verifier };
}

test("a fresh attestation yields its identity, once", () => {
  const { clock, verifier } = setup();
  const id = identity();
  const a = signAttestation(key, id, clock.now());
  assert.deepEqual(verifier.verify(a), id);
  assert.equal(verifier.verify(a), undefined, "replay while fresh");
  assert.equal(verifier.refusals().replayed, 1);
  // A re-signed attestation for the same connection id is a replay too.
  assert.equal(verifier.verify(signAttestation(key, id, clock.now())), undefined);
});

test("every identity field is bound by the MAC", () => {
  const { clock, verifier } = setup();
  const a = signAttestation(key, identity(), clock.now());
  const edits: Array<Partial<Identity>> = [
    { actor: "daemon" }, { actor: "agent:x" }, { workspaceId: "ws-2" }, { windowId: "win-2" }, { trusted: false },
    { clientKind: "web" }, { actorId: "other" }, { connectionId: randomBytes(16).toString("base64url") },
  ];
  for (const edit of edits) {
    assert.equal(verifier.verify({ ...a, identity: { ...a.identity, ...edit } }), undefined, JSON.stringify(Object.keys(edit)));
  }
  assert.equal(verifier.verify({ ...a, issuedAt: a.issuedAt + 1 }), undefined);
  assert.equal(verifier.refusals().bad_mac, edits.length + 1);
  assert.notEqual(verifier.verify(a), undefined, "the untouched one still works (nothing was recorded by failures)");
});

test("a MAC from another key, a truncated or padded MAC and junk are refused", () => {
  const { clock, verifier } = setup();
  const id = identity();
  assert.equal(verifier.verify(signAttestation(randomBytes(32), id, clock.now())), undefined);
  const good = signAttestation(key, id, clock.now());
  for (const mac of [good.mac.slice(0, 42), `${good.mac}A`, `${good.mac.slice(0, 42)}=`, "", good.mac.toUpperCase()]) {
    assert.equal(verifier.verify({ ...good, mac }), undefined);
  }
  for (const junk of [undefined, null, 1, "x", [], {}, { ...good, extra: 1 }, { ...good, identity: [] }]) {
    assert.equal(verifier.verify(junk), undefined);
  }
  assert.notEqual(verifier.verify(good), undefined);
});

test("freshness window: 30 s old and 5 s ahead are the limits", () => {
  const { clock, verifier } = setup();
  const t = clock.now();
  assert.notEqual(verifier.verify(signAttestation(key, identity(), t - MAX_AGE_MS)), undefined);
  assert.equal(verifier.verify(signAttestation(key, identity(), t - MAX_AGE_MS - 1)), undefined);
  assert.notEqual(verifier.verify(signAttestation(key, identity(), t + MAX_SKEW_MS)), undefined);
  assert.equal(verifier.verify(signAttestation(key, identity(), t + MAX_SKEW_MS + 1)), undefined);
  const r = verifier.refusals();
  assert.equal(r.stale, 1);
  assert.equal(r.future, 1);
});

test("a correctly signed but malformed identity is refused", () => {
  const { clock, verifier } = setup();
  for (const bad of [identity({ connectionId: "short" }), identity({ actor: "root" as never }), identity({ windowId: "a b" })]) {
    assert.equal(verifier.verify(signAttestation(key, bad, clock.now())), undefined);
  }
  assert.equal(verifier.refusals().bad_identity, 3);
});

test("the replay memory is bounded, expires with freshness, and a full ring refuses", () => {
  const { clock, verifier } = setup(3);
  const ids = [identity(), identity(), identity()];
  for (const id of ids) assert.notEqual(verifier.verify(signAttestation(key, id, clock.now())), undefined);
  assert.equal(verifier.verify(signAttestation(key, identity(), clock.now())), undefined);
  assert.equal(verifier.refusals().ring_full, 1);
  clock.advance(MAX_AGE_MS + 1);
  assert.notEqual(verifier.verify(signAttestation(key, identity(), clock.now())), undefined, "old entries were evicted");
  // The old attestation is still refused, now as stale rather than from memory.
  assert.equal(verifier.verify(signAttestation(key, ids[0] as Identity, clock.now() - MAX_AGE_MS - 1)), undefined);
});

test("close forgets ids and refuses later use; the caller's key is untouched", () => {
  const own = randomBytes(32);
  const before = Buffer.from(own);
  const clock = fakeClock();
  const verifier = createAttestationVerifier({ key: own, clock });
  const a = signAttestation(own, identity(), clock.now());
  verifier.close();
  assert.equal(verifier.verify(a), undefined);
  assert.equal(verifier.refusals().closed, 1);
  assert.deepEqual(Buffer.from(own), before);
});

/** A clock the test moves in either direction, or sets to any value. */
function movableClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, monotonic: () => t, set: (v: number) => void (t = v) };
}

test("an id is remembered until its attestation is stale: a replay at exactly 30 s is 'replayed', at 30 s + 1 'stale'", () => {
  const clock = movableClock();
  const verifier = createAttestationVerifier({ key, clock, ringSize: 2 });
  const t0 = clock.now();
  const a = signAttestation(key, identity(), t0);
  assert.notEqual(verifier.verify(a), undefined);
  // Other traffic fills and churns the ring while A is still fresh; it must not push A out.
  clock.set(t0 + 10_000);
  assert.notEqual(verifier.verify(signAttestation(key, identity(), clock.now())), undefined);
  clock.set(t0 + MAX_AGE_MS);
  assert.equal(verifier.verify(a), undefined);
  assert.equal(verifier.refusals().replayed, 1, "still fresh at exactly 30 s: refused as a replay");
  assert.equal(verifier.refusals().stale, 0);
  clock.set(t0 + MAX_AGE_MS + 1);
  assert.equal(verifier.verify(a), undefined);
  assert.equal(verifier.refusals().stale, 1);
});

test("a wall clock that steps back does not revive an attestation that left the ring", () => {
  const clock = movableClock();
  const verifier = createAttestationVerifier({ key, clock });
  const t0 = clock.now();
  const a = signAttestation(key, identity(), t0);
  assert.notEqual(verifier.verify(a), undefined);
  clock.set(t0 + 31_000);
  assert.equal(verifier.verify(signAttestation(key, identity(), clock.now())) !== undefined, true, "this call evicts A");
  clock.set(t0 + 6_000);
  assert.equal(verifier.verify(a), undefined, "A is stale for the high-water mark, not fresh again");
  assert.equal(verifier.refusals().replayed, 0);
  assert.equal(verifier.refusals().stale, 1);
});

test("a clock that is not a finite number refuses everything", () => {
  const clock = movableClock();
  const verifier = createAttestationVerifier({ key, clock });
  const a = signAttestation(key, identity(), 0);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    clock.set(bad);
    assert.equal(verifier.verify(a), undefined);
    assert.equal(verifier.verify(signAttestation(key, identity(), 0)), undefined);
  }
  assert.equal(verifier.refusals().bad_clock, 6);
  (clock as { now: () => unknown }).now = () => "now";
  assert.equal(verifier.verify(a), undefined);
});

test("a MAC with the same bytes in another base64url form is refused", () => {
  const { clock, verifier } = setup();
  const good = signAttestation(key, identity(), clock.now());
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = good.mac[42] as string;
  const alt = `${good.mac.slice(0, 42)}${alphabet[alphabet.indexOf(last) ^ 1]}`;
  assert.notEqual(alt, good.mac);
  assert.deepEqual(Buffer.from(alt, "base64url"), Buffer.from(good.mac, "base64url"), "same bytes");
  assert.equal(verifier.verify({ ...good, mac: alt }), undefined);
  assert.notEqual(verifier.verify(good), undefined);
});

test("an identity with an own __proto__ key is refused, not silently reduced", () => {
  const { clock, verifier } = setup();
  const signed = signAttestation(key, identity(), clock.now());
  const hostile = JSON.parse(JSON.stringify(signed).replace('"identity":{', '"identity":{"__proto__":{"x":1},')) as unknown;
  assert.equal(verifier.verify(hostile), undefined);
  assert.equal(verifier.refusals().malformed, 1);
  assert.notEqual(verifier.verify(signed), undefined);
});

test("signing refuses an identity with undefined fields or a bad time", () => {
  const id = identity();
  assert.throws(() => signAttestation(key, { ...id, workspaceId: undefined } as never, 1), { code: "E_INVALID_ARGUMENT" });
  assert.throws(() => signAttestation(key, id, Number.NaN), { code: "E_INVALID_ARGUMENT" });
  assert.throws(() => signAttestation(key, id, -1), { code: "E_INVALID_ARGUMENT" });
  const { workspaceId: _omit, ...without } = id;
  assert.doesNotThrow(() => signAttestation(key, without, 1));
});
