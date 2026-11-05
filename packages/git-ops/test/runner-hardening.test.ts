// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The host's excludeDirs in exotic shapes, and the argv and environment the runner refuses (--exec-path, GIT_EXEC_PATH).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { GitOpsError, createNodeRunner } from "../src/index.js";
import { readExcludeDirs } from "../src/excludeDirs.js";
import { fixture } from "./realFixture.js";

const posix = process.platform !== "win32";
const REAL_PATH = process.env["PATH"] ?? "";
const version = { argv: ["--version"], env: {}, context: "pty" } as const;
const unavailable = (e: unknown): boolean => e instanceof GitOpsError && e.code === "E_UNAVAILABLE";
const denied = (e: unknown): boolean => e instanceof GitOpsError && e.code === "E_POLICY_DENIED";

function planted(dir: string, name = "git"): string {
  const marker = join(dir, `planted-ran-${name}`);
  writeFileSync(join(dir, name), `#!/bin/sh\necho ran > "${marker}"\nexit 0\n`);
  chmodSync(join(dir, name), 0o755);
  return marker;
}

class Quiet extends Array<string> {
  override [Symbol.iterator](): ArrayIterator<string> { return [][Symbol.iterator](); }
}
class Throwing extends Array<string> {
  override [Symbol.iterator](): ArrayIterator<string> { throw new Error("SECRET iter"); }
}

test("exotic excludeDirs results (Proxy, throwing getter, subclasses, extra property, hole) refuse with a closed E_UNAVAILABLE that echoes nothing", { skip: !posix }, async () => {
  const bad: Array<[string, (dir: string) => unknown]> = [
    ["proxy whose get throws", () => new Proxy([], { get() { throw new Error("SECRET proxy get"); } })],
    ["transparent proxy", (d) => new Proxy([d], {})],
    ["index getter that throws", () => { const a: string[] = []; Object.defineProperty(a, "0", { get() { throw new Error("SECRET getter"); }, enumerable: true }); return a; }],
    ["index getter that works", (d) => { const a: string[] = []; Object.defineProperty(a, "0", { get: () => d, enumerable: true }); return a; }],
    ["subclass with a throwing iterator", () => Throwing.from(["/"])],
    ["subclass with an empty iterator", () => { const q = new Quiet(); q.push("/some/dir"); return q; }],
    ["array with an extra property", (d) => Object.assign([d], { extra: 1 })],
    ["array with a hole", () => new Array<string>(1)],
    ["array with a null prototype", (d) => Object.setPrototypeOf([d], null)],
  ];
  for (const [name, make] of bad) {
    const a = fixture();
    const b = fixture();
    const marker = planted(b.wt.workTree);
    const env = { PATH: `${b.wt.workTree}${delimiter}${REAL_PATH}` };
    const runner = createNodeRunner({ allowPtyContext: true, env, excludeDirs: () => make(a.wt.workTree) as readonly string[] });
    await assert.rejects(runner.run({ ...version, cwd: a.wt.workTree }), (e: unknown) => {
      assert.ok(e instanceof GitOpsError, `${name}: a raw error leaked: ${String(e)}`);
      assert.equal(e.code, "E_UNAVAILABLE", name);
      assert.doesNotMatch(e.message, /SECRET/, name);
      return true;
    });
    assert.equal(existsSync(marker), false, `${name}: the planted git ran`);
  }
});

test("a plain array of data entries is accepted by readExcludeDirs and is a copy", () => {
  const src = ["/a/b", "/c"];
  const got = readExcludeDirs(() => src, process.platform);
  assert.deepEqual(got, ["/a/b", "/c"]);
  assert.notEqual(got, src);
  assert.throws(() => readExcludeDirs(() => { throw new Error("SECRET"); }, process.platform), unavailable);
});

test("excludeDirs: duplicates (by spelling and by real path) are dropped, and more than 1024 entries are refused", { skip: !posix }, () => {
  const f = fixture();
  const link = join(f.root, "dup-link");
  symlinkSync(f.wt.workTree, link);
  assert.deepEqual(readExcludeDirs(() => [f.wt.workTree, f.wt.workTree, link], process.platform), [f.wt.workTree]);
  const many = Array.from({ length: 1024 }, () => f.wt.workTree);
  assert.equal(readExcludeDirs(() => many, process.platform).length, 1);
  assert.throws(() => readExcludeDirs(() => [...many, f.wt.workTree], process.platform), unavailable);
  const huge = new Array<string>(2 ** 20).fill(f.wt.workTree);
  const t0 = Date.now();
  assert.throws(() => readExcludeDirs(() => huge, process.platform), unavailable);
  assert.ok(Date.now() - t0 < 2000, "an oversize list is refused without resolving every entry");
});

test("--exec-path in any form is refused in the option area; nothing planted in the worktree runs", { skip: !posix }, async () => {
  const f = fixture();
  planted(f.wt.workTree, "git-axisx");
  const runner = createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true });
  for (const argv of [[`--exec-path=${f.wt.workTree}`, "axisx"], ["--exec-path", "axisx"], ["--exec-path=", "axisx"], ["-c", "a.b=c", `--exec-path=${f.wt.workTree}`, "axisx"]]) {
    await assert.rejects(runner.run({ argv, cwd: f.wt.workTree, env: {}, context: "pty" }), denied, JSON.stringify(argv));
  }
  assert.equal(existsSync(join(f.wt.workTree, "planted-ran-git-axisx")), false);
});

test("GIT_EXEC_PATH, GIT_CONFIG* and GIT_DIR in the request environment are refused; nothing planted in the worktree runs", { skip: !posix }, async () => {
  const f = fixture();
  planted(f.wt.workTree, "git-axisx");
  const runner = createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true });
  for (const env of [{ GIT_EXEC_PATH: f.wt.workTree }, { git_exec_path: f.wt.workTree }, { GIT_CONFIG_GLOBAL: "/x" }, { GIT_CONFIG_COUNT: "0" }, { GIT_DIR: "/y" }]) {
    await assert.rejects(runner.run({ argv: ["axisx"], cwd: f.wt.workTree, env, context: "pty" }), denied, JSON.stringify(env));
  }
  assert.equal(existsSync(join(f.wt.workTree, "planted-ran-git-axisx")), false);
});

test("only git's option area is scanned: a pathspec -Cache after `--` or the subcommand and a -c value starting with -C are data", { skip: !posix }, async () => {
  const f = fixture();
  const runner = createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true });
  const ok = async (argv: string[]): Promise<void> => {
    const r = await runner.run({ argv, cwd: f.wt.workTree, env: {}, context: "pty" });
    assert.equal(r.code, 0, `${JSON.stringify(argv)}: ${r.stderr}`);
  };
  await ok(["status", "--porcelain", "--", "-Cache"]);
  await ok(["ls-files", "--", "-Cache", "--exec-path=x"]);
  await ok(["-c", "user.name=-Cx", "status", "--porcelain"]);
  // Control: the same text in the option area is refused.
  await assert.rejects(runner.run({ argv: ["-Cache", "status"], cwd: f.wt.workTree, env: {}, context: "pty" }), denied);
  await assert.rejects(runner.run({ argv: ["-c", "a.b=c", "-C", f.wt.workTree, "status"], cwd: f.wt.workTree, env: {}, context: "pty" }), denied);
});
