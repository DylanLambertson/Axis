// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPath, classifyPathResolved } from "../src/index.js";

const cat = (p: string): string | null => classifyPath(p)?.category ?? null;

test("protected: the documented list", () => {
  const yes: [string, string][] = [
    [".github/workflows/ci.yml", "ci"],
    [".github/actions/x/action.yml", "ci"],
    [".vscode/tasks.json", "editor-config"],
    [".vscode/settings.json", "editor-config"],
    [".husky/pre-commit", "git-hooks"],
    [".githooks/pre-push", "git-hooks"],
    ["lefthook.yml", "git-hooks"],
    [".pre-commit-config.yaml", "git-hooks"],
    [".devcontainer/devcontainer.json", "dev-container"],
    ["Dockerfile", "container-build"],
    ["svc/Dockerfile.prod", "container-build"],
    ["api.Dockerfile", "container-build"],
    ["docker-compose.override.yml", "container-build"],
    ["compose.yaml", "container-build"],
    [".gitlab-ci.yml", "ci"],
    ["Jenkinsfile", "ci"],
    [".circleci/config.yml", "ci"],
    ["package.json", "package-scripts"],
    ["pkg/a/package.json", "package-scripts"],
    [".npmrc", "package-config"],
    [".envrc", "shell-env"],
    ["Makefile", "build-script"],
    [".mcp.json", "agent-config"],
    [".gitmodules", "git-config"],
    [".gitattributes", "git-config"],
    [".git/config", "git-dir"],
    [".git/hooks/pre-commit", "git-dir"],
    ["sub/.git/hooks/x", "git-dir"],
  ];
  for (const [p, c] of yes) assert.equal(cat(p), c, p);
  for (const p of ["src/index.ts", "README.md", "docs/github/workflows.md", "src/.github/workflows/x.yml", ".github/CODEOWNERS", "a/.gitignore", "dockerfile-notes.txt"]) {
    assert.equal(cat(p), null, p);
  }
});

test("protected: case, separators, dot segments and normalisation", () => {
  for (const p of [".GitHub/Workflows/ci.yml", ".GITHUB\\workflows\\ci.yml", "./a/../.github//workflows/x", ".VSCode/TASKS.JSON", "MAKEFILE", "DockerFile"]) {
    assert.notEqual(cat(p), null, p);
  }
  // Unicode: decomposed, compatibility forms and invisible code points that HFS+ and NTFS ignore.
  assert.equal(cat(".g\u200cit/hooks/x"), "git-dir");
  assert.equal(cat(".g\u200bit/hooks/x"), "git-dir");
  assert.equal(cat(".\uff27it/config"), "git-dir", "fullwidth G");
  assert.equal(cat(".husk\u0079/x"), "git-hooks");
  assert.equal(cat(".vscode\u0301/x"), "editor-config", "combining mark");
});

test("protected: NTFS trailing dots and spaces, streams and 8.3 short names", () => {
  for (const p of [".git./config", ".git /config", ".git::$INDEX_ALLOCATION/x", ".github./workflows /x", "GIT~1/hooks/x", "GITHUB~1/WORKFL~1/ci.yml", "VSCODE~1/TASKS~1.JSO", ".husky:stream/x", "PACKAG~1.JSO"]) {
    assert.notEqual(cat(p), null, p);
  }
  assert.equal(cat("GITX~1/x"), null);
});

test("protected: paths that leave the root or cannot be parsed are flagged", () => {
  assert.equal(cat("../x"), "outside-worktree");
  assert.equal(cat("a/../../x"), "outside-worktree");
  assert.equal(cat("/etc/passwd"), "outside-worktree");
  assert.equal(cat("C:\\x"), "outside-worktree");
  assert.equal(cat("a\0b"), "invalid-path");
  assert.equal(cat("a/".repeat(300)), "invalid-path");
  assert.equal(cat("x".repeat(5000)), "invalid-path");
});

test("protected: symlinks that resolve into a protected path or out of the root", { skip: process.platform === "win32" }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "axis-prot-")));
  try {
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, "plain"));
    symlinkSync("../.github/workflows", join(root, "docs", "ci"));
    symlinkSync(join(root, ".git"), join(root, "docs", "abs"));
    symlinkSync("../../outside", join(root, "docs", "out"));
    symlinkSync("loop2", join(root, "loop1"));
    symlinkSync("loop1", join(root, "loop2"));
    symlinkSync("../plain", join(root, "docs", "p"));
    symlinkSync("../.vscode/tasks.json", join(root, "docs", "dangling"));
    writeFileSync(join(root, "plain", "f"), "x");
    const m1 = await classifyPathResolved(root, "docs/ci/build.yml");
    assert.equal(m1?.category, "ci");
    assert.equal(m1?.via, "symlink");
    assert.equal(m1?.resolved, ".github/workflows/build.yml");
    assert.equal((await classifyPathResolved(root, "docs/abs/hooks/pre-commit"))?.category, "git-dir");
    assert.equal((await classifyPathResolved(root, "docs/out/x"))?.category, "outside-worktree");
    assert.equal((await classifyPathResolved(root, "loop1/x"))?.category, "invalid-path");
    assert.equal((await classifyPathResolved(root, "docs/p/f")), null);
    assert.equal((await classifyPathResolved(root, "docs/dangling"))?.category, "editor-config");
    assert.equal((await classifyPathResolved(root, join(root, ".vscode", "settings.json")))?.via, "path");
    assert.equal(await classifyPathResolved(root, "plain/new-file"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
