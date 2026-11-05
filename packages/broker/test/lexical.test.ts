// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrokerError, lexicalSegments, matchProtected } from "../src/index.js";

const reasonOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return (e as BrokerError).reason;
  }
  return "no-error";
};
const posixRoot = "/app/wt";
const winRoot = "C:\\app\\wt";

test("posix rules", () => {
  assert.deepEqual(lexicalSegments("a/./b//c", posixRoot, "linux"), ["a", "b", "c"]);
  assert.deepEqual(lexicalSegments("/app/wt/a/b", posixRoot, "linux"), ["a", "b"]);
  assert.deepEqual(lexicalSegments(".", posixRoot, "linux"), []);
  assert.equal(reasonOf(() => lexicalSegments("a/../b", posixRoot, "linux")), "dotdot");
  assert.equal(reasonOf(() => lexicalSegments("/app/wt/../x", posixRoot, "linux")), "dotdot");
  assert.equal(reasonOf(() => lexicalSegments("/app/other/x", posixRoot, "linux")), "outside-root");
  assert.equal(reasonOf(() => lexicalSegments("/app/wt2/x", posixRoot, "linux")), "outside-root");
  assert.equal(reasonOf(() => lexicalSegments("a\\b", posixRoot, "linux")), "backslash");
  assert.equal(reasonOf(() => lexicalSegments("C:\\Windows", posixRoot, "linux")), "backslash");
  assert.equal(reasonOf(() => lexicalSegments("C:/Windows", posixRoot, "linux")), "drive-prefix");
  for (const bad of ["a\0", "a\u0085b", "a\u2028b", "a\x1bb", "\udc00"]) assert.equal(reasonOf(() => lexicalSegments(bad, posixRoot, "linux")), "invalid-path");
  assert.equal(reasonOf(() => lexicalSegments("x".repeat(300), posixRoot, "linux")), "invalid-path");
});

test("win32 rules run on every host", () => {
  assert.deepEqual(lexicalSegments("a\\b/c", winRoot, "win32"), ["a", "b", "c"]);
  assert.deepEqual(lexicalSegments("c:\\APP\\WT\\a", winRoot, "win32"), ["a"], "drive and case folded");
  assert.equal(reasonOf(() => lexicalSegments("\\\\server\\share\\x", winRoot, "win32")), "unc-or-device");
  assert.equal(reasonOf(() => lexicalSegments("//server/share/x", winRoot, "win32")), "unc-or-device");
  assert.equal(reasonOf(() => lexicalSegments("\\\\?\\C:\\app\\wt\\x", winRoot, "win32")), "unc-or-device");
  assert.equal(reasonOf(() => lexicalSegments("C:foo", winRoot, "win32")), "drive-prefix");
  assert.equal(reasonOf(() => lexicalSegments("D:\\other", winRoot, "win32")), "outside-root");
  assert.equal(reasonOf(() => lexicalSegments("a\\..\\b", winRoot, "win32")), "dotdot");
  for (const bad of ["file.txt:stream", "CON", "nul.txt", "COM1", "a.", "a ", "PROGRA~1", "a<b", "x?y"]) {
    assert.equal(reasonOf(() => lexicalSegments(bad, winRoot, "win32")), "win-name", bad);
  }
});

test("N1: a root-relative path on win32 is refused, not read as relative to the worktree", () => {
  for (const bad of ["\\x", "/r/x", "\\r\\x"]) assert.equal(reasonOf(() => lexicalSegments(bad, winRoot, "win32")), "outside-root", bad);
});

test("protected paths: the listed set, folded on every platform", () => {
  const hit = (p: string[]): string | undefined => matchProtected(p)?.label;
  assert.equal(hit([".github", "workflows", "ci.yml"]), ".github");
  assert.equal(hit([".vscode", "tasks.json"]), ".vscode");
  assert.equal(hit([".husky", "pre-commit"]), ".husky");
  assert.equal(hit([".githooks", "x"]), ".githooks");
  assert.equal(hit(["lefthook.yml"]), "lefthook.yml");
  assert.equal(hit([".pre-commit-config.yaml"]), ".pre-commit-config.yaml");
  assert.equal(matchProtected([".git", "config"])?.gitDir, true);
  assert.equal(matchProtected(["sub", "mod", ".git", "hooks", "x"])?.gitDir, true, "nested repositories and submodules");
  assert.equal(hit(["src", "a.ts"]), undefined);
  assert.equal(hit([".gitignore"]), undefined);
  assert.equal(hit([".github", "actions", "x", "action.yml"]), ".github", "a local composite action runs in CI like a workflow");
});

test("protected paths: WT-3 names are protected at any depth, and package.json and Makefile are on the list (S1)", () => {
  for (const p of [["sub", ".envrc"], ["src", ".gitattributes"], ["packages", "x", "package.json"], ["Makefile"], ["a", "b", "GNUmakefile"], ["pkg", ".npmrc"], [".npmrc"], ["a", "PACKAG~1.JSO"]]) {
    assert.ok(matchProtected(p), p.join("/"));
  }
  assert.equal(matchProtected(["src", "package.json.bak"]), undefined);
  assert.equal(matchProtected(["src", "makefiles", "a.ts"]), undefined);
});

test("protected paths: case, Unicode, ignorable characters, trailing dots and short names", () => {
  assert.ok(matchProtected([".GitHub", "WORKFLOWS", "a.yml"]));
  assert.ok(matchProtected([".G\u200bit"])?.gitDir, "zero-width space (HFS+ ignorable)");
  assert.ok(matchProtected([".g\u200cit", "hooks"])?.gitDir);
  assert.ok(matchProtected(["\uff0egit"])?.gitDir, "fullwidth full stop");
  assert.ok(matchProtected([".git. "])?.gitDir, "NTFS trailing dot and space");
  assert.ok(matchProtected(["GIT~1", "config"])?.gitDir, "8.3 short name");
  assert.ok(matchProtected(["GITHUB~1", "workflows", "x"]), "short name of .github");
  assert.ok(matchProtected([".HUSKY", "x"]));
  assert.ok(matchProtected(["extra", "dir"].slice(0, 0).concat(["deploy"]), [["deploy"]]), "host additions");
});
