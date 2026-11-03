// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import * as vaultModule from "../src/index.js";
import {
  BACKEND_IDS,
  VaultError,
  createConsentAuthority,
  createMemoryBackend,
  createVault,
  toAxisVaultError,
  type AccessEvent,
  type BackendId,
  type ChangeEvent,
  type Protection,
} from "../src/index.js";

// Low-entropy stand-ins for API credentials.
const SECRET = "vault-test-credential-0001";
const OTHER = "vault-test-credential-0002";

interface SetupOptions {
  weakPolicy?: "consent" | "refuse";
  events?: AccessEvent[];
  changes?: ChangeEvent[];
  clock?: { t: number };
}

function setup(id: BackendId, protection: Protection, extra: SetupOptions = {}) {
  const backend = createMemoryBackend({ id, protection });
  const clock = extra.clock ?? { t: 1_700_000_000_000 };
  const authority = createConsentAuthority({ now: () => clock.t });
  const events = extra.events;
  const changes = extra.changes;
  const vault = createVault({
    backend,
    consent: authority.verifier,
    ...(extra.weakPolicy === undefined ? {} : { weakPolicy: extra.weakPolicy }),
    ...(events === undefined ? {} : { onAccess: (e: AccessEvent) => void events.push(e) }),
    ...(changes === undefined ? {} : { onChange: (e: ChangeEvent) => void changes.push(e) }),
    now: () => clock.t,
  });
  const consentFor = (connectionId: string, backendId: BackendId) => authority.grantor.grant({ connectionId, backend: backendId });
  return { backend, vault, authority, consentFor, clock };
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

// ------------------------------------------------------------ S4: TOCTOU

test("S4: a backend that honours the put contract refuses a write that would land elsewhere, and nothing is stored", async () => {
  const { vault, backend } = setup("gnome_libsecret", "os_protected");
  backend.landWritesOn({ id: "basic_text", protection: "none" });
  assert.equal(await code(vault.store("c1", SECRET)), "backend_failed");
  assert.equal(await backend.get("c1"), undefined);
  assert.ok(vault.knownSecrets().includes(SECRET), "still redacted");
  backend.landWritesOn(undefined);
  assert.equal((await vault.store("c1", SECRET)).protection, "os_protected");
});

test("N-D: a refused rotation leaves the previous key in place", async () => {
  const { vault, backend } = setup("gnome_libsecret", "os_protected");
  await vault.store("c1", SECRET);
  backend.landWritesOn({ id: "basic_text", protection: "none" });
  assert.equal(await code(vault.store("c1", OTHER)), "backend_failed");
  backend.landWritesOn(undefined);
  assert.equal(await vault.reveal("c1", "provider_request"), SECRET);
});

test("S4: a backend that writes anyway is rolled back as backend_changed", async () => {
  const { vault, backend } = setup("gnome_libsecret", "os_protected");
  backend.landWritesOn({ id: "basic_text", protection: "none" }, "write_anyway");
  assert.equal(await code(vault.store("c1", SECRET)), "backend_changed");
  assert.equal(await backend.get("c1"), undefined, "the weakly stored copy was removed");
  assert.equal(await vault.info("c1"), undefined);
  assert.ok(vault.knownSecrets().includes(SECRET), "still redacted");
});

test("SF-2: a rollback that fails once is retried", async () => {
  const { vault, backend } = setup("gnome_libsecret", "os_protected");
  backend.landWritesOn({ id: "basic_text", protection: "none" }, "write_anyway");
  const remove = backend.remove.bind(backend);
  let calls = 0;
  backend.remove = async (n) => {
    if (++calls === 1) throw new Error("transient");
    return remove(n);
  };
  assert.equal(await code(vault.store("c1", SECRET)), "backend_changed");
  assert.equal(calls, 2);
  assert.equal(await backend.get("c1"), undefined);
  assert.equal(await vault.info("c1"), undefined);
});

test("SF-2: when the rollback cannot remove the copy, it is shown as weak, never revealed, and audited", async () => {
  const changes: ChangeEvent[] = [];
  const { vault, backend } = setup("gnome_libsecret", "os_protected", { changes });
  backend.landWritesOn({ id: "basic_text", protection: "none" }, "write_anyway");
  backend.remove = async () => {
    throw new Error(`remove failed for ${SECRET}`);
  };
  assert.equal(await code(vault.store("c1", SECRET)), "backend_changed");
  const info = await vault.info("c1");
  assert.equal(info?.backend, "basic_text");
  assert.equal(info?.protection, "none", "not shown as protected");
  assert.equal(info?.backendChanged, true);
  assert.equal(info?.weakConsent, false);
  assert.equal((await vault.list())[0]?.protection, "none");
  assert.equal(await code(vault.reveal("c1", "provider_request")), "backend_changed", "the weak copy is not handed out");
  assert.deepEqual(changes.map((c) => c.outcome), ["rollback_failed"]);
  assert.ok(!JSON.stringify(changes).includes(SECRET));
  // A good store afterwards clears it.
  backend.landWritesOn(undefined);
  await vault.store("c1", OTHER);
  assert.equal((await vault.info("c1"))?.protection, "os_protected");
  assert.equal(await vault.reveal("c1", "provider_request"), OTHER);
});

test("N-C: a backend that does not say where it wrote is rolled back, even when the decision was unknown", async () => {
  const { vault, backend, consentFor } = setup("unknown", "none");
  const put = backend.put.bind(backend);
  backend.put = (async (...a: Parameters<typeof put>) => {
    await put(...a);
    return undefined;
  }) as never;
  assert.equal(await code(vault.store("c1", SECRET, { consent: consentFor("c1", "unknown") })), "backend_changed");
  assert.equal(await backend.get("c1"), undefined);
});

test("N-F: a backend that now reports less protection counts as changed, even with the same id", async () => {
  const { vault, backend } = setup("gnome_libsecret", "os_protected");
  await vault.store("c1", SECRET);
  assert.equal((await vault.info("c1"))?.backendChanged, false);
  backend.setInfo({ protection: "none" }); // a locked collection
  assert.equal((await vault.info("c1"))?.backendChanged, true);
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
