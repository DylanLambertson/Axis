// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PRV-1 backend policy and reported protection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKEND_IDS, createMemoryBackend, createVault } from "../src/index.js";
import { OTHER, SECRET, code, setup } from "./support/setup.js";

// ------------------------------------------------------------------- PRV-1

test("PRV-1: os-protected backends store without consent, including KDE's kwallet5 and kwallet6 (S5)", async () => {
  for (const id of ["macos_keychain", "windows_dpapi", "gnome_libsecret", "kwallet", "kwallet5", "kwallet6"] as const) {
    const { vault } = setup(id, "os_protected");
    const r = await vault.backend();
    assert.equal(r.policy, "allowed", id);
    assert.equal(r.persistent, true);
    const info = await vault.store("anthropic-main", SECRET);
    assert.equal(info.backend, id);
    assert.equal(info.weakConsent, false);
    assert.equal(info.protection, "os_protected");
  }
});

test("PRV-1: basic_text and unknown need consent, and report it to the UI", async () => {
  for (const id of ["basic_text", "unknown"] as const) {
    const { vault, consentFor } = setup(id, "none");
    assert.equal((await vault.backend()).policy, "consent_required");
    assert.equal(await code(vault.store("c1", SECRET)), "consent_required");
    assert.equal(await vault.info("c1"), undefined, "nothing was stored");
    const info = await vault.store("c1", SECRET, { consent: consentFor("c1", id) });
    assert.equal(info.weakConsent, true);
    assert.equal(info.protection, "none");
    assert.equal(info.backend, id);
  }
});

test("PRV-1: a backend that lies about being protected is still weak when it is basic_text or unknown", async () => {
  for (const id of ["basic_text", "unknown"] as const) {
    const { vault } = setup(id, "os_protected");
    assert.equal((await vault.backend()).protection, "none");
    assert.equal(await code(vault.store("c1", SECRET)), "consent_required");
  }
});

test("PRV-1: a malformed backend answer fails closed", async () => {
  const backend = createMemoryBackend();
  const vault = createVault({ backend: { ...backend, info: async () => ({ id: "rm-rf", protection: "yes", label: 5 }) as never } });
  const r = await vault.backend();
  assert.equal(r.id, "unknown");
  assert.equal(r.policy, "consent_required");
});

test("PRV-1: the backend is checked on every store, not cached", async () => {
  const { vault, backend } = setup("gnome_libsecret", "os_protected");
  await vault.store("c1", SECRET);
  backend.setInfo({ id: "basic_text", protection: "none" });
  assert.equal(await code(vault.store("c2", OTHER)), "consent_required");
  const info = await vault.info("c1");
  assert.equal(info?.backendChanged, true, "the UI can prompt a re-store");
  backend.setInfo({ id: "gnome_libsecret", protection: "os_protected" });
  assert.equal((await vault.info("c1"))?.backendChanged, false);
});

test("PRV-1: weakPolicy refuse refuses a weak backend even with consent", async () => {
  const { vault, consentFor } = setup("basic_text", "none", { weakPolicy: "refuse" });
  assert.equal((await vault.backend()).policy, "refused");
  assert.equal(await code(vault.store("c1", SECRET, { consent: consentFor("c1", "basic_text") })), "backend_refused");
});

test("the memory backend is ephemeral and reported as not persistent", async () => {
  const { vault } = setup("memory", "ephemeral");
  const r = await vault.backend();
  assert.equal(r.persistent, false);
  assert.equal(r.policy, "allowed");
  assert.equal((await vault.store("c1", SECRET)).protection, "ephemeral");
});

test("every backend id is covered by the matrix", () => {
  assert.deepEqual([...BACKEND_IDS].sort(), ["basic_text", "gnome_libsecret", "kwallet", "kwallet5", "kwallet6", "macos_keychain", "memory", "unknown", "windows_dpapi"]);
});

// ---------------------------------------- S5: protection is what was reported

test("S5: a backend that reports itself ephemeral still needs consent, unless it is the memory backend", async () => {
  for (const id of ["kwallet", "gnome_libsecret", "windows_dpapi", "macos_keychain"] as const) {
    const { vault } = setup(id, "ephemeral");
    const r = await vault.backend();
    assert.equal(r.policy, "consent_required", id);
    assert.equal(r.persistent, true, "it is not treated as the memory backend");
    assert.equal(await code(vault.store("c1", SECRET)), "consent_required");
  }
});

test("S5: the protection the UI shows is what the backend reported, not a guess from its name", async () => {
  // gnome_libsecret reporting no protection (for example a locked collection) needs consent and is shown as unprotected.
  const { vault, consentFor } = setup("gnome_libsecret", "none");
  assert.equal(await code(vault.store("c1", SECRET)), "consent_required");
  const info = await vault.store("c1", SECRET, { consent: consentFor("c1", "gnome_libsecret") });
  assert.equal(info.protection, "none");
  assert.equal(info.weakConsent, true);
  assert.equal((await vault.info("c1"))?.protection, "none");
  assert.equal((await vault.list())[0]?.protection, "none");
});
