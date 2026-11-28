// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-3a (terminals-contract.md section 3): the shell is the daemon's `$SHELL` when it is an absolute path to an existing, executable
// regular file listed in /etc/shells; otherwise `/bin/sh` under the same rule; otherwise none (`shell_unavailable`). Windows: none.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { pickShell, type ShellDeps } from "../../src/terminals/shell.js";

const skip = process.platform === "win32" ? "POSIX files and modes" : false;

/** A sandbox: real files, and an /etc/shells text the test writes. */
function box(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "axis-shell-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = (name: string, mode = 0o755): string => {
    const p = join(root, name);
    writeFileSync(p, "#!/x\n");
    chmodSync(p, mode);
    return p;
  };
  const deps = (shellEnv: string | undefined, listed: readonly string[], binSh: string, platform: NodeJS.Platform = "linux"): ShellDeps => ({
    env: shellEnv === undefined ? {} : { SHELL: shellEnv },
    platform,
    readShells: async () => `# /etc/shells: valid login shells\n${listed.join("\n")}\n`,
    fallback: binSh,
  });
  return { root, file, deps };
}

test("$SHELL is used when it is absolute, a regular executable file, and listed", { skip }, async (t) => {
  const b = box(t);
  const zsh = b.file("zsh");
  const sh = b.file("sh");
  assert.equal(await pickShell(b.deps(zsh, [zsh, sh], sh)), zsh);
});

test("each failing $SHELL falls back to /bin/sh when that passes the same rule", { skip }, async (t) => {
  const b = box(t);
  const sh = b.file("sh");
  const notExec = b.file("noexec", 0o644);
  const unlisted = b.file("unlisted");
  const dir = join(b.root, "adir");
  mkdirSync(dir);
  for (const [label, shell, listed] of [
    // A relative path that resolves from this process's directory to a real, listed, executable file is still refused.
    ["a relative path", relative(process.cwd(), b.file("rel-zsh")), [relative(process.cwd(), join(b.root, "rel-zsh")), sh]],
    ["a missing file", join(b.root, "missing"), [join(b.root, "missing"), sh]],
    ["a file that is not executable", notExec, [notExec, sh]],
    ["a path not in /etc/shells", unlisted, [sh]],
    ["a directory", dir, [dir, sh]],
    ["unset", undefined, [sh]],
    ["empty", "", [sh]],
  ] as const) {
    assert.equal(await pickShell(b.deps(shell, listed, sh)), sh, label);
  }
});

test("neither usable: none; and Windows is none in this slice", { skip }, async (t) => {
  const b = box(t);
  const unlistedSh = b.file("sh");
  const zsh = b.file("zsh");
  assert.equal(await pickShell(b.deps(join(b.root, "missing"), [], unlistedSh)), undefined, "/bin/sh not listed");
  assert.equal(await pickShell(b.deps(zsh, [zsh], b.file("sh2", 0o644), "win32")), undefined, "win32");
  assert.equal(await pickShell(b.deps(undefined, [b.file("sh3", 0o644)], join(b.root, "sh3"))), undefined, "/bin/sh not executable");
});

test("an unreadable /etc/shells lists nothing (fail closed)", { skip }, async (t) => {
  const b = box(t);
  const zsh = b.file("zsh");
  const deps = { ...b.deps(zsh, [zsh], zsh), readShells: async () => { throw new Error("EACCES"); } };
  assert.equal(await pickShell(deps), undefined);
});

test("a listed line only counts whole: comments, blanks and a prefix do not list a shell", { skip }, async (t) => {
  const b = box(t);
  const zsh = b.file("zsh");
  for (const lines of [[`# ${zsh}`], [`${zsh}x`], [`${zsh.slice(0, -1)}`], [""]]) assert.equal(await pickShell(b.deps(zsh, lines, join(b.root, "none"))), undefined, JSON.stringify(lines));
  assert.equal(await pickShell(b.deps(zsh, [`  ${zsh}  `], join(b.root, "none"))), zsh, "surrounding spaces are trimmed");
});
