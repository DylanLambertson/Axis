// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The host's excludeDirs in exotic shapes, and the argv and environment the runner refuses (--exec-path, GIT_EXEC_PATH).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { GitOpsError, createNodeRunner } from "../src/index.js";
import { BAD_EXCLUDES, readExcludeDirs } from "../src/excludeDirs.js";
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
      assert.equal(e.message, BAD_EXCLUDES, `${name}: refused by something other than the shape check`);
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

test("only git's option area is scanned: a pathspec -Cache after the subcommand and a -c value starting with -C are data", { skip: !posix }, async () => {
  const f = fixture();
  const runner = createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true });
  const ok = async (argv: string[]): Promise<void> => {
    const r = await runner.run({ argv, cwd: f.wt.workTree, env: {}, context: "pty" });
    assert.equal(r.code, 0, `${JSON.stringify(argv)}: ${r.stderr}`);
  };
  await ok(["status", "--porcelain", "--", "-Cache"]);
  await ok(["ls-files", "--", "-Cache", "--exec-path=x"]);
  await ok(["-c", "user.name=-Cx", "status", "--porcelain"]);
  await ok(["--no-pager", "--no-replace-objects", `--git-dir=${f.wt.gitDir}`, `--work-tree=${f.wt.workTree}`, "-c", "core.fsmonitor=false", "status", "--porcelain"]);
  // Control: the same text in the option area is refused.
  await assert.rejects(runner.run({ argv: ["-Cache", "status"], cwd: f.wt.workTree, env: {}, context: "pty" }), denied);
  await assert.rejects(runner.run({ argv: ["-c", "a.b=c", "-C", f.wt.workTree, "status"], cwd: f.wt.workTree, env: {}, context: "pty" }), denied);
});

test("the option area is a closed set: an unknown global option (--shallow-file <file>, or a typo) cannot hide -C, --git-dir, --work-tree or --exec-path", { skip: !posix }, async () => {
  const f = fixture();
  const other = fixture();
  planted(f.wt.workTree, "git-axisx");
  const runner = createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true });
  const wt = f.wt.workTree;
  const bypass: string[][] = [
    ["--shallow-file", "x", `--exec-path=${wt}`, "axisx"],
    ["--shallow-file", "x", "--exec-path", wt, "axisx"],
    ["--shallow-file", "x", "-C", other.wt.workTree, "rev-parse", "--show-toplevel"],
    ["--shallow-file", "x", "--git-dir", `${other.wt.gitDir}`, "--work-tree", other.wt.workTree, "rev-parse", "--show-toplevel"],
    ["--shallow-file=x", "status"],
    ["--shallow-file", "status"],
    ["--exec-path=x", "status"],
    ["--bogus", "x", "status"],
    ["--", "status"],
    ["-p", "status"],
    ["-c"],
  ];
  for (const argv of bypass) await assert.rejects(runner.run({ argv, cwd: wt, env: {}, context: "pty" }), denied, JSON.stringify(argv));
  assert.equal(existsSync(join(wt, "planted-ran-git-axisx")), false);
});

test("-c alias.* and --config-env are refused, so no alias can run a planted helper or shell command", { skip: !posix }, async () => {
  const f = fixture();
  planted(f.wt.workTree, "git-axisx");
  const runner = createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true });
  const marker = join(f.root, "alias-ran");
  const cases: Array<{ argv: string[]; env?: Record<string, string> }> = [
    { argv: ["-c", `alias.zz=!${join(f.wt.workTree, "git-axisx")}`, "zz"] },
    { argv: ["-c", `alias.zz=!touch ${marker}`, "zz"] },
    { argv: ["-c", `ALIAS.zz=!touch ${marker}`, "zz"] },
    { argv: ["--config-env=alias.zz=V", "zz"], env: { V: `!touch ${marker}` } },
    { argv: ["--config-env", "alias.zz=V", "zz"], env: { V: `!touch ${marker}` } },
  ];
  for (const c of cases) await assert.rejects(runner.run({ argv: c.argv, cwd: f.wt.workTree, env: c.env ?? {}, context: "pty" }), denied, JSON.stringify(c.argv));
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(f.wt.workTree, "planted-ran-git-axisx")), false);
});

test("the redirect variables the package's own lists name are refused in the request environment", { skip: !posix }, async () => {
  const f = fixture();
  const runner = createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true });
  for (const name of ["GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_SHALLOW_FILE", "GIT_TEMPLATE_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) {
    await assert.rejects(runner.run({ argv: ["--version"], cwd: f.wt.workTree, env: { [name]: "/x" }, context: "pty" }), denied, name);
  }
  // GIT_INDEX_FILE is set by the bound commit itself, and a shell profile's identity variables are checked elsewhere.
  const r = await runner.run({ argv: ["--version"], cwd: f.wt.workTree, env: { GIT_INDEX_FILE: join(f.root, "idx"), GIT_AUTHOR_NAME: "x" }, context: "pty" });
  assert.equal(r.code, 0);
});

test("run() reads argv and env once: a getter or Proxy request cannot show the checks one value and the spawn another", { skip: !posix }, async () => {
  const f = fixture();
  planted(f.wt.workTree, "git-axisx");
  const marker = join(f.wt.workTree, "planted-ran-git-axisx");
  const runner = createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true });
  const evil = [`--exec-path=${f.wt.workTree}`, "axisx"];
  let reads = 0;
  const viaGetter = { cwd: f.wt.workTree, env: {}, context: "pty" as const, get argv(): string[] { return reads++ === 0 ? ["--version"] : evil; } };
  const first = await runner.run(viaGetter);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(reads, 1, "argv was read more than once");
  assert.equal(existsSync(marker), false);

  let envReads = 0;
  const envProxy = new Proxy({}, {
    ownKeys: () => (envReads++ === 0 ? [] : ["GIT_EXEC_PATH"]),
    getOwnPropertyDescriptor: (_t, k) => (k === "GIT_EXEC_PATH" ? { value: f.wt.workTree, enumerable: true, configurable: true, writable: true } : undefined),
    get: (_t, k) => (k === "GIT_EXEC_PATH" ? f.wt.workTree : undefined),
  }) as Record<string, string>;
  const second = await runner.run({ argv: ["--version"], cwd: f.wt.workTree, env: envProxy, context: "pty" });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(envReads, 1, "env was read more than once");
  assert.equal(existsSync(marker), false);
  await assert.rejects(runner.run({ argv: [1 as unknown as string], cwd: f.wt.workTree, env: {}, context: "pty" }), denied);
});
