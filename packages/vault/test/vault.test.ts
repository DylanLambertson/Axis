// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Reveal, audit, info, untrusted backend data, known secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { VaultError, createMemoryBackend, createVault, toAxisVaultError, type AccessEvent, type ChangeEvent } from "../src/index.js";
import { OTHER, SECRET, code, setup } from "./support/setup.js";

// -------------------------------------------------- reveal, audit and info

test("reveal returns the secret and audits without it", async () => {
  const events: AccessEvent[] = [];
  const { vault } = setup("macos_keychain", "os_protected", { events });
  await vault.store("c1", SECRET, { label: "Personal key" });
  assert.equal(await vault.reveal("c1", "provider_request"), SECRET);
  assert.equal(await code(vault.reveal("nope", "provider_request")), "not_found");
  assert.deepEqual(events.map((e) => e.outcome), ["ok", "not_found"]);
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("N11: stores and removals are audited, refusals included, without the secret", async () => {
  const changes: ChangeEvent[] = [];
  const { vault, consentFor } = setup("basic_text", "none", { changes });
  await code(vault.store("c1", SECRET));
  await vault.store("c1", SECRET, { consent: consentFor("c1", "basic_text") });
  await vault.remove("c1");
  assert.deepEqual(
    changes.map((c) => [c.action, c.outcome, c.weakConsent ?? null]),
    [["store", "refused", false], ["store", "ok", true], ["remove", "ok", null]],
  );
  assert.equal(changes[1]?.backend, "basic_text");
  assert.ok(!JSON.stringify(changes).includes(SECRET));
});

test("a throwing audit hook does not change the outcome", async () => {
  const backend = createMemoryBackend({ id: "macos_keychain", protection: "os_protected" });
  const vault = createVault({
    backend,
    onAccess: () => {
      throw new Error("sink down");
    },
    onChange: () => {
      throw new Error("sink down");
    },
  });
  await vault.store("c1", SECRET);
  assert.equal(await vault.reveal("c1", "validate_connection"), SECRET);
  assert.ok(await vault.remove("c1"));
});

test("info and list never contain the secret, a prefix or a length", async () => {
  const { vault } = setup("macos_keychain", "os_protected");
  await vault.store("c1", SECRET, { label: "Work" });
  const views = [JSON.stringify(await vault.info("c1")), JSON.stringify(await vault.list()), inspect(vault, { depth: 5, showHidden: true }), JSON.stringify(vault)];
  for (const v of views) {
    assert.ok(!v.includes(SECRET));
    assert.ok(!v.includes(SECRET.slice(0, 8)));
  }
  const info = await vault.info("c1");
  assert.deepEqual(Object.keys(info ?? {}).sort(), ["backend", "backendChanged", "connectionId", "label", "protection", "storedAt", "weakConsent"]);
});

test("input checks: connection ids, secrets, labels and purposes", async () => {
  const { vault } = setup("macos_keychain", "os_protected");
  for (const bad of ["", "A", "../x", "a b", "x".repeat(65), "-a"]) assert.equal(await code(vault.store(bad, SECRET)), "invalid_name");
  for (const bad of ["short", "has space in it", "line\nbreak-secret", "x".repeat(4097), "tab\tsecret-value"]) {
    assert.equal(await code(vault.store("c1", bad)), "invalid_secret");
  }
  assert.equal(await code(vault.store("c1", SECRET, { label: "bad\nlabel" })), "invalid_secret");
  assert.equal(await code(vault.reveal("c1", "anything" as never)), "invalid_secret");
});

test("a backend failure becomes a fixed error that never echoes the backend's text or the secret", async () => {
  const { vault, backend } = setup("macos_keychain", "os_protected");
  await vault.store("c1", SECRET);
  backend.failWith(`keychain says no for ${SECRET}`);
  for (const op of [vault.store("c2", OTHER), vault.reveal("c1", "provider_request"), vault.info("c1"), vault.list(), vault.remove("c1"), vault.backend()]) {
    try {
      await op;
      assert.fail("expected failure");
    } catch (e) {
      assert.ok(e instanceof VaultError);
      assert.equal(e.code, "backend_failed");
      for (const s of [e.message, String(e), JSON.stringify(e), inspect(e, { showHidden: true, depth: 5 })]) {
        assert.ok(!s.includes(SECRET) && !s.includes(OTHER));
      }
    }
  }
});

// ------------------------------------------- N9: backend data is untrusted

test("N9: bad entry metadata from a backend is a fixed backend failure, never raw text or unvalidated fields", async () => {
  const { vault, backend } = setup("macos_keychain", "os_protected");
  await vault.store("c1", SECRET);
  const hostile = {
    get backend(): never {
      throw new Error(`getter blew up with ${SECRET}`);
    },
  };
  const cases: unknown[] = [
    hostile,
    { backend: "made-up-backend", protection: "os_protected", storedAt: 1, weakConsent: false },
    { backend: "macos_keychain", protection: "os_protected", storedAt: 1, weakConsent: "yes" },
    { backend: "macos_keychain", protection: "os_protected", storedAt: 1, weakConsent: false, label: "evil‮label\nline" },
    { backend: "macos_keychain", protection: "os_protected", storedAt: Number.NaN, weakConsent: false },
    "a string",
  ];
  for (const raw of cases) {
    backend.corruptMeta("c1", raw);
    for (const op of [vault.info("c1"), vault.list()]) {
      try {
        await op;
        assert.fail("expected failure");
      } catch (e) {
        assert.ok(e instanceof VaultError);
        assert.equal(e.code, "backend_failed");
        assert.ok(!e.message.includes(SECRET) && !inspect(e, { showHidden: true }).includes(SECRET));
      }
    }
  }
});

test("N9: a backend list that is not a list of valid names is a fixed failure", async () => {
  const { vault, backend } = setup("macos_keychain", "os_protected");
  backend.list = (async () => [{ name: "../escape", meta: {} }]) as never;
  assert.equal(await code(vault.list()), "backend_failed");
  backend.list = (async () => "nope") as never;
  assert.equal(await code(vault.list()), "backend_failed");
});

// -------------------------------------------------------- known secrets

test("knownSecrets keeps rotated and removed secrets for redaction", async () => {
  const { vault } = setup("macos_keychain", "os_protected");
  await vault.store("c1", SECRET);
  await vault.store("c1", OTHER); // rotation
  assert.equal(await vault.reveal("c1", "provider_request"), OTHER);
  assert.ok(await vault.remove("c1"));
  assert.deepEqual([...vault.knownSecrets()].sort(), [OTHER, SECRET].sort());
  assert.equal(await vault.info("c1"), undefined);
});

test("a secret from a failed write is still known, so a failure that echoes it is redacted", async () => {
  const { vault, backend } = setup("macos_keychain", "os_protected");
  backend.put = async () => {
    throw new Error("disk full");
  };
  assert.equal(await code(vault.store("c1", SECRET)), "backend_failed");
  assert.ok(vault.knownSecrets().includes(SECRET));
});

test("N10: a stored secret is never forgotten, however many others pass through", async () => {
  const { vault } = setup("macos_keychain", "os_protected");
  await vault.store("real", SECRET);
  for (let i = 0; i < 2_000; i++) await vault.store(`junk-${i % 7}`, `junk-secret-value-${String(i).padStart(5, "0")}`);
  assert.ok(vault.knownSecrets().includes(SECRET), "the live key is still redacted");
  assert.ok(vault.knownSecrets().length <= 1_030, "old secrets that are gone are bounded");
});

test("the bridge error carries a code and fixed text only", () => {
  const e = toAxisVaultError(new VaultError("consent_required"), "corr-1");
  assert.equal(e.code, "E_POLICY_DENIED");
  assert.deepEqual(e.details, { vaultCode: "consent_required" });
  assert.equal(toAxisVaultError(new VaultError("not_found"), "c").code, "E_NOT_FOUND");
  assert.equal(toAxisVaultError(new VaultError("backend_failed"), "c").code, "E_UNAVAILABLE");
  assert.equal(toAxisVaultError(new VaultError("backend_changed"), "c").code, "E_CONFLICT");
});
