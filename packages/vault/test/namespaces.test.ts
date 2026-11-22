// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Integration entries (ADR 0009 decision 5, ticket PV-N1c): the name rule, entry kinds and the purpose-to-kind binding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { INTEGRATION_PREFIX, NAME_RE, PROVIDER_NAME_RE, PURPOSE_KIND, SECRET_PURPOSES, entryKind, toAxisVaultError, VaultError, type AccessEvent, type SecretPurpose } from "../src/index.js";
import { SECRET, code, setup } from "./support/setup.js";

const PROVIDER_PURPOSES: SecretPurpose[] = ["provider_request", "validate_connection"];
const INTEGRATION_PURPOSES: SecretPurpose[] = ["integration_request", "integration_refresh", "integration_validate"];

test("the name rule: a provider id, or integration: and an id under the same rule, and nothing else", () => {
  for (const ok of ["c1", "anthropic.main", "integration:github", "integration:a", `integration:${"x".repeat(64)}`, "integration"]) {
    assert.equal(NAME_RE.test(ok), true, ok);
  }
  for (const bad of ["integration:", "integration:A", "Integration:x", "integrations:x", "x:integration", "integration:integration:x", "provider:x", "integration::x", "integration:-x", `integration:${"x".repeat(65)}`, ":x", "integration: x"]) {
    assert.equal(NAME_RE.test(bad), false, bad);
  }
  assert.equal(`${INTEGRATION_PREFIX}${"x".repeat(64)}`.length <= 100, true, "within the secret broker's 100-character cap");
  assert.equal(PROVIDER_NAME_RE.test("integration:github"), false);
  assert.equal(PROVIDER_NAME_RE.source, "^[a-z0-9][a-z0-9._-]{0,63}$");
});

test("entry kinds: only the integration: prefix makes an integration entry", () => {
  assert.equal(entryKind("integration:github"), "integration");
  assert.equal(entryKind("integration"), "provider");
  assert.equal(entryKind("c1"), "provider");
  assert.equal(entryKind("integrationx"), "provider");
});

test("every purpose names exactly one kind, and the two lists split as decided", () => {
  assert.deepEqual(Object.keys(PURPOSE_KIND).sort(), [...SECRET_PURPOSES].sort());
  for (const p of PROVIDER_PURPOSES) assert.equal(PURPOSE_KIND[p], "provider", p);
  for (const p of INTEGRATION_PURPOSES) assert.equal(PURPOSE_KIND[p], "integration", p);
  assert.equal(Object.isFrozen(PURPOSE_KIND), true);
});

test("a purpose reveals only its own kind: a mismatch is refused, audited, and never reaches the backend", async () => {
  const events: AccessEvent[] = [];
  const { vault, backend } = setup("macos_keychain", "os_protected", { events });
  await vault.store("c1", SECRET);
  await vault.store("integration:github", SECRET);
  let reads = 0;
  const get = backend.get.bind(backend);
  backend.get = (async (name: string) => {
    reads += 1;
    return get(name);
  }) as typeof backend.get;
  for (const p of INTEGRATION_PURPOSES) assert.equal(await code(vault.reveal("c1", p)), "wrong_entry_kind", p);
  for (const p of PROVIDER_PURPOSES) assert.equal(await code(vault.reveal("integration:github", p)), "wrong_entry_kind", p);
  assert.equal(reads, 0, "a refused purpose reads nothing");
  assert.deepEqual(events.map((e) => e.outcome), ["refused", "refused", "refused", "refused", "refused"]);
  assert.deepEqual(events.map((e) => e.purpose), [...INTEGRATION_PURPOSES, ...PROVIDER_PURPOSES]);
  for (const p of PROVIDER_PURPOSES) assert.equal(await vault.reveal("c1", p), SECRET, p);
  for (const p of INTEGRATION_PURPOSES) assert.equal(await vault.reveal("integration:github", p), SECRET, p);
  assert.equal(reads, 5);
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("integration entries store, list, describe and remove like provider entries", async () => {
  const { vault } = setup("macos_keychain", "os_protected");
  await vault.store("integration:github", SECRET);
  await vault.store("c1", SECRET);
  assert.deepEqual((await vault.list()).map((c) => c.connectionId).sort(), ["c1", "integration:github"]);
  assert.equal((await vault.info("integration:github"))?.connectionId, "integration:github");
  assert.equal(await vault.remove("integration:github"), true);
  assert.equal(await code(vault.reveal("integration:github", "integration_request")), "not_found");
  assert.equal(await code(vault.store("integration:Bad", SECRET)), "invalid_name");
});

test("wrong_entry_kind is a fixed invalid-argument error", () => {
  const e = new VaultError("wrong_entry_kind");
  const axis = toAxisVaultError(e, "corr-1");
  assert.equal(axis.code, "E_INVALID_ARGUMENT");
  assert.equal(axis.message, "This credential cannot be read for that purpose.");
});

test("list stays strict by design: one bad name fails the whole list (PV-N0c's backend filters before the vault; do not relax)", async () => {
  const { vault, backend } = setup("macos_keychain", "os_protected");
  await vault.store("c1", SECRET);
  backend.list = (async () => [{ name: "c1", meta: {} }, { name: "integration:Bad", meta: {} }]) as never;
  assert.equal(await code(vault.list()), "backend_failed");
});
