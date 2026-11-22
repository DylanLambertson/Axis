// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Main's secret broker store (ticket PV-N0a, docs/design/secret-broker.md §3): a fake cipher and in-memory files.
import assert from "node:assert/strict";
import { test } from "node:test";
import { secretsResultSchema } from "../src/control/secrets-messages.js";
import { base64, createSecretStore, fileOf, nameOf, unbase64, type CipherBackend, type SecretAnswer, type SecretCipher, type SecretFiles, type SecretRequest, type SecretTimers } from "../src/main/secret-store.js";

const SECRET = "test-credential-value-0001";

/** A reversible fake: `prefix` + the plain bytes with every byte + 1. */
function fakeCipher(backend: CipherBackend = "gnome_libsecret", prefix = "v11", available = true) {
  const c = {
    backend,
    prefix,
    available,
    decrypts: 0,
    status: () => ({ available: c.available, backend: c.backend }),
    encrypt(plain: string): Uint8Array {
      const body = [...plain].map((ch) => (ch.charCodeAt(0) + 1) & 255);
      return Uint8Array.from([...[...c.prefix].map((ch) => ch.charCodeAt(0)), ...body]);
    },
    decrypt(data: Uint8Array): string {
      c.decrypts += 1;
      return String.fromCharCode(...[...data.slice(3)].map((b) => (b - 1) & 255));
    },
  };
  return c satisfies SecretCipher;
}

function memFiles() {
  const store = new Map<string, Uint8Array>();
  const f = {
    store,
    failCheck: false,
    writes: 0,
    check: () => (f.failCheck ? Promise.reject(new Error("unusable")) : Promise.resolve()),
    read: (file: string) => Promise.resolve(store.get(file) ?? null),
    write: (file: string, data: Uint8Array) => (f.writes++, store.set(file, data), Promise.resolve()),
    remove: (file: string) => Promise.resolve(store.delete(file)),
    names: () => Promise.resolve([...store.keys()]),
    cleanup: () => Promise.resolve(0),
  };
  return f satisfies SecretFiles;
}

const realTimers: SecretTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
const meta = (backend = "gnome_libsecret", protection = "os_protected") => ({ storedAt: 1, backend, protection, weakConsent: false });

function rig(platform = "linux", cipher = fakeCipher(), files = memFiles()) {
  const events: string[] = [];
  const store = createSecretStore({ cipher, files, platform, timers: realTimers, onEvent: (e) => events.push(e) });
  return { store, cipher, files, events };
}

const put = (name: string, secret = SECRET, m = meta()): SecretRequest => ({ type: "secrets.put", name, secret, meta: m });
const err = (a: SecretAnswer): string => (a.ok ? "ok" : a.error);

test("file names are the canonical lower-case hex of the name, and only that form maps back", () => {
  assert.equal(fileOf("c1"), "6331.v1");
  assert.equal(nameOf("6331.v1"), "c1");
  assert.equal(nameOf(fileOf("integration:github")), "integration:github");
  for (const bad of ["6331.V1", "6331.v2", "6G31.v1", "63.31.v1", "4331.v1", ".6331.v1.tmp-0123456789ab", "6331", "2e2e2f78.v1"]) assert.equal(nameOf(bad), null, bad);
  assert.equal(nameOf("6331.v1".toUpperCase()), null);
  assert.equal(fileOf("x".repeat(100)).length, 203, "a 100-character name is a 203-character file name");
});

test("base64 round-trips and refuses anything not canonical", () => {
  for (let n = 0; n < 40; n++) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
    assert.deepEqual(unbase64(base64(b)), b);
    assert.equal(base64(b), Buffer.from(b).toString("base64"));
  }
  for (const bad of ["a", "ab=c", "a===", "YQ", "YR==", "Y Q==", "YQ==\n"]) assert.equal(unbase64(bad), null, bad);
});

test("put then get returns the secret; the record holds no plaintext and names its frame", async () => {
  const { store, files } = rig();
  assert.deepEqual(await store.handle(put("c1")), { ok: true, value: { op: "put", landedOn: { backend: "gnome_libsecret", protection: "os_protected" } } });
  const raw = Buffer.from(files.store.get("6331.v1") as Uint8Array).toString("latin1");
  assert.ok(!raw.includes(SECRET));
  assert.deepEqual(Object.keys(JSON.parse(raw)), ["v", "meta", "ct"]);
  const got = await store.handle({ type: "secrets.get", name: "c1" });
  assert.deepEqual(got, { ok: true, value: { op: "get", secret: SECRET, meta: meta() } });
  assert.equal(secretsResultSchema.safeParse({ type: "secrets.result", requestId: "r1", ...got }).success, true, "the answer fits the control schema");
});

test("weak or unavailable backends store nothing, with no consent path", async () => {
  for (const [backend, available] of [["basic_text", true], ["unknown", true], ["gnome_libsecret", false]] as const) {
    const { store, files, events } = rig("linux", fakeCipher(backend, "v11", available));
    assert.equal(err(await store.handle(put("c1", SECRET, meta(backend, "none")))), "refused", backend);
    assert.equal(err(await store.handle(put("c1"))), "refused", backend);
    assert.equal(files.writes, 0);
    assert.ok(events.includes("secret_refused_weak"));
  }
});

test("on Linux the ciphertext must be v11: a session switched to the hardcoded key (v10) writes nothing", async () => {
  const { store, files, events } = rig("linux", fakeCipher("gnome_libsecret", "v10"));
  assert.equal(err(await store.handle(put("c1"))), "refused");
  assert.equal(files.writes, 0);
  assert.deepEqual(events, ["secret_refused_prefix"]);
});

test("on Linux a v10 record placed by hand reads as unprotected; on macOS and Windows the prefix is never judged", async () => {
  const linux = rig("linux");
  await linux.store.handle(put("c1"));
  const rec = JSON.parse(Buffer.from(linux.files.store.get("6331.v1") as Uint8Array).toString("latin1"));
  const ct = unbase64(rec.ct) as Uint8Array;
  ct[2] = 0x30; // "v10"
  linux.files.store.set("6331.v1", Buffer.from(JSON.stringify({ ...rec, ct: base64(ct) })));
  const m = await linux.store.handle({ type: "secrets.meta", name: "c1" });
  assert.equal(m.ok && m.value.op === "meta" ? m.value.meta.protection : "", "none");
  for (const platform of ["darwin", "win32"]) {
    const backend = platform === "darwin" ? "macos_keychain" : "windows_dpapi";
    const r = rig(platform, fakeCipher("unknown", "v10"));
    assert.equal(err(await r.store.handle(put("c1", SECRET, meta(backend)))), "ok", platform);
    const got = await r.store.handle({ type: "secrets.meta", name: "c1" });
    assert.equal(got.ok && got.value.op === "meta" ? got.value.meta.protection : "", "os_protected", platform);
  }
});

test("a write that would land elsewhere than the vault decided is refused, never made", async () => {
  const { store, files } = rig();
  assert.equal(err(await store.handle(put("c1", SECRET, meta("kwallet")))), "refused");
  assert.equal(err(await store.handle(put("c1", SECRET, meta("gnome_libsecret", "none")))), "refused");
  assert.equal(files.writes, 0);
});

test("a record moved to another entry's file, or with a changed frame or form, reads corrupt", async () => {
  const { store, files, cipher } = rig();
  await store.handle(put("c1"));
  files.store.set(fileOf("c2"), files.store.get("6331.v1") as Uint8Array);
  assert.equal(err(await store.handle({ type: "secrets.get", name: "c2" })), "corrupt", "moved");
  const frame = (plain: string) => Buffer.from(JSON.stringify({ v: 1, meta: meta(), ct: base64(cipher.encrypt(plain)) }));
  for (const plain of [`axis.secret/2\nc1\n${SECRET}`, `axis.secret/1\nc1 \n${SECRET}`, `axis.secret/1\nc1\n${SECRET}\n`, `axis.secret/1\nc1\nshort`, "nothing"]) {
    files.store.set("6331.v1", frame(plain));
    assert.equal(err(await store.handle({ type: "secrets.get", name: "c1" })), "corrupt", JSON.stringify(plain));
  }
  const good = JSON.parse(frame(`axis.secret/1\nc1\n${SECRET}`).toString());
  for (const rec of [{ ...good, v: 2 }, { ...good, extra: 1 }, { ...good, meta: { ...good.meta, backend: "x" } }, { ...good, ct: "not base64!" }, { ...good, ct: "" }, [good]]) {
    files.store.set("6331.v1", Buffer.from(JSON.stringify(rec)));
    assert.equal(err(await store.handle({ type: "secrets.get", name: "c1" })), "corrupt", JSON.stringify(rec).slice(0, 40));
  }
  files.store.set("6331.v1", Buffer.from("{ÿ}", "latin1"));
  assert.equal(err(await store.handle({ type: "secrets.get", name: "c1" })), "corrupt", "non-ASCII bytes");
  files.store.set("6331.v1", new Uint8Array(16_385).fill(0x20));
  assert.equal(err(await store.handle({ type: "secrets.get", name: "c1" })), "corrupt", "oversize");
});

test("meta never decrypts; remove and not_found; info reports the backend", async () => {
  const { store, cipher } = rig();
  await store.handle(put("c1"));
  cipher.decrypts = 0;
  assert.equal(err(await store.handle({ type: "secrets.meta", name: "c1" })), "ok");
  assert.equal(cipher.decrypts, 0);
  assert.deepEqual(await store.handle({ type: "secrets.remove", name: "c1" }), { ok: true, value: { op: "remove", removed: true } });
  assert.deepEqual(await store.handle({ type: "secrets.remove", name: "c1" }), { ok: true, value: { op: "remove", removed: false } });
  for (const type of ["secrets.get", "secrets.meta"] as const) assert.equal(err(await store.handle({ type, name: "c1" })), "not_found");
  assert.deepEqual(await store.handle({ type: "secrets.info" }), { ok: true, value: { op: "info", backend: "gnome_libsecret", protection: "os_protected", available: true } });
});

test("list keeps canonical, readable records only; other files and bad records are skipped and reported", async () => {
  const { store, files, events } = rig();
  await store.handle(put("c1"));
  await store.handle(put("integration:github"));
  files.store.set("6331.V1", new Uint8Array([1]));
  files.store.set("4331.v1", new Uint8Array([1])); // "C1": not a valid name
  files.store.set(fileOf("c9"), Buffer.from("{}"));
  files.store.set("notes.txt", new Uint8Array([1]));
  const r = await store.handle({ type: "secrets.list" });
  assert.equal(r.ok, true);
  const names = r.ok && r.value.op === "list" ? r.value.entries.map((e) => e.name).sort() : [];
  assert.deepEqual(names, ["c1", "integration:github"]);
  assert.equal(events.filter((e) => e === "secret_name_ignored").length, 2, "the bad hex name and the corrupt record");
});

test("a folder that fails its check answers failed for every request and writes nothing", async () => {
  const { store, files } = rig();
  files.failCheck = true;
  for (const r of [put("c1"), { type: "secrets.get", name: "c1" }, { type: "secrets.remove", name: "c1" }, { type: "secrets.list" }] as SecretRequest[]) {
    assert.equal(err(await store.handle(r)), "failed", r.type);
  }
  assert.equal(files.writes, 0);
});

test("malformed requests are failed before anything runs", async () => {
  const { store, files } = rig();
  const bad: unknown[] = [null, { type: "secrets.get", name: "C1" }, { type: "secrets.get", name: `${"a".repeat(101)}` }, put("c1", "short"), put("c1", "has space here"), { ...put("c1"), meta: { ...meta(), extra: 1 } }, { ...put("c1"), meta: { ...meta(), storedAt: -1 } }];
  for (const b of bad) assert.equal(err(await store.handle(b as SecretRequest)), "failed", JSON.stringify(b));
  assert.equal(files.writes, 0);
});

test("one request per name at a time, at most 4 running and 4 waiting; more answer failed", async () => {
  const files = memFiles();
  const gates: Array<() => void> = [];
  files.read = () => new Promise((resolve) => gates.push(() => resolve(null)));
  const { store, events } = rig("linux", fakeCipher(), files);
  const answers: Array<Promise<SecretAnswer>> = [];
  for (const n of ["a1", "a2", "a3", "a4", "a5"]) answers.push(store.handle({ type: "secrets.get", name: n }));
  await new Promise((r) => setImmediate(r));
  assert.equal(gates.length, 4, "four run at once; the fifth waits");
  answers.push(store.handle({ type: "secrets.get", name: "a1" })); // same name: waits behind the first
  for (const n of ["b1", "b2"]) answers.push(store.handle({ type: "secrets.get", name: n }));
  const overflow = await store.handle({ type: "secrets.get", name: "b3" });
  assert.equal(err(overflow), "failed");
  assert.ok(events.includes("secret_overloaded"));
  for (let round = 0; round < 6; round++) {
    for (const g of gates.splice(0)) g();
    await new Promise((r) => setImmediate(r));
  }
  const done = await Promise.all(answers);
  assert.deepEqual(done.map(err), Array(done.length).fill("not_found"));
});

test("a request past its budget answers failed and frees its slot", async () => {
  const files = memFiles();
  files.read = () => new Promise(() => undefined); // hangs
  const cipher = fakeCipher();
  const events: string[] = [];
  const store = createSecretStore({ cipher, files, platform: "linux", timers: realTimers, onEvent: (e) => events.push(e), budgets: { slowMs: 20, fastMs: 20 } });
  assert.equal(err(await store.handle({ type: "secrets.get", name: "c1" })), "failed");
  assert.ok(events.includes("secret_timeout"));
  files.read = () => Promise.resolve(null);
  assert.equal(err(await store.handle({ type: "secrets.get", name: "c2" })), "not_found", "the slot was freed");
});

test("no answer or event ever carries the secret, the name or a path", async () => {
  const events: string[] = [];
  const files = memFiles();
  files.write = () => Promise.reject(new Error(`/home/u/secrets/6331.v1 ${SECRET}`));
  const store = createSecretStore({ cipher: fakeCipher(), files, platform: "linux", timers: realTimers, onEvent: (e) => events.push(e) });
  const a = await store.handle(put("c1"));
  assert.equal(err(a), "failed");
  assert.ok(!JSON.stringify([a, events]).includes(SECRET) && !JSON.stringify([a, events]).includes("c1"));
});

test("start checks the folder and cleans temporary files, and never throws", async () => {
  const files = memFiles();
  let cleaned = 0;
  files.cleanup = () => ((cleaned += 1), Promise.resolve(2));
  const { store } = rig("linux", fakeCipher(), files);
  await store.start();
  assert.equal(cleaned, 1);
  files.failCheck = true;
  await store.start();
});
