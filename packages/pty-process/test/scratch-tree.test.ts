// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Unit tests of the scratch writer's own defences, below the planning step that already refuses most bad trees.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { blobId, componentOk, parseCatFileBatch, parseLsTree, planManifest, readRegular, writeScratchTree, type Manifest } from "../src/index.js";

const OID = "0123456789abcdef0123456789abcdef01234567";
const OID2 = "89abcdef0123456789abcdef0123456789abcdef";

test("componentOk refuses every spelling of .git and of a parent or empty component", () => {
  for (const bad of ["", ".", "..", ".git", ".GIT", ".Git", "git~1", "GIT~2", ".git.", ".git ", ".git. .", ".git::$INDEX_ALLOCATION", ".g‌it", "﻿.git", "a/b", "a\\b", "a\0b"]) assert.equal(componentOk(bad), false, JSON.stringify(bad));
  for (const good of [".gitignore", ".github", "git", "x.git", "...x", "café"]) assert.equal(componentOk(good), true, good);
});

test("planManifest refuses case-fold and normalisation collisions between files, links and directories", () => {
  const e = (path: string, kind: "file" | "link" = "file") => ({ path, kind, oid: OID });
  assert.equal(planManifest([e("A"), e("a")]), undefined);
  assert.equal(planManifest([e("L", "link"), e("l/x")]), undefined);
  assert.equal(planManifest([e("l/x"), e("L", "link")]), undefined);
  assert.equal(planManifest([e("D/x"), e("d/y")]), undefined);
  assert.equal(planManifest([e("café"), e("café")]), undefined);
  assert.equal(planManifest([e("a/.git/hooks/pre-commit")]), undefined);
  assert.equal(planManifest([e("dir", "link"), e("dir./x")]), undefined, "NTFS drops a trailing dot: dir. is dir");
  assert.equal(planManifest([e("a "), e("a")]), undefined, "and a trailing space");
  assert.deepEqual(planManifest([e("d/x"), e("d/y"), e("e")])?.dirs, ["d"]);
});

test("parseLsTree and parseCatFileBatch refuse malformed or mismatched records", () => {
  assert.equal(parseLsTree(Buffer.from(`100644 blob ${OID}\ta\0`))?.length, 1);
  assert.equal(parseLsTree(Buffer.from(`040000 tree ${OID}\ta\0`)), undefined, "ls-tree -r never lists a tree");
  assert.equal(parseLsTree(Buffer.from(`100644 commit ${OID}\ta\0`)), undefined);
  assert.equal(parseLsTree(Buffer.from([0x31, 0x30, 0x30, 0x36, 0x34, 0x34, 0x20, 0xff])), undefined, "not UTF-8");
  const body = Buffer.from(`${OID} blob 3\nabc\n`);
  assert.equal(Buffer.from(parseCatFileBatch(body, [OID])?.get(OID) ?? []).toString(), "abc");
  assert.equal(parseCatFileBatch(body, [OID2]), undefined, "an id other than the one asked");
  assert.equal(parseCatFileBatch(Buffer.from(`${OID} missing\n`), [OID]), undefined);
  assert.equal(parseCatFileBatch(Buffer.concat([body, Buffer.from("x")]), [OID]), undefined, "trailing bytes");
  assert.equal(blobId(Buffer.from("abc"), OID), "f2ba8f84ab5c1bce84a7b441cb1959cfc7093b7f");
});

test("writeScratchTree never writes through a symlink, even for a manifest the planner would have refused", (t) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "axis-pty-writer-")));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const outside = join(tmp, "outside");
  const root = join(tmp, "root");
  mkdirSync(outside);
  mkdirSync(root);
  const m: Manifest = { dirs: [], entries: [{ path: "d", kind: "link", oid: OID }, { path: "d/x", kind: "file", oid: OID2 }] };
  const blobs = new Map([[OID, Buffer.from(outside)], [OID2, Buffer.from("payload")]]);
  assert.throws(() => writeScratchTree(root, m, blobs));
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(existsSync(join(root, "d")), false, "the symlink is written last, so the failed file write stops before it");
});

test("readRegular refuses a FIFO without blocking (the lstat-to-open window a surviving hook child could use)", { skip: process.platform === "win32" ? "no FIFOs" : false }, (t) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "axis-pty-fifo-")));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const fifo = join(tmp, "f");
  execFileSync("mkfifo", [fifo]);
  assert.equal(readRegular(fifo, 0), undefined);
  writeFileSync(join(tmp, "r"), "abc");
  assert.equal(Buffer.from(readRegular(join(tmp, "r"), 3) ?? []).toString(), "abc");
  assert.equal(readRegular(join(tmp, "r"), 2), undefined, "a size other than the blob's");
});
