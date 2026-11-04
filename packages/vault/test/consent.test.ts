// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Consent as a capability (S2, S3, N-E).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as vaultModule from "../src/index.js";
import { VaultError, createConsentAuthority, createMemoryBackend, createVault } from "../src/index.js";
import { OTHER, SECRET, code, setup } from "./support/setup.js";

// ------------------------------------------------- S2, S3: consent is real

test("S2: one consent stores once, even when stores run concurrently", async () => {
  const { vault, consentFor } = setup("basic_text", "none");
  const consent = consentFor("conn-a", "basic_text");
  const results = await Promise.allSettled([
    vault.store("conn-a", SECRET, { consent }),
    vault.store("conn-a", SECRET, { consent }),
    vault.store("conn-a", SECRET, { consent }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results) if (r.status === "rejected") assert.equal((r.reason as VaultError).code, "consent_required");
});

test("S2: a consent spent on one vault is refused by another vault of the same daemon", async () => {
  const backend = createMemoryBackend({ id: "basic_text", protection: "none" });
  const authority = createConsentAuthority();
  const a = createVault({ backend, consent: authority.verifier });
  const b = createVault({ backend, consent: authority.verifier });
  const consent = authority.grantor.grant({ connectionId: "c1", backend: "basic_text" });
  await a.store("c1", SECRET, { consent });
  assert.equal(await code(b.store("c1", OTHER, { consent })), "consent_required");
});

test("S3: a consent is bound to its connection and backend, and a wrong attempt does not spend it", async () => {
  const { vault, consentFor, backend } = setup("basic_text", "none");
  const consent = consentFor("conn-a", "basic_text");
  assert.equal(await code(vault.store("conn-b", SECRET, { consent })), "consent_required", "another connection");
  backend.setInfo({ id: "unknown", protection: "none" });
  assert.equal(await code(vault.store("conn-a", SECRET, { consent })), "consent_required", "another backend");
  backend.setInfo({ id: "basic_text", protection: "none" });
  await vault.store("conn-a", SECRET, { consent }); // still valid for what it was granted for
});

test("S3: a consent expires", async () => {
  const { vault, consentFor, clock } = setup("basic_text", "none");
  const consent = consentFor("c1", "basic_text");
  clock.t += 300_001;
  assert.equal(await code(vault.store("c1", SECRET, { consent })), "consent_required");
});

test("S3: a forged or foreign consent is refused, and there is no free factory to mint one", async () => {
  const { vault, consentFor } = setup("basic_text", "none");
  const forged = { connectionId: "c1", backend: "basic_text", expiresAt: Number.MAX_SAFE_INTEGER };
  assert.equal(await code(vault.store("c1", SECRET, { consent: forged as never })), "consent_required");
  const other = createConsentAuthority().grantor.grant({ connectionId: "c1", backend: "basic_text" });
  assert.equal(await code(vault.store("c1", SECRET, { consent: other })), "consent_required", "another authority's consent");
  assert.ok(!("createWeakStorageConsent" in vaultModule), "no free-standing factory is exported");
  void consentFor;
});

test("S3: a vault without a verifier accepts no consent at all", async () => {
  const backend = createMemoryBackend({ id: "basic_text", protection: "none" });
  const vault = createVault({ backend });
  const consent = createConsentAuthority().grantor.grant({ connectionId: "c1", backend: "basic_text" });
  assert.equal(await code(vault.store("c1", SECRET, { consent })), "consent_required");
});

test("the authority validates what it grants", () => {
  const { grantor } = createConsentAuthority();
  assert.throws(() => grantor.grant({ connectionId: "Bad Id", backend: "basic_text" }), RangeError);
  assert.throws(() => grantor.grant({ connectionId: "c1", backend: "rm" as never }), RangeError);
  assert.throws(() => createConsentAuthority({ ttlMs: 0 }), RangeError);
});

// ------------------------------------------- N-E: consent wiring hardening

test("N-E: the verifier is captured at construction and cannot be swapped through the options object", async () => {
  const backend = createMemoryBackend({ id: "basic_text", protection: "none" });
  const options = { backend, consent: createConsentAuthority().verifier } as { backend: typeof backend; consent: { redeem(): boolean } };
  const vault = createVault(options as never);
  options.consent = { redeem: () => true };
  assert.equal(await code(vault.store("c1", SECRET, { consent: { connectionId: "c1", backend: "basic_text", expiresAt: 1 } as never })), "consent_required");
});

test("N-E: the default consent clock is monotonic, so changing the wall clock cannot extend a consent", async () => {
  const authority = createConsentAuthority({ ttlMs: 40 });
  const consent = authority.grantor.grant({ connectionId: "c1", backend: "basic_text" });
  const real = Date.now;
  Date.now = () => 0; // the wall clock set back
  try {
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(authority.verifier.redeem(consent, { connectionId: "c1", backend: "basic_text" }), false, "expired on the monotonic clock");
  } finally {
    Date.now = real;
  }
});

test("N-E: a consent is spent even when the write then fails, so the approvals UI must ask again", async () => {
  const { vault, backend, consentFor } = setup("basic_text", "none");
  const consent = consentFor("c1", "basic_text");
  backend.put = async () => {
    throw new Error("disk full");
  };
  assert.equal(await code(vault.store("c1", SECRET, { consent })), "backend_failed");
  assert.equal(await code(vault.store("c1", SECRET, { consent })), "consent_required");
});
