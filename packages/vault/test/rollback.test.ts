// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Backend/write consistency and the rollback (S4, SF-2, SF-3, N-C, N-D, N-F, N-I, N-J).
import { test } from "node:test";
import assert from "node:assert/strict";
import { VaultError, type ChangeEvent } from "../src/index.js";
import { OTHER, SECRET, code, setup, type SetupOptions } from "./support/setup.js";

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

// ------------------------------- SF-3, N-I, N-J: the rollback is airtight

/** A backend that breaks the put contract: the write lands on basic_text and `remove` does what `removeBehaviour` says. */
function misbehaving(removeBehaviour: (name: string, real: (n: string) => Promise<boolean>) => Promise<boolean>, extra: SetupOptions = {}) {
  const s = setup("gnome_libsecret", "os_protected", { rollbackTimeoutMs: 60, ...extra });
  s.backend.landWritesOn({ id: "basic_text", protection: "none" }, "write_anyway");
  const real = s.backend.remove.bind(s.backend);
  s.backend.remove = (n) => removeBehaviour(n, real);
  return s;
}

test("SF-3: a remove that returns false and leaves the copy is a failed rollback: quarantined, not revealable, audited", async () => {
  const changes: ChangeEvent[] = [];
  const { vault } = misbehaving(async () => false, { changes });
  assert.equal(await code(vault.store("c1", SECRET)), "backend_changed");
  const info = await vault.info("c1");
  assert.equal(info?.protection, "none");
  assert.equal(info?.backend, "basic_text");
  assert.equal(info?.backendChanged, true);
  assert.equal(await code(vault.reveal("c1", "provider_request")), "backend_changed");
  assert.deepEqual(changes.map((c) => c.outcome), ["rollback_failed"]);
});

test("N-J: the rollback_failed event names where the copy actually landed", async () => {
  const changes: ChangeEvent[] = [];
  const { vault } = misbehaving(async () => false, { changes });
  await code(vault.store("c1", SECRET));
  assert.equal(changes[0]?.landedOn, "basic_text");
  assert.equal(changes[0]?.landedProtection, "none");
  assert.equal(changes[0]?.backend, "gnome_libsecret", "and still what was decided");
  assert.ok(!JSON.stringify(changes).includes(SECRET));
});

test("SF-3: a remove that returns false because the copy was never there is a clean rollback", async () => {
  const { vault, backend } = setup("gnome_libsecret", "os_protected");
  backend.landWritesOn({ id: "basic_text", protection: "none" }, "write_anyway");
  backend.remove = async (n) => {
    await backend.corruptMeta(n, undefined); // the entry is gone from the backend's point of view
    return false;
  };
  backend.meta = async () => undefined;
  assert.equal(await code(vault.store("c1", SECRET)), "backend_changed");
  backend.landWritesOn(undefined);
  assert.equal((await vault.store("c1", SECRET)).protection, "os_protected");
});

test("SF-3: a remove that hangs ends in quarantine, and the copy is already shown as weak while it hangs", async () => {
  const { vault } = misbehaving(() => new Promise<boolean>(() => undefined));
  const stored = vault.store("c1", SECRET).then(
    () => "stored",
    (e: unknown) => (e as VaultError).code,
  );
  await new Promise((r) => setTimeout(r, 20)); // inside the first removal attempt
  assert.equal((await vault.info("c1"))?.protection, "none", "shown as weak at once");
  assert.equal(await code(vault.reveal("c1", "provider_request")), "backend_changed", "and not handed out while the removal hangs");
  assert.equal(await stored, "backend_changed", "the store ends instead of hanging forever");
  assert.equal((await vault.info("c1"))?.protection, "none");
});

test("SF-3: a reveal already in flight does not hand out a copy that is quarantined while it reads", async () => {
  const { vault, backend } = setup("gnome_libsecret", "os_protected", { rollbackTimeoutMs: 50 });
  await vault.store("c1", OTHER);
  // A slow read starts while nothing is wrong.
  const get = backend.get.bind(backend);
  let release: (() => void) | undefined;
  backend.get = async (n) => {
    const entry = await get(n);
    await new Promise<void>((r) => {
      release = r;
    });
    return entry;
  };
  const pending = vault.reveal("c1", "provider_request").then(
    () => "revealed",
    (e: unknown) => (e as VaultError).code,
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(release !== undefined, "the read is in flight");
  // Meanwhile a store lands weakly and cannot be rolled back.
  backend.landWritesOn({ id: "basic_text", protection: "none" }, "write_anyway");
  backend.remove = async () => false;
  assert.equal(await code(vault.store("c1", SECRET)), "backend_changed");
  release?.();
  assert.equal(await pending, "backend_changed", "the read that started earlier does not return the weak copy");
});

test("SF-3: remove() clears the quarantine only when the copy is really gone", async () => {
  const { vault, backend } = misbehaving(async () => false);
  await code(vault.store("c1", SECRET));
  backend.remove = async () => false; // still not removing anything
  await vault.remove("c1");
  assert.equal((await vault.info("c1"))?.protection, "none", "still quarantined");
  backend.remove = async (n) => {
    backend.meta = async () => undefined;
    void n;
    return true;
  };
  assert.equal(await vault.remove("c1"), true);
});

test("N-I: concurrent stores of one connection run one at a time, so a late good write cannot clear a quarantine", async () => {
  const { vault, backend } = setup("gnome_libsecret", "os_protected", { rollbackTimeoutMs: 50 });
  let call = 0;
  const realPut = backend.put.bind(backend);
  backend.remove = async () => false;
  backend.put = async (n, secret, meta) => {
    call += 1;
    await realPut(n, secret, meta);
    if (call === 1) {
      await new Promise((r) => setTimeout(r, 40)); // store A acknowledges late, with a good write
      return { id: "gnome_libsecret", protection: "os_protected" };
    }
    return { id: "basic_text", protection: "none" }; // store B's write lands weakly
  };
  const [a, b] = await Promise.allSettled([vault.store("c1", SECRET), vault.store("c1", OTHER)]);
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "rejected");
  assert.equal((await vault.info("c1"))?.protection, "none", "B's weak copy is what is stored, and it is shown as weak");
  assert.equal(await code(vault.reveal("c1", "provider_request")), "backend_changed");
});
