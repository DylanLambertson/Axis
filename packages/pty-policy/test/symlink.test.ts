// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkExecutable, gitConfigFileWarnings, resolveExecutable, resolveLaunch, type ExecFs } from "../src/index.js";

const posixOnly = { skip: process.platform === "win32" };

/** A real temp tree: <base>/wt (the worktree, with an executable), <base>/wt2 (another worktree), <base>/bin (a good PATH dir). */
function tree() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "axis-pty-")));
  const wt = join(base, "wt");
  const wt2 = join(base, "wt2");
  const bin = join(base, "bin");
  for (const d of [wt, wt2, bin]) mkdirSync(d);
  for (const f of [join(wt, "evil"), join(wt2, "evil"), join(bin, "good")]) {
    writeFileSync(f, "#!/bin/sh\n");
    chmodSync(f, 0o755);
  }
  return { base, wt, wt2, bin, done: () => rmSync(base, { recursive: true, force: true }) };
}

const agentOf = (command0: string) => ({ id: "a", label: "A", command: [command0] });
const launch = (t: ReturnType<typeof tree>, command0: string, PATH: string, extra: Record<string, unknown> = {}) =>
  resolveLaunch({ agent: agentOf(command0), worktreeRoot: t.wt, trusted: true, parentEnv: { PATH }, platform: process.platform, ...extra });

test("a PATH entry that is a symlink into the worktree does not win", posixOnly, () => {
  const t = tree();
  try {
    symlinkSync(t.wt, join(t.base, "linkdir"));
    const r = launch(t, "evil", `${join(t.base, "linkdir")}:${t.bin}`);
    assert.ok(!r.ok && r.code === "EXECUTABLE_NOT_FOUND", JSON.stringify(r));
  } finally {
    t.done();
  }
});

test("a file symlink in a good PATH directory that points into the worktree does not win", posixOnly, () => {
  const t = tree();
  try {
    symlinkSync(join(t.wt, "evil"), join(t.bin, "viaLink"));
    const r = launch(t, "viaLink", t.bin);
    assert.ok(!r.ok && r.code === "EXECUTABLE_NOT_FOUND", JSON.stringify(r));
  } finally {
    t.done();
  }
});

test("an absolute command reached through a symlinked directory is refused", posixOnly, () => {
  const t = tree();
  try {
    symlinkSync(t.wt, join(t.base, "linkdir"));
    const r = launch(t, join(t.base, "linkdir", "evil"), t.bin);
    assert.ok(!r.ok && r.code === "EXECUTABLE_NOT_FOUND", JSON.stringify(r));
  } finally {
    t.done();
  }
});

test("a symlink to an executable outside every worktree is still accepted (no false positive)", posixOnly, () => {
  const t = tree();
  try {
    symlinkSync(join(t.bin, "good"), join(t.bin, "alias"));
    const r = launch(t, "alias", t.bin);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.argv[0], join(t.bin, "alias"));
  } finally {
    t.done();
  }
});

test("N6: a PATH directory inside ANOTHER managed worktree is refused when all roots are passed", posixOnly, () => {
  const t = tree();
  try {
    assert.ok(launch(t, "evil", t.wt2).ok, "without the list only the current worktree is excluded");
    const r = launch(t, "evil", t.wt2, { managedWorktreeRoots: [t.wt, t.wt2] });
    assert.ok(!r.ok && r.code === "EXECUTABLE_NOT_FOUND");
    symlinkSync(t.wt2, join(t.base, "link2"));
    assert.ok(!launch(t, "evil", join(t.base, "link2"), { managedWorktreeRoots: [t.wt2] }).ok);
  } finally {
    t.done();
  }
});

test("resolveExecutable honours an injected realPath and ignores a fs without one", () => {
  const fs: ExecFs = {
    isExecutableFile: (p) => p === "/p/tool",
    realPath: (p) => (p === "/p/tool" ? "/w/tool" : p),
  };
  assert.equal(resolveExecutable("tool", { PATH: "/p" }, "linux", fs, { excludeDirs: ["/w"] }), undefined);
  assert.equal(resolveExecutable("tool", { PATH: "/p" }, "linux", { isExecutableFile: fs.isExecutableFile }, { excludeDirs: ["/w"] }), "/p/tool");
});

test("darwin folds case for the inside-worktree test; linux does not", () => {
  const fs: ExecFs = { isExecutableFile: () => true };
  const run = (platform: NodeJS.Platform) =>
    resolveLaunch({ agent: agentOf("/r/WT/evil"), worktreeRoot: "/r/wt", trusted: true, parentEnv: { PATH: "/b" }, platform, fs });
  assert.ok(!run("darwin").ok);
  assert.ok(run("linux").ok);
});

test("gitConfigFileWarnings follows symlinks into a worktree and folds case on darwin", posixOnly, () => {
  const t = tree();
  try {
    symlinkSync(t.wt, join(t.base, "linkdir"));
    const via = join(t.base, "linkdir", ".gitconfig");
    assert.equal(gitConfigFileWarnings({ GIT_CONFIG_GLOBAL: via }, [t.wt], process.platform).length, 1);
    assert.equal(gitConfigFileWarnings({ GIT_CONFIG_GLOBAL: join(t.bin, "cfg") }, [t.wt], process.platform).length, 0);
    assert.equal(gitConfigFileWarnings({ GIT_CONFIG_GLOBAL: "/R/WT/.gitconfig" }, ["/r/wt"], "darwin").length, 1);
    assert.equal(gitConfigFileWarnings({ GIT_CONFIG_GLOBAL: "/R/WT/.gitconfig" }, ["/r/wt"], "linux").length, 0);
  } finally {
    t.done();
  }
});

test("N1: win32 refuses alternate data streams and a trailing separator", () => {
  for (const c of ["C:\\a.exe:ads", "C:\\t\\a.cmd:x", "C:\\t\\a.exe:$DATA", "C:\\t\\dir\\", "C:/t/dir/", "C:\\t\\a.exe:"]) {
    assert.ok(checkExecutable(c, "win32"), c);
  }
  assert.equal(checkExecutable("C:\\t\\a.exe", "win32"), undefined);
});

test("N2: win32 PATHEXT resolves only .exe and .com", () => {
  const fs: ExecFs = { isExecutableFile: (p) => /x\.(vbs|ps1|exe|com)$/i.test(p) };
  assert.equal(resolveExecutable("x", { PATH: "C:\\bin", PATHEXT: ".VBS;.PS1;.EXE" }, "win32", fs), "C:\\bin\\x.EXE");
  assert.equal(resolveExecutable("x", { PATH: "C:\\bin", PATHEXT: ".VBS;.PS1" }, "win32", fs), undefined);
  assert.equal(resolveExecutable("x.vbs", { PATH: "C:\\bin", PATHEXT: ".VBS;.EXE" }, "win32", fs), undefined);
});
