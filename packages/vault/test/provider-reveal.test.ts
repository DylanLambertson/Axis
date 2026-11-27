// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The provider reveal gate (PV-N0c-1; secret-broker.md §6.1, design review 1 S1). `weakPolicy` decides stores, and before this
// slice nothing checked a provider entry's own metadata on reveal: a provider record that the backend truthfully reports as
// unprotected (a Linux `v10` record) was returned to `validate_connection` at startup and to `provider_request`. Under
// `weakPolicy: "refuse"` (the broker wiring: no consent path, §3.3 and §7) every reveal now checks the metadata of the SAME
// backend read that carries the secret, as integration reveals already do. Under `consent` provider reveals are unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryBackend, createVault, type AccessEvent, type BackendId, type Protection, type SecretPurpose } from "../src/index.js";
import { SECRET, code, setup } from "./support/setup.js";

const PROVIDER_PURPOSES: SecretPurpose[] = ["validate_connection", "provider_request"];
const meta = (backend: BackendId, protection: Protection) => ({ storedAt: 1, backend, protection, weakConsent: false });

test("refuse: a protected provider entry on the current backend is revealed for both purposes", async () => {
  const { vault } = setup("macos_keychain", "os_protected", { weakPolicy: "refuse" });
  await vault.store("c1", SECRET);
  for (const p of PROVIDER_PURPOSES) assert.equal(await vault.reveal("c1", p), SECRET, p);
});

test("refuse: a provider entry whose own metadata is unprotected is refused (weak_entry) at startup validation and in use, audited, and never remembered", async () => {
  for (const [backend, protection] of [["gnome_libsecret", "none"], ["basic_text", "none"], ["unknown", "os_protected"]] as const) {
    const events: AccessEvent[] = [];
    // The current backend reports itself as protected: only the entry's own metadata (as a `v10` record's would) is weak.
    const b = createMemoryBackend({ id: "gnome_libsecret", protection: "os_protected" });
    const vault = createVault({ backend: b, weakPolicy: "refuse", onAccess: (e) => void events.push(e) });
    await b.put("c1", SECRET, meta(backend, protection));
    for (const p of PROVIDER_PURPOSES) assert.equal(await code(vault.reveal("c1", p)), "weak_entry", `${backend}/${protection} ${p}`);
    assert.deepEqual(events.map((e) => [e.purpose, e.outcome]), [["validate_connection", "refused"], ["provider_request", "refused"]]);
    assert.equal(vault.knownSecrets().includes(SECRET), false, "a refused reveal remembers nothing");
  }
});

test("refuse: a provider entry stored under another backend or protection than the current one is refused", async () => {
  const { vault, backend } = setup("macos_keychain", "os_protected", { weakPolicy: "refuse" });
  await vault.store("c1", SECRET);
  backend.setInfo({ id: "gnome_libsecret" });
  assert.equal(await code(vault.reveal("c1", "provider_request")), "weak_entry");
  backend.setInfo({ id: "macos_keychain", protection: "none" });
  assert.equal(await code(vault.reveal("c1", "validate_connection")), "weak_entry", "a locked keyring now reporting no protection");
  backend.setInfo({ protection: "os_protected" });
  assert.equal(await vault.reveal("c1", "provider_request"), SECRET, "back on the backend it was stored under");
});

test("refuse: the check reads the metadata of the get that returned the provider secret", async () => {
  const { vault, backend } = setup("macos_keychain", "os_protected", { weakPolicy: "refuse" });
  await vault.store("c1", SECRET);
  const get = backend.get.bind(backend);
  backend.get = (async (n: string) => {
    const e = await get(n);
    return e === undefined ? undefined : { secret: e.secret, meta: meta("basic_text", "none") };
  }) as typeof backend.get;
  assert.equal(await code(vault.reveal("c1", "provider_request")), "weak_entry");
});

test("consent: provider reveals are unchanged (a weak entry stored with consent is still revealed)", async () => {
  const backend = createMemoryBackend({ id: "basic_text", protection: "none" });
  const vault = createVault({ backend, weakPolicy: "consent" });
  await backend.put("c1", SECRET, meta("basic_text", "none"));
  for (const p of PROVIDER_PURPOSES) assert.equal(await vault.reveal("c1", p), SECRET, p);
});
