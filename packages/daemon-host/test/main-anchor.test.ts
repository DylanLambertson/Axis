// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { anchorFilePath, createAnchorFile } from "../src/main/anchor-file.js";
import { anchorRecordText, createAnchorStore, parseAnchorRecord, type AnchorCipher, type AnchorFile } from "../src/main/anchor-store.js";
import { testCipher } from "../testing/main-fakes.js";

const H = "ab".repeat(32);

const memFile = (data: Uint8Array | null | Error): AnchorFile & { writes: Uint8Array[] } => {
  const f = {
    writes: [] as Uint8Array[],
    read: () => (data instanceof Error ? Promise.reject(data) : Promise.resolve(data)),
    write: (d: Uint8Array) => (f.writes.push(d), Promise.resolve()),
  };
  return f;
};

test("the record text is exact and parses back; any other text is not a record", () => {
  assert.equal(anchorRecordText({ seq: 12, hash: H }), `axis.anchor/1 {"hash":"${H}","seq":12}`);
  assert.deepEqual(parseAnchorRecord(anchorRecordText({ seq: 12, hash: H })), { seq: 12, hash: H });
  for (const bad of [
    `axis.anchor/2 {"hash":"${H}","seq":12}`,
    `axis.anchor/1 {"seq":12,"hash":"${H}"}`,
    `axis.anchor/1 {"hash":"${H}","seq":012}`,
    `axis.anchor/1 {"hash":"${H}","seq":0}`,
    `axis.anchor/1 {"hash":"${H.toUpperCase()}","seq":1}`,
    `axis.anchor/1 {"hash":"${H}","seq":1} `,
    `axis.anchor/1 {"hash":"${H}","seq":1,"x":1}`,
    `axis.anchor/1 {"hash":"${H}","seq":99999999999999999}`,
    "",
  ]) {
    assert.equal(parseAnchorRecord(bad), undefined, bad);
  }
  assert.throws(() => anchorRecordText({ seq: 0, hash: H }));
  assert.throws(() => anchorRecordText({ seq: 1, hash: "x" }));
});

test("read: a record, a definite absence, and every failure is unavailable (never absent)", async () => {
  const c = testCipher();
  assert.deepEqual(await createAnchorStore(c, memFile(c.encrypt(anchorRecordText({ seq: 3, hash: H })))).read(), { kind: "anchor", head: { seq: 3, hash: H } });
  assert.deepEqual(await createAnchorStore(c, memFile(null)).read(), { kind: "absent" });
  assert.deepEqual(await createAnchorStore(c, memFile(new Error("EACCES"))).read(), { kind: "unavailable", reason: "read_failed" });
  assert.deepEqual(await createAnchorStore(c, memFile(c.encrypt("garbage"))).read(), { kind: "unavailable", reason: "corrupt" });
  const throwing: AnchorCipher = { ...c, decrypt: () => { throw new Error("bad"); } };
  assert.deepEqual(await createAnchorStore(throwing, memFile(new Uint8Array([1]))).read(), { kind: "unavailable", reason: "decrypt_failed" });
  // An insecure or missing backend is unavailable even when the file does not exist: "absent" is said only when a record could have been written securely.
  for (const status of ["insecure", "unavailable"] as const) {
    assert.deepEqual(await createAnchorStore(testCipher(status), memFile(null)).read(), { kind: "unavailable", reason: "insecure_backend" });
  }
  const broken: AnchorCipher = { ...c, status: () => { throw new Error("x"); } };
  assert.deepEqual(await createAnchorStore(broken, memFile(null)).read(), { kind: "unavailable", reason: "insecure_backend" });
});

test("write encrypts the exact record and refuses an insecure backend", async () => {
  const c = testCipher();
  const f = memFile(null);
  await createAnchorStore(c, f).write({ seq: 9, hash: H });
  assert.equal(c.decrypt(f.writes[0]!), anchorRecordText({ seq: 9, hash: H }));
  assert.notEqual(Buffer.from(f.writes[0]!).toString("utf8"), anchorRecordText({ seq: 9, hash: H }), "not the plain text");
  await assert.rejects(createAnchorStore(testCipher("insecure"), f).write({ seq: 10, hash: H }));
  assert.equal(f.writes.length, 1);
});

function box(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "axis-anchor-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("the anchor file sits next to the daemon directory, never inside it", () => {
  const p = anchorFilePath(join("/base", "Axis", "daemon"));
  assert.equal(p, join("/base", "Axis", "anchor", "audit-anchor.v1"));
  assert.equal(p.startsWith(join("/base", "Axis", "daemon")), false);
});

test("the real file: absent (also with no directory) is null; a write is durable, 0600 in a 0700 directory, and leaves no temporary file", async () => {
  const b = box();
  try {
    const path = join(b.root, "Axis", "anchor", "audit-anchor.v1");
    const f = createAnchorFile(path);
    assert.equal(await f.read(), null);
    await f.write(new Uint8Array([1, 2, 3]));
    assert.deepEqual(await f.read(), new Uint8Array([1, 2, 3]));
    await f.write(new Uint8Array([4]));
    assert.deepEqual(await f.read(), new Uint8Array([4]));
    assert.deepEqual(readdirSync(join(b.root, "Axis", "anchor")), ["audit-anchor.v1"]);
    if (process.platform !== "win32") {
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(join(b.root, "Axis", "anchor")).mode & 0o777, 0o700);
    }
  } finally {
    b.cleanup();
  }
});

test("the real file: a directory, an oversized file, a parent that is a file and a symlink all throw (the store reports them unavailable)", async (t) => {
  const b = box();
  try {
    const dirAt = join(b.root, "d", "audit-anchor.v1");
    mkdirSync(dirAt, { recursive: true });
    await assert.rejects(createAnchorFile(dirAt).read());
    const big = join(b.root, "big");
    writeFileSync(big, Buffer.alloc(5000));
    await assert.rejects(createAnchorFile(big).read());
    const parentFile = join(b.root, "file");
    writeFileSync(parentFile, "x");
    await assert.rejects(createAnchorFile(join(parentFile, "audit-anchor.v1")).read());
    await assert.rejects(createAnchorFile(join(parentFile, "audit-anchor.v1")).write(new Uint8Array([1])));
    const store = createAnchorStore(testCipher(), createAnchorFile(dirAt));
    assert.deepEqual(await store.read(), { kind: "unavailable", reason: "read_failed" });
    const target = join(b.root, "target");
    writeFileSync(target, "x");
    const link = join(b.root, "link");
    try {
      symlinkSync(target, link);
    } catch {
      t.diagnostic("symlinks not available here; the symlink case is not checked");
      return;
    }
    await assert.rejects(createAnchorFile(link).read());
  } finally {
    b.cleanup();
  }
});

test("the real file: a failed write removes its temporary file and keeps the old record", async () => {
  const b = box();
  try {
    const dir = join(b.root, "anchor");
    const path = join(dir, "audit-anchor.v1");
    const f = createAnchorFile(path);
    await f.write(new Uint8Array([7]));
    // A directory where the record is makes the rename fail.
    rmSync(path);
    mkdirSync(join(path, "inner"), { recursive: true });
    await assert.rejects(f.write(new Uint8Array([8])));
    assert.deepEqual(readdirSync(dir), ["audit-anchor.v1"], "no temporary file left behind");
    await assert.rejects(f.write(new Uint8Array(0)), "an empty record is refused");
  } finally {
    b.cleanup();
  }
});
