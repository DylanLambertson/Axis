// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The integration reveal gate (docs/design/net-read-slice.md §4 step 4, review 1 S3): an `integration_request` reveal checks
// the metadata of the SAME backend read that carries the secret, so a weak, unprotected or moved entry is never handed out,
// whatever `weakPolicy` says (that governs stores). Provider reveals are unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VaultError, createMemoryBackend, createVault, toAxisVaultError, type AccessEvent, type BackendId, type Protection, type SecretPurpose } from "../src/index.js";
import { SECRET, code, setup } from "./support/setup.js";

const NAME = "integration:github";
const INTEGRATION_PURPOSES: SecretPurpose[] = ["integration_request", "integration_refresh", "integration_validate"];
const meta = (backend: BackendId, protection: Protection) => ({ storedAt: 1, backend, protection, weakConsent: false });

test("a protected entry on the current backend is revealed for every integration purpose", async () => {
  const { vault } = setup("macos_keychain", "os_protected");
  await vault.store(NAME, SECRET);
  for (const p of INTEGRATION_PURPOSES) assert.equal(await vault.reveal(NAME, p), SECRET, p);
});

test("an entry whose own metadata is weak is refused (weak_entry), audited, and its secret is never returned", async () => {
  for (const [backend, protection] of [["basic_text", "none"], ["unknown", "os_protected"], ["macos_keychain", "none"], ["windows_dpapi", "ephemeral"]] as const) {
    const events: AccessEvent[] = [];
    const { vault, backend: b } = setup("macos_keychain", "os_protected", { events });
    await vault.store(NAME, SECRET);
    b.corruptMeta(NAME, meta(backend, protection));
    // The current backend still reports itself as protected: only the entry's own metadata is weak.
    assert.equal(await code(vault.reveal(NAME, "integration_request")), "weak_entry", `${backend}/${protection}`);
    assert.deepEqual(events.map((e) => e.outcome), ["refused"]);
    assert.equal(vault.knownSecrets().includes(SECRET), true, "it was stored in this process");
  }
});

test("a weak entry is refused even with weakPolicy refuse, and a weak backend's entry is refused whatever it claims", async () => {
  const backend = createMemoryBackend({ id: "basic_text", protection: "none" });
  const vault = createVault({ backend, weakPolicy: "refuse" });
  await backend.put(NAME, SECRET, meta("basic_text", "none"));
  assert.equal(await code(vault.reveal(NAME, "integration_request")), "weak_entry");
  assert.equal(vault.knownSecrets().includes(SECRET), false, "a refused reveal remembers nothing");
});

test("an entry stored under another backend than the current one is refused", async () => {
  const { vault, backend } = setup("macos_keychain", "os_protected");
  await vault.store(NAME, SECRET);
  backend.setInfo({ id: "gnome_libsecret" });
  assert.equal(await code(vault.reveal(NAME, "integration_request")), "weak_entry");
  backend.setInfo({ id: "macos_keychain", protection: "none" });
  assert.equal(await code(vault.reveal(NAME, "integration_request")), "weak_entry", "the same backend now reporting no protection (a locked keyring)");
  backend.setInfo({ protection: "os_protected" });
  assert.equal(await vault.reveal(NAME, "integration_request"), SECRET, "back on the backend it was stored under");
});

test("the check reads the metadata of the get that returned the secret, not an earlier one", async () => {
  const { vault, backend } = setup("macos_keychain", "os_protected");
  await vault.store(NAME, SECRET);
  const get = backend.get.bind(backend);
  let metaReads = 0;
  const metaOf = backend.meta.bind(backend);
  backend.meta = (async (n: string) => (metaReads++, metaOf(n))) as typeof backend.meta;
  // Between any earlier metadata read and the secret's read, the entry moves to a weak copy.
  backend.get = (async (n: string) => {
    const e = await get(n);
    return e === undefined ? undefined : { secret: e.secret, meta: meta("basic_text", "none") };
  }) as typeof backend.get;
  assert.equal(await code(vault.reveal(NAME, "integration_request")), "weak_entry");
  assert.equal(metaReads, 0, "no separate metadata read stands in for the revealed entry's own");
});

test("an entry with bad metadata is a backend failure, never a reveal", async () => {
  const { vault, backend } = setup("macos_keychain", "os_protected");
  await vault.store(NAME, SECRET);
  backend.corruptMeta(NAME, { backend: "macos_keychain" });
  assert.equal(await code(vault.reveal(NAME, "integration_request")), "backend_failed");
});

test("provider reveals are unchanged: a weak provider entry stored with consent is still revealed", async () => {
  const backend = createMemoryBackend({ id: "basic_text", protection: "none" });
  const vault = createVault({ backend });
  await backend.put("c1", SECRET, meta("basic_text", "none"));
  assert.equal(await vault.reveal("c1", "provider_request"), SECRET);
});

test("weak_entry is a fixed conflict error naming no secret", () => {
  const axis = toAxisVaultError(new VaultError("weak_entry"), "corr-1");
  assert.equal(axis.code, "E_CONFLICT");
  assert.equal(axis.message, "This credential is not held in protected storage; connect again.");
});
