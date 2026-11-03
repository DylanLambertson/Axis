// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  BACKEND_IDS,
  VaultError,
  createMemoryBackend,
  createVault,
  createWeakStorageConsent,
  toAxisVaultError,
  type AccessEvent,
  type BackendId,
  type Protection,
} from "../src/index.js";

// Low-entropy stand-in for an API credential.
const SECRET = "vault-test-credential-0001";
const OTHER = "vault-test-credential-0002";

function setup(id: BackendId, protection: Protection, extra: { weakPolicy?: "consent" | "refuse"; events?: AccessEvent[] } = {}) {
  const backend = createMemoryBackend({ id, protection });
  const events = extra.events;
  const vault = createVault({
    backend,
    ...(extra.weakPolicy === undefined ? {} : { weakPolicy: extra.weakPolicy }),
    ...(events === undefined ? {} : { onAccess: (e: AccessEvent) => void events.push(e) }),
    now: () => 1_700_000_000_000,
  });
  return { backend, vault };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof VaultError, "only VaultError escapes");
    return e.code;
  }
  assert.fail("expected a failure");
}

test("PRV-1: os-protected backends store without consent", async () => {
  for (const id of ["macos_keychain", "windows_dpapi", "gnome_libsecret", "kwallet"] as const) {
    const { vault } = setup(id, "os_protected");
    const r = await vault.backend();
    assert.equal(r.policy, "allowed");
    assert.equal(r.persistent, true);
    const info = await vault.store("anthropic-main", SECRET);
    assert.equal(info.backend, id);
    assert.equal(info.weakConsent, false);
    assert.equal(info.protection, "os_protected");
  }
});

test("PRV-1: basic_text and unknown need consent, and report it to the UI", async () => {
  for (const id of ["basic_text", "unknown"] as const) {
    const { vault } = setup(id, "none");
    assert.equal((await vault.backend()).policy, "consent_required");
    assert.equal(await code(vault.store("c1", SECRET)), "consent_required");
    assert.equal(await vault.info("c1"), undefined, "nothing was stored");
    const info = await vault.store("c1", SECRET, { consent: createWeakStorageConsent(id, 1) });
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

test("PRV-1: consent must name the current backend, be issued by the factory, and is spent once", async () => {
  const { vault } = setup("basic_text", "none");
  assert.equal(await code(vault.store("c1", SECRET, { consent: createWeakStorageConsent("unknown", 1) })), "consent_required");
  assert.equal(await code(vault.store("c1", SECRET, { consent: { backend: "basic_text", grantedAt: 1 } })), "consent_required", "a forged object is not consent");
  const consent = createWeakStorageConsent("basic_text", 1);
  await vault.store("c1", SECRET, { consent });
  assert.equal(await code(vault.store("c2", OTHER, { consent })), "consent_required", "consent is spent");
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
  const { vault } = setup("basic_text", "none", { weakPolicy: "refuse" });
  assert.equal((await vault.backend()).policy, "refused");
  assert.equal(await code(vault.store("c1", SECRET, { consent: createWeakStorageConsent("basic_text", 1) })), "backend_refused");
});

test("the memory backend is ephemeral and reported as not persistent", async () => {
  const { vault } = setup("memory", "ephemeral");
  const r = await vault.backend();
  assert.equal(r.persistent, false);
  assert.equal(r.policy, "allowed");
  const info = await vault.store("c1", SECRET);
  assert.equal(info.protection, "ephemeral");
});

test("every backend id is covered by the matrix", () => {
  assert.deepEqual([...BACKEND_IDS].sort(), ["basic_text", "gnome_libsecret", "kwallet", "macos_keychain", "memory", "unknown", "windows_dpapi"]);
});

test("reveal returns the secret and audits without it", async () => {
  const events: AccessEvent[] = [];
  const { vault } = setup("macos_keychain", "os_protected", { events });
  await vault.store("c1", SECRET, { label: "Personal key" });
  assert.equal(await vault.reveal("c1", "provider_request"), SECRET);
  assert.equal(await code(vault.reveal("nope", "provider_request")), "not_found");
  assert.deepEqual(events.map((e) => e.outcome), ["ok", "not_found"]);
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("a throwing audit hook does not change the outcome", async () => {
  const backend = createMemoryBackend({ id: "macos_keychain", protection: "os_protected" });
  const vault = createVault({
    backend,
    onAccess: () => {
      throw new Error("sink down");
    },
  });
  await vault.store("c1", SECRET);
  assert.equal(await vault.reveal("c1", "validate_connection"), SECRET);
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

test("the bridge error carries a code and fixed text only", () => {
  const e = toAxisVaultError(new VaultError("consent_required"), "corr-1");
  assert.equal(e.code, "E_POLICY_DENIED");
  assert.deepEqual(e.details, { vaultCode: "consent_required" });
  assert.equal(toAxisVaultError(new VaultError("not_found"), "c").code, "E_NOT_FOUND");
  assert.equal(toAxisVaultError(new VaultError("backend_failed"), "c").code, "E_UNAVAILABLE");
});
