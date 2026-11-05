// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPath, classifyPathResolved } from "../src/index.js";

const cat = (p: string, extra?: readonly string[]): string | null => classifyPath(p, extra === undefined ? {} : { extraPaths: extra })?.category ?? null;

test("hidden-config: any root-level dot name outside the small allowlist, file or directory, with the files under it", () => {
  for (const p of [".alpha", ".alpha/", ".alpha/x.json", ".beta.json", ".toolrc/settings", ".sidecar/settings.json", ".a", ".-x", "./.alpha/x", "a/../.alpha"]) {
    assert.equal(cat(p), "hidden-config", p);
  }
});

const sev = (p: string): string | undefined => classifyPath(p)?.severity;

test("hidden-config: any depth, high severity; ordinary names are not matches", () => {
  for (const p of ["src/.alpha/x.ts", "a/b/.beta.json", "sub/.toolx/settings.json", "sub/deep/.toolx.json", "x/.nvmrc", ".nvmrc", ".node-version"]) {
    assert.equal(cat(p), "hidden-config", p);
    assert.equal(sev(p), "high", p);
  }
  for (const p of ["src/index.ts", "alpha", "a.b", "docs/README.md", "src/notes.md", "docs/design.md"]) assert.equal(cat(p), null, p);
});

test("ignore and style files are reviewable, not exempt: medium severity, any depth, exact final name only", () => {
  for (const p of [".gitignore", "sub/.gitignore", ".DOCKERIGNORE", ".prettierignore", "a/b/.eslintignore", ".gitignore ", ".gitignore::$DATA"]) {
    assert.equal(cat(p), "ignore-rules", p);
    assert.equal(sev(p), "medium", p);
  }
  assert.equal(cat(".editorconfig"), "hidden-config");
  assert.equal(sev(".editorconfig"), "medium");
  // An exemption never covers anything under that name.
  for (const p of [".gitignore/x", "sub/.editorconfig/x", ".dockerignore/a/b"]) {
    assert.equal(cat(p), "hidden-config", p);
    assert.equal(sev(p), "high", p);
  }
});

test("hidden-config: the specific categories keep their dot names", () => {
  assert.equal(cat(".github/workflows/ci.yml"), "ci");
  assert.equal(cat(".vscode/x"), "editor-config");
  assert.equal(cat(".husky/pre-commit"), "git-hooks");
  assert.equal(cat(".githooks/x"), "git-hooks");
  assert.equal(cat(".devcontainer/devcontainer.json"), "dev-container");
  assert.equal(cat(".npmrc"), "package-config");
  assert.equal(cat(".git/config"), "git-dir");
  assert.equal(cat(".gitmodules"), "git-config");
  for (const p of [".env", ".env.local", ".ENV.production", "sub/.env"]) assert.equal(cat(p), "shell-env", p);
  assert.equal(cat(".github/CODEOWNERS"), "hidden-config");
  assert.equal(cat(".github/workflows/x.yml/.gitignore"), "ci");
});

test("hidden-config: case, separators, normalisation, ignorable code points, NTFS dots, streams and 8.3 names", () => {
  for (const p of [".ALPHA", ".Alpha/X", ".alpha\\x", ".​alpha", "．alpha", ".alpha.", ".alpha ", ".alpha::$DATA", ".alphá", ".K", "ALPHA~1", "ALPHA~1/x", "BETA~2.JSO"]) {
    assert.equal(cat(p), "hidden-config", JSON.stringify(p));
  }
});

test("instruction-file: a root-level .md file that is not a common project document", () => {
  for (const p of ["PLAYBOOK.md", "INSTRUCTIONS.md", "NOTES.MD", "playbook.md", "Playbook.Md", "RUN_BOOK-2.md", "PLAYBO~1.MD", "PLAYBOOK.md.", "PLAYBOOK.md ", "PLAYBOOK.md::$DATA", "ＰLAYBOOK.md"]) {
    assert.ok(["instruction-file", "hidden-config"].includes(cat(p) ?? ""), JSON.stringify(p));
  }
  assert.equal(cat("PLAYBOOK.md"), "instruction-file");
  assert.equal(cat("playbook.md"), "instruction-file", "case-insensitive: the same file on a case-insensitive volume");
  for (const p of ["README.md", "readme.md", "LICENSE.md", "LICENCE.md", "NOTICE.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md", "AUTHORS.md", "MAINTAINERS.md", "CODEOWNERS.md", "SUPPORT.md", "GOVERNANCE.md", "TODO.md", "HISTORY.md", "RELEASE.md"]) {
    assert.equal(cat(p), null, p);
  }
});

test("instruction-file: upper-case stems, dotted or not, at any depth; severity high", () => {
  for (const p of ["TOOLX.md", "TOOLX.local.md", "TOOLX.override.md", "sub/TOOLX.md", "a/b/TOOLX.local.md", "PLAYBOOK.v2.md", "sub/NOTES.MD", "RUN_BOOK-2.md", "toolx.md"]) {
    assert.equal(cat(p), "instruction-file", p);
    assert.equal(sev(p), "high", p);
  }
});

test("instruction-file: lower-case ordinary documents below the root, other extensions and odd names stay unmarked", () => {
  for (const p of ["docs/PLAYBOOK.txt", "PLAYBOOK.txt", "PLAYBOOK", "PLAY BOOK.md", "PLAYBOOK.md.bak", "docs/toolx.md", "docs/a.b.md", "docs/README.md", "docs/README.local.md", "docs/Readme.md", "docs/LICENSE.md", "sub/CHANGELOG.md"]) {
    assert.equal(cat(p), null, p);
  }
});

test("the caller's own names are still added through extraPaths, with the same rules", () => {
  assert.equal(cat("tools/x/y", ["tools/x"]), "caller-defined");
  assert.equal(cat("TOOLS/X", ["tools/x"]), "caller-defined");
  assert.equal(cat("nested/notes.md", ["nested/notes.md"]), "caller-defined");
});

test("overlap: a path in two categories reports the specific one", () => {
  assert.equal(cat(".github/workflows/x.yml"), "ci");
  assert.equal(cat(".git/hooks/x"), "git-dir");
  assert.equal(cat(".npmrc"), "package-config");
});

test("symlinks: a link that lands on a generic match is reported, one that leaves the root is outside", async () => {
  const root = mkdtempSync(join(tmpdir(), "axis-prot-"));
  try {
    mkdirSync(join(root, ".alpha"));
    writeFileSync(join(root, "PLAYBOOK.md"), "x");
    mkdirSync(join(root, "docs"));
    symlinkSync(join(root, ".alpha"), join(root, "docs", "link"));
    symlinkSync("../PLAYBOOK.md", join(root, "docs", "pb"));
    symlinkSync("/etc", join(root, "docs", "out"));
    const a = await classifyPathResolved(root, "docs/link/x.json");
    assert.equal(a?.category, "hidden-config");
    assert.equal(a?.via, "symlink");
    const b = await classifyPathResolved(root, "docs/pb");
    assert.equal(b?.category, "instruction-file");
    assert.equal(b?.via, "symlink");
    assert.equal((await classifyPathResolved(root, "docs/out/passwd"))?.category, "outside-worktree");
    assert.equal(await classifyPathResolved(root, "docs/plain.md"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("100,000 paths retain their category across a large mixed input", () => {
  const paths: string[] = [];
  for (let i = 0; i < 100_000; i++) paths.push(i % 4 === 0 ? `.alpha${i}/f` : i % 4 === 1 ? `src/mod${i}/index.ts` : i % 4 === 2 ? `NOTES${i}.md` : `docs/deep/${i}/x.txt`);
  const categories = new Map<string, number>();
  for (const p of paths) {
    const category = classifyPath(p)?.category ?? "none";
    categories.set(category, (categories.get(category) ?? 0) + 1);
  }
  assert.deepEqual([...categories].sort(), [["hidden-config", 25_000], ["instruction-file", 25_000], ["none", 50_000]]);
});

test("instruction-file at the root: dotted names in any case, judged by the first segment against the common documents", () => {
  for (const p of ["toolx.local.md", "Toolx.Local.md", "TOOLX.local.md", "toolx.override.md", "a.b.md", "PLAYBO~1.MD"]) {
    assert.ok(cat(p) !== null, p);
  }
  for (const p of ["toolx.local.md", "a.b.md"]) assert.equal(cat(p), "instruction-file", p);
  for (const p of ["readme.local.md", "README.ja.md", "License.txt.md", "changelog.2024.md"]) assert.equal(cat(p), null, p);
});

test("instruction-file below the root: any upper-case letter in the first segment, so one changed letter does not evade", () => {
  for (const p of ["sub/Toolx.md", "sub/tOOLx.md", "sub/Toolx.local.md", "sub/NOTE\u017f.md", "sub/not\u212a.md", "a/b/ToolX.md"]) {
    assert.equal(cat(p), "instruction-file", p);
  }
  for (const p of ["sub/toolx.md", "sub/toolx.local.md", "sub/notes.md"]) assert.equal(cat(p), null, p);
});

test("a path with dot segments is judged where it lands", () => {
  assert.equal(cat("sub/x/../TOOLX.md"), "instruction-file");
  assert.equal(cat("sub/x/../../.alpha/c"), "hidden-config");
  assert.equal(cat("./sub//TOOLX.md"), "instruction-file");
});

test("root instruction names: the dotless-i spelling and the grown common-documents list", () => {
  assert.equal(cat("toolxı.md"), "instruction-file");
  assert.equal(cat("TOOLXı.local.md"), "instruction-file");
  for (const p of ["FAQ.md", "HACKING.md", "OWNERS.md", "ARCHITECTURE.md", "sub/FUNDING.md", "THIRD-PARTY-NOTICES.md"]) assert.equal(cat(p), null, p);
});

test("the dotless-i spelling counts below the root too", () => {
  for (const p of ["sub/toolx\u0131.md", "sub/\u0131ool.local.md", "a/b/n\u0131tes.md"]) assert.equal(cat(p), "instruction-file", p);
  assert.equal(cat("sub/toolxi.md"), null);
});
