// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The secret broker's record folder on a real file system (ticket PV-N0a, docs/design/secret-broker.md §3.1).
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSecretFiles, secretsDirPath } from "../src/main/secret-files.js";

const posix = process.platform !== "win32";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "axis-secrets-"));
  return { root, dir: join(root, "secrets"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const throwsAsync = async (p: Promise<unknown>): Promise<boolean> => p.then(() => false, () => true);

test("the folder is <base>/secrets beside the daemon's data directory", () => {
  assert.equal(secretsDirPath(join("/data", "Axis", "daemon")), join("/data", "Axis", "secrets"));
});

test("check creates the folder 0700 and accepts it; write, read, names, remove round-trip with 0600 files", async () => {
  const box = sandbox();
  try {
    const files = createSecretFiles(box.dir);
    await files.check();
    if (posix) assert.equal(statSync(box.dir).mode & 0o777, 0o700);
    await files.write("6331.v1", Buffer.from("record-1"));
    if (posix) assert.equal(statSync(join(box.dir, "6331.v1")).mode & 0o777, 0o600);
    assert.equal(Buffer.from((await files.read("6331.v1")) as Uint8Array).toString(), "record-1");
    await files.write("6331.v1", Buffer.from("record-2"));
    assert.equal(Buffer.from((await files.read("6331.v1")) as Uint8Array).toString(), "record-2", "replaced atomically");
    assert.deepEqual(await files.names(), ["6331.v1"]);
    assert.equal(readdirSync(box.dir).length, 1, "no temporary file left behind");
    assert.equal(await files.read("6332.v1"), null);
    assert.equal(await files.remove("6331.v1"), true);
    assert.equal(await files.remove("6331.v1"), false);
  } finally {
    box.cleanup();
  }
});

test("a folder that is a symlink, not a directory, or (POSIX) of another mode is refused", async () => {
  const box = sandbox();
  try {
    const real = join(box.root, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, box.dir);
    assert.equal(await throwsAsync(createSecretFiles(box.dir).check()), true, "symlink");
    rmSync(box.dir);
    writeFileSync(box.dir, "x");
    assert.equal(await throwsAsync(createSecretFiles(box.dir).check()), true, "a file");
    rmSync(box.dir);
    if (posix) {
      mkdirSync(box.dir, { mode: 0o755 });
      chmodSync(box.dir, 0o755);
      assert.equal(await throwsAsync(createSecretFiles(box.dir).check()), true, "mode 0755");
      chmodSync(box.dir, 0o700);
      assert.equal(await throwsAsync(createSecretFiles(box.dir).check()), false, "mode 0700");
      assert.equal(await throwsAsync(createSecretFiles(box.dir, { uid: (process.getuid?.() ?? 0) + 1 }).check()), true, "another owner");
    }
  } finally {
    box.cleanup();
  }
});

test("entry files: a symlink, a directory, an oversize file or (POSIX) a wrong mode is refused; names outside the form are refused", async () => {
  const box = sandbox();
  try {
    const files = createSecretFiles(box.dir);
    await files.check();
    const target = join(box.root, "elsewhere");
    writeFileSync(target, "x", { mode: 0o600 });
    symlinkSync(target, join(box.dir, "6331.v1"));
    assert.equal(await throwsAsync(files.read("6331.v1")), true, "symlinked entry");
    mkdirSync(join(box.dir, "6332.v1"));
    assert.equal(await throwsAsync(files.read("6332.v1")), true, "a directory");
    writeFileSync(join(box.dir, "6333.v1"), Buffer.alloc(16_385), { mode: 0o600 });
    assert.equal(await throwsAsync(files.read("6333.v1")), true, "oversize");
    if (posix) {
      writeFileSync(join(box.dir, "6334.v1"), "x", { mode: 0o644 });
      chmodSync(join(box.dir, "6334.v1"), 0o644);
      assert.equal(await throwsAsync(files.read("6334.v1")), true, "mode 0644");
    }
    for (const bad of ["../x.v1", "6331", "6331.V1", "a/6331.v1", ".6331.v1.tmp-0123456789ab"]) {
      assert.equal(await throwsAsync(files.read(bad)), true, bad);
      assert.equal(await throwsAsync(files.write(bad, Buffer.from("x"))), true, bad);
    }
    assert.deepEqual([...(await files.names())].sort(), ["6333.v1", ...(posix ? ["6334.v1"] : [])], "names lists regular files of the record form only (not the symlink or the directory)");
  } finally {
    box.cleanup();
  }
});

test("cleanup removes leftover temporary files only", async () => {
  const box = sandbox();
  try {
    const files = createSecretFiles(box.dir);
    await files.check();
    writeFileSync(join(box.dir, ".6331.v1.tmp-0123456789ab"), "partial", { mode: 0o600 });
    writeFileSync(join(box.dir, "6331.v1"), "keep", { mode: 0o600 });
    writeFileSync(join(box.dir, "notes.txt"), "keep");
    assert.equal(await files.cleanup(), 1);
    assert.deepEqual(readdirSync(box.dir).sort(), ["6331.v1", "notes.txt"]);
  } finally {
    box.cleanup();
  }
});

test("an empty or oversize write is refused and leaves nothing", async () => {
  const box = sandbox();
  try {
    const files = createSecretFiles(box.dir);
    await files.check();
    assert.equal(await throwsAsync(files.write("6331.v1", new Uint8Array(0))), true);
    assert.equal(await throwsAsync(files.write("6331.v1", new Uint8Array(16_385))), true);
    assert.deepEqual(readdirSync(box.dir), []);
  } finally {
    box.cleanup();
  }
});

test("each entry check refuses a symlink on its own: lstat without O_NOFOLLOW, and O_NOFOLLOW without lstat", { skip: !posix }, async () => {
  const box = sandbox();
  try {
    const target = join(box.root, "elsewhere");
    writeFileSync(target, "x", { mode: 0o600 });
    chmodSync(target, 0o600);
    await createSecretFiles(box.dir).check();
    symlinkSync(target, join(box.dir, "6331.v1"));
    assert.equal(await throwsAsync(createSecretFiles(box.dir, { testSeams: { followLinks: true } }).read("6331.v1")), true, "lstat alone");
    assert.equal(await throwsAsync(createSecretFiles(box.dir, { testSeams: { skipEntryLstat: true } }).read("6331.v1")), true, "O_NOFOLLOW alone");
    assert.equal(Buffer.from((await createSecretFiles(box.dir, { testSeams: { skipEntryLstat: true, followLinks: true } }).read("6331.v1")) as Uint8Array).toString(), "x", "with both off the link is followed (the seams work)");
    assert.equal(await createSecretFiles(box.dir, { testSeams: { skipEntryLstat: true } }).read("6339.v1"), null, "absent is still absent");
  } finally {
    box.cleanup();
  }
});
