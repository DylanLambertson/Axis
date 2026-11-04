// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// File system errors become closed-set errors without the path (the operating system puts the path in its message).
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AxisError, acquireInstanceLock, ensureDataDirectory, mapFsError, openDatabase } from "../src/index.js";

const posixOnly = { skip: process.platform === "win32" };
const notRoot = { skip: process.platform === "win32" || process.getuid?.() === 0 ? "root ignores directory permissions" : false };

function tmp() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "axis-fserr-")));
  return { base, done: () => rmSync(base, { recursive: true, force: true }) };
}

/** The error a call throws, which must be an AxisError whose text carries neither the path nor an OS message. */
function thrown(fn: () => unknown, base: string): AxisError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof AxisError, `not an AxisError: ${String(e)}`);
    assert.ok(!e.message.includes(base), "the message must not carry the path");
    assert.ok(!JSON.stringify(e.detail).includes(base), "the detail must not carry the path");
    return e;
  }
  assert.fail("did not throw");
}

test("mapFsError: errno names map onto the closed set and keep only the errno", () => {
  const cases: Array<[string, string]> = [
    ["ENAMETOOLONG", "E_INVALID_ARGUMENT"], ["ENOTDIR", "E_INVALID_ARGUMENT"], ["ELOOP", "E_INVALID_ARGUMENT"], ["EISDIR", "E_INVALID_ARGUMENT"],
    ["EACCES", "E_POLICY_DENIED"], ["EPERM", "E_POLICY_DENIED"], ["EROFS", "E_POLICY_DENIED"],
    ["ENOSPC", "E_UNAVAILABLE"], ["EMFILE", "E_UNAVAILABLE"], ["EBUSY", "E_UNAVAILABLE"], ["EDQUOT", "E_UNAVAILABLE"],
    ["EIO", "E_INTERNAL"], ["EXDEV", "E_INTERNAL"],
  ];
  for (const [errno, code] of cases) {
    const raw = Object.assign(new Error(`${errno}: failed, open '/secret/path/x.db'`), { code: errno });
    const mapped = mapFsError(raw);
    if (!(mapped instanceof AxisError)) assert.fail(errno);
    assert.equal(mapped.code, code, errno);
    assert.deepEqual(mapped.detail, { errno });
    assert.ok(!mapped.message.includes("secret"));
  }
  const already = new AxisError("E_CONFLICT", "x");
  assert.equal(mapFsError(already), already);
  const plain = new Error("not a file system error");
  assert.equal(mapFsError(plain), plain);
  const sqlite = Object.assign(new Error("x"), { code: "ERR_SQLITE_ERROR" });
  assert.equal(mapFsError(sqlite), sqlite, "non-errno codes pass through");
});

test("a too-long directory or file name is E_INVALID_ARGUMENT without the path", posixOnly, () => {
  const t = tmp();
  try {
    for (const path of [`${t.base}/${"x".repeat(300)}/a.db`, `${t.base}/${"y".repeat(300)}.db`]) {
      const e = thrown(() => openDatabase(path), t.base);
      assert.equal(e.code, "E_INVALID_ARGUMENT");
      assert.equal(e.detail["errno"], "ENAMETOOLONG");
    }
    assert.equal(thrown(() => acquireInstanceLock(`${t.base}/${"z".repeat(300)}`), t.base).code, "E_INVALID_ARGUMENT");
  } finally {
    t.done();
  }
});

test("a path component that is a file gives E_INVALID_ARGUMENT (ENOTDIR) without the path", posixOnly, () => {
  const t = tmp();
  try {
    writeFileSync(join(t.base, "afile"), "x");
    const e = thrown(() => openDatabase(`${t.base}/afile/sub/a.db`), t.base);
    assert.equal(e.code, "E_INVALID_ARGUMENT");
    assert.equal(e.detail["errno"], "ENOTDIR");
  } finally {
    t.done();
  }
});

test("a directory the user cannot write to gives E_POLICY_DENIED (EACCES) without the path", notRoot, () => {
  const t = tmp();
  try {
    const ro = join(t.base, "ro");
    mkdirSync(ro, { mode: 0o700 });
    chmodSync(ro, 0o500);
    for (const call of [() => openDatabase(`${ro}/new/a.db`), () => acquireInstanceLock(`${ro}/new`), () => acquireInstanceLock(ro)]) {
      const e = thrown(call, t.base);
      assert.equal(e.code, "E_POLICY_DENIED");
      assert.equal(e.detail["errno"], "EACCES");
    }
    // An existing read-only directory: opening the database file in it is refused the same way.
    assert.equal(thrown(() => openDatabase(`${ro}/a.db`), t.base).code, "E_POLICY_DENIED");
    chmodSync(ro, 0o700);
  } finally {
    t.done();
  }
});

test("a NUL byte in a path is E_INVALID_ARGUMENT with a fixed message, before any file system call", posixOnly, () => {
  const t = tmp();
  try {
    for (const call of [
      () => openDatabase(`${t.base}/a\0b/x.db`),
      () => openDatabase(`${t.base}/dir/x\0.db`),
      () => acquireInstanceLock(`${t.base}/da\0ta`),
      () => ensureDataDirectory(`${t.base}/\0`),
    ]) {
      const e = thrown(call, t.base);
      assert.equal(e.code, "E_INVALID_ARGUMENT");
      assert.equal(e.detail["reason"], "nul-byte");
      assert.ok(!e.message.includes("\0"));
    }
    assert.equal(existsSync(join(t.base, "dir")), false, "nothing is created before the path is rejected");
    for (const bad of [undefined, null, 5, ""]) {
      assert.equal(thrown(() => openDatabase(bad as never), t.base).code, "E_INVALID_ARGUMENT");
    }
  } finally {
    t.done();
  }
});

test("mapFsError: Node's own argument errors are mapped without quoting the value", () => {
  for (const code of ["ERR_INVALID_ARG_VALUE", "ERR_INVALID_ARG_TYPE"]) {
    const raw = Object.assign(new Error("The argument 'path' must be a string without null bytes. Received '/private/secret/path'"), { code });
    const mapped = mapFsError(raw);
    assert.ok(mapped instanceof AxisError);
    assert.equal(mapped.code, "E_INVALID_ARGUMENT");
    assert.deepEqual(mapped.detail, { errno: code });
    assert.ok(!mapped.message.includes("secret"));
  }
});
