// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { judgeDrift, parseSnapshot, takeSnapshot, type TakeOptions } from "../src/index.js";
import { parseListOutput, resolveGit, trustedPathEntries } from "../src/git.js";
import { git, makeFixture, write, type Fixture } from "./helpers.js";

const posix = process.platform !== "win32";
const realPath = process.env["PATH"] ?? "";

const opts = (f: Fixture, more: Partial<TakeOptions> = {}): TakeOptions => ({ worktreePath: f.wt, commonDir: f.common, homeDir: f.home, ...more });

/** A stand-in `git` outside the worktree that logs how it was started and then runs the real one. */
async function logging(f: Fixture, extra = ""): Promise<{ path: string; log: () => string }> {
  const real = resolveGit(realPath, []);
  assert.ok(real !== null, "a git must be installed to run these tests");
  const dir = join(f.root, "bin");
  mkdirSync(dir, { recursive: true });
  const log = join(f.root, "git.log");
  const path = join(dir, "git");
  writeFileSync(path, `#!/bin/sh\n{ echo "CWD=$(pwd)"; echo "ARGS=$*"; env | grep -E '^(GIT_|HOME=|PATH=)'; echo ---; } >> '${log}'\n${extra}\nexec '${real}' "$@"\n`);
  chmodSync(path, 0o755);
  return { path, log: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
}

test("N1: core.worktree in config.worktree moves where hooks run, and the link is refused", { skip: !posix }, async (t: TestContext) => {
  const f = makeFixture();
  try {
    const other = join(f.root, "elsewhere");
    mkdirSync(join(other, "tools", "hooks"), { recursive: true });
    git(f.main, "config", "core.repositoryformatversion", "1");
    git(f.main, "config", "extensions.worktreeConfig", "true");
    git(f.main, "config", "core.hooksPath", "tools/hooks");
    const name = execFileSync("ls", [join(f.common, "worktrees")], { encoding: "utf8" }).trim();
    writeFileSync(join(f.common, "worktrees", name, "config.worktree"), `[core]\n\tworktree = ${other}\n`);
    const top = git(f.wt, "rev-parse", "--show-toplevel").trim();
    if (top === f.wt) return t.skip("this git ignores core.worktree in config.worktree, so the attack cannot be staged");
    const s = await takeSnapshot(opts(f));
    assert.equal(s.link.mismatch, true, "the top level git uses is not the worktree");
    assert.equal(judgeDrift({ baseline: s, current: s }).status, "refused");
    // The hook directory is the one git runs from, under git's top level, not under the worktree.
    assert.ok(s.entries.some((e) => e.id.startsWith("hookspath:") && e.path.startsWith(other)), JSON.stringify(s.entries.map((e) => e.id)));
  } finally {
    f.cleanup();
  }
});

test("N2: a git planted in the worktree never runs, with an empty or relative PATH entry", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const marker = join(f.root, "ran");
    for (const where of [f.wt, join(f.wt, "bin")]) {
      mkdirSync(where, { recursive: true });
      writeFileSync(join(where, "git"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
      chmodSync(join(where, "git"), 0o755);
    }
    for (const lead of [":", ".:", "bin:", `${f.wt}:`, `${join(f.wt, "bin")}:`]) {
      const s = await takeSnapshot(opts(f, { env: { PATH: lead + realPath } }));
      assert.equal(existsSync(marker), false, `planted git ran for PATH prefix ${JSON.stringify(lead)}`);
      assert.equal(s.incomplete.length, 0, JSON.stringify(s.incomplete));
    }
    // No usable git outside the worktrees: blocking, not a fallback to a bare name.
    const none = await takeSnapshot(opts(f, { env: { PATH: `:.:${f.wt}` } }));
    assert.equal(existsSync(marker), false);
    assert.ok(none.incomplete.some((i) => i.id === "git" && i.blocking));
    assert.equal(judgeDrift({ baseline: none, current: none }).status, "refused");
    await assert.rejects(takeSnapshot(opts(f, { gitPath: join(f.wt, "git") })), /outside every worktree/);
    await assert.rejects(takeSnapshot(opts(f, { gitPath: "git" })), /absolute/);
  } finally {
    f.cleanup();
  }
});

test("path entries: only absolute ones are searched", () => {
  assert.deepEqual(trustedPathEntries(":/a::b:./c:/d", "linux"), ["/a", "/d"]);
  // Windows rules (pty-policy's), judged lexically so they hold on any host: drive-letter paths only.
  assert.deepEqual(trustedPathEntries("C:\\x;;bin;D:\\y;\\\\srv\\share\\bin;\\root\\bin;\\\\?\\C:\\x", "win32"), ["C:\\x", "D:\\y"]);
});

test("every git call is hardened: -C, neutral cwd, absolute git, GIT-ENV-1, no user or system config, ceiling", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const g = await logging(f);
    appendFileSync(join(f.home, ".gitconfig"), "[alias]\n\tfromglobal = x\n[core]\n\thooksPath = /tmp/from-global\n");
    const hostile = { PATH: realPath, GIT_DIR: "/nowhere", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/tmp/evil", GIT_CONFIG_PARAMETERS: "'core.hooksPath=/tmp/evil'", GIT_EXEC_PATH: "/nowhere", GIT_CONFIG_GLOBAL: join(f.home, ".gitconfig") };
    const s = await takeSnapshot(opts(f, { gitPath: g.path, env: hostile }));
    assert.equal(s.incomplete.length, 0, JSON.stringify(s.incomplete));
    assert.ok(!s.settings.some((x) => x.key === "alias.fromglobal" || x.label === "core.hooksPath"), "user config reached the answer");
    const log = g.log();
    const calls = log.split("---\n").filter((c) => c !== "");
    assert.ok(calls.length >= 5, `git was started ${calls.length} times`);
    for (const c of calls) {
      assert.match(c, /CWD=\/\n/, "a neutral working directory");
      assert.match(c, new RegExp(`ARGS=-C ${f.wt} --no-pager --no-replace-objects -c core\\.fsmonitor=false -c safe\\.directory=${f.wt} `));
      assert.match(c, /\nGIT_CONFIG_NOSYSTEM=1\n/);
      assert.match(c, /\nGIT_CONFIG_GLOBAL=\/dev\/null\n/);
      assert.match(c, new RegExp(`\\nGIT_CEILING_DIRECTORIES=${f.root}\\n`));
      assert.match(c, /\nGIT_TERMINAL_PROMPT=0\n/);
      for (const bad of ["GIT_DIR=", "GIT_CONFIG_COUNT=", "GIT_CONFIG_PARAMETERS=", "GIT_EXEC_PATH=", "GIT_CONFIG_KEY_0="]) assert.ok(!c.includes(bad), bad);
      assert.match(c, new RegExp(`\\nHOME=${f.home}\\n`));
    }
  } finally {
    f.cleanup();
  }
});

test("a hook directory that git names and the settings do not is still hashed", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const odd = join(f.root, "git-named-hooks");
    mkdirSync(odd);
    write(join(odd, "pre-commit"), "#!/bin/sh\n", 0o755);
    const g = await logging(f, `case "$*" in *--git-path*) echo '${odd}'; exit 0;; esac`);
    const s = await takeSnapshot(opts(f, { gitPath: g.path }));
    assert.ok(s.entries.some((e) => e.id === `hookspath:${odd}/pre-commit`), JSON.stringify(s.entries.map((e) => e.id)));
  } finally {
    f.cleanup();
  }
});

test("a worktree that is not a git worktree, nested in another repository, is refused (the ceiling)", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const sub = join(f.main, "sub");
    mkdirSync(sub);
    const s = await takeSnapshot({ worktreePath: sub, commonDir: f.common, homeDir: f.home });
    assert.ok(s.incomplete.some((i) => i.id === "git" && i.blocking), JSON.stringify(s.incomplete));
    assert.equal(judgeDrift({ baseline: s, current: s }).status, "refused");
  } finally {
    f.cleanup();
  }
});

test("a git that hangs is cut by the time budget, and cancellation reaches the process", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const g = await logging(f, "exec sh -c 'exec sleep 30'");
    const t0 = Date.now();
    const s = await takeSnapshot(opts(f, { gitPath: g.path, limits: { maxMillis: 1500 } }));
    assert.ok(Date.now() - t0 < 4500, `took ${Date.now() - t0} ms`);
    assert.ok(s.incomplete.some((i) => i.blocking), "a hung git leaves the snapshot incomplete");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const t1 = Date.now();
    await assert.rejects(takeSnapshot(opts(f, { gitPath: g.path, signal: ac.signal })), /cancelled/);
    assert.ok(Date.now() - t1 < 4000, `cancel took ${Date.now() - t1} ms`);
  } finally {
    f.cleanup();
  }
});

test("a non-UTF-8 include path blocks", async () => {
  const f = makeFixture();
  try {
    appendFileSync(join(f.common, "config"), Buffer.concat([Buffer.from("[include]\n\tpath = x"), Buffer.from([0xff]), Buffer.from("\n")]));
    const s = await takeSnapshot(opts(f));
    assert.ok(s.incomplete.some((i) => i.blocking && /not UTF-8/.test(i.reason)), JSON.stringify(s.incomplete));
  } finally {
    f.cleanup();
  }
});

test("harmless keys do not count toward the settings cap; security keys still do", async () => {
  const f = makeFixture();
  try {
    appendFileSync(join(f.common, "config"), Array.from({ length: 100 }, (_, i) => `[branch "b${i}"]\n\tremote = origin\n`).join(""));
    const ok = await takeSnapshot(opts(f, { limits: { maxSettings: 20 } }));
    assert.ok(!ok.incomplete.some((i) => i.id === "settings"), JSON.stringify(ok.incomplete));
    appendFileSync(join(f.common, "config"), Array.from({ length: 30 }, (_, i) => `[alias]\n\ta${i} = status\n`).join(""));
    const full = await takeSnapshot(opts(f, { limits: { maxSettings: 20 } }));
    assert.ok(full.incomplete.some((i) => i.id === "settings" && i.blocking));
  } finally {
    f.cleanup();
  }
});

test("git's output is bounded: more entries than the cap is unreadable, and the scan never builds a piece array", async () => {
  const out = Buffer.concat(Array.from({ length: 50 }, (_, i) => Buffer.from(`file:/x\0a.k${i}\nv\0`, "latin1")));
  assert.equal(parseListOutput(out, 49), null);
  assert.equal(parseListOutput(out, 50)?.length, 50);
  assert.equal(parseListOutput(Buffer.from("file:/x\0a.k\nv")), null, "a record without its NUL");
  const f = makeFixture();
  try {
    appendFileSync(join(f.common, "config"), `[a]\n${"\tk = v\n".repeat(20_000)}`);
    const t0 = Date.now();
    const s = await takeSnapshot(opts(f));
    assert.ok(Date.now() - t0 < 5000);
    assert.ok(s.incomplete.some((i) => i.id === "git" && i.blocking));
  } finally {
    f.cleanup();
  }
});

test("a snapshot stored by an older layout is refused", async () => {
  const f = makeFixture();
  try {
    const s = await takeSnapshot(opts(f));
    assert.equal(s.version, 2);
    assert.throws(() => parseSnapshot({ ...s, version: 1 }), /not a valid snapshot/);
  } finally {
    f.cleanup();
  }
});
