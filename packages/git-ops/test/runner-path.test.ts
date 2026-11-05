// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// CLI-1/CFG-1: a `git` planted in a worktree must not run, whatever PATH looks like; git is spawned by absolute path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { GitOpsError, createNodeRunner, resolveGit } from "../src/index.js";
import { fixture, tmp } from "./realFixture.js";

const posix = process.platform !== "win32";
const REAL_PATH = process.env["PATH"] ?? "";
const realGit = (): string => resolveGit({ PATH: REAL_PATH }, process.platform) as string;

function planted(dir: string, name = "git"): string {
  const marker = join(dir, `planted-ran-${name}`);
  writeFileSync(join(dir, name), `#!/bin/sh\necho ran > "${marker}"\nexit 0\n`);
  chmodSync(join(dir, name), 0o755);
  return marker;
}

async function withPath<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env["PATH"];
  process.env["PATH"] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env["PATH"];
    else process.env["PATH"] = saved;
  }
}

const version = { argv: ["--version"], env: {}, context: "pty" } as const;

test("an empty or relative PATH entry does not run a git planted in the worktree: the real git is used", { skip: !posix }, async () => {
  for (const bad of ["", "."]) {
    const f = fixture();
    const marker = planted(f.wt.workTree);
    const path = `${bad}${delimiter}${REAL_PATH}`;
    const r = await withPath(path, () => createNodeRunner({ allowPtyContext: true }).run({ ...version, cwd: f.wt.workTree, env: { PATH: path } }));
    assert.match(r.stdout, /^git version /);
    assert.equal(existsSync(marker), false, `entry "${bad}"`);
  }
});

test("an absolute PATH entry that IS the worktree is ignored too, for the daemon's lookup and for git's own children", { skip: !posix }, async () => {
  const f = fixture();
  const marker = planted(f.wt.workTree);
  const probe = planted(f.wt.workTree, "git-axisprobe");
  const path = `${f.wt.workTree}${delimiter}${REAL_PATH}`;
  const r = await withPath(path, () => createNodeRunner({ allowPtyContext: true }).run({ ...version, cwd: f.wt.workTree, env: { PATH: path } }));
  assert.match(r.stdout, /^git version /);
  const p = await withPath(path, () => createNodeRunner({ allowPtyContext: true }).run({ argv: ["axisprobe"], cwd: f.wt.workTree, env: { PATH: path, HOME: f.home }, context: "pty" }));
  assert.notEqual(p.code, 0, "git does not know the command");
  assert.equal(existsSync(marker) || existsSync(probe), false);
});

test("git is spawned by the ABSOLUTE path the host gave: a wrapper there records the path it was started as", { skip: !posix }, async () => {
  const f = fixture();
  const dir = tmp("axis-wrap-");
  const rec = join(dir, "recorded");
  writeFileSync(join(dir, "git"), `#!/bin/sh\nprintf '%s' "$0" > "${rec}"\nexec "${realGit()}" "$@"\n`);
  chmodSync(join(dir, "git"), 0o755);
  const r = await createNodeRunner({ allowPtyContext: true, gitPath: join(dir, "git") }).run({ ...version, cwd: f.wt.workTree });
  assert.match(r.stdout, /^git version /);
  assert.equal(readFileSync(rec, "utf8"), join(dir, "git"), "the wrapper, not a PATH lookup, was started");
});

test("a git inside the worktree is refused by spelling, by a `..`-prefixed name, and through a symlink; nothing runs", { skip: !posix }, async () => {
  const f = fixture();
  const marker = planted(f.wt.workTree);
  mkdirSync(join(f.wt.workTree, "..bin"));
  const dotted = planted(join(f.wt.workTree, "..bin"));
  const link = join(f.root, "link");
  symlinkSync(f.wt.workTree, link);
  const run = (gitPath: string, over: object = {}) => createNodeRunner({ allowPtyContext: true, gitPath }).run({ ...version, cwd: f.wt.workTree, ...over });
  const denied = (e: unknown): boolean => e instanceof GitOpsError && e.code === "E_POLICY_DENIED";
  await assert.rejects(run(join(f.wt.workTree, "git")), denied);
  await assert.rejects(run(join(f.wt.workTree, "..bin", "git")), denied, "a name that merely starts with .. is inside");
  await assert.rejects(run(join(link, "git")), denied, "a symlink to the worktree is the worktree");
  await assert.rejects(run(join(link, "..bin", "git")), denied);
  // The worktree reached only through --work-tree, with an unrelated cwd.
  await assert.rejects(run(join(f.wt.workTree, "git"), { argv: [`--work-tree=${f.wt.workTree}`, "--version"], cwd: tmpdir() }), denied);
  assert.equal(existsSync(marker) || existsSync(dotted), false);
});

test("a relative gitPath is refused, and an injected absolute one outside the worktree is used", { skip: !posix }, async () => {
  const f = fixture();
  await assert.rejects(createNodeRunner({ allowPtyContext: true, gitPath: "git" }).run({ ...version, cwd: f.wt.workTree }), (e: unknown) => e instanceof GitOpsError && e.code === "E_POLICY_DENIED");
  const r = await createNodeRunner({ allowPtyContext: true, gitPath: realGit() }).run({ ...version, cwd: f.wt.workTree });
  assert.match(r.stdout, /^git version /);
});

test("the host resolves git once with EVERY registered worktree excluded: a git planted in a sibling worktree on PATH is never chosen", { skip: !posix }, () => {
  const a = fixture();
  const b = fixture();
  planted(b.wt.workTree);
  const env = { PATH: `${b.wt.workTree}${delimiter}${REAL_PATH}` };
  assert.equal(resolveGit(env, process.platform, [a.wt.workTree, b.wt.workTree]), realGit());
  // Control: with only this request's worktree excluded the sibling's git wins, which is why the host must list them all.
  assert.equal(resolveGit(env, process.platform, [a.wt.workTree]), join(b.wt.workTree, "git"));
  // A sibling reached through a symlinked PATH entry is excluded by real path.
  const link = join(a.root, "sibling-link");
  symlinkSync(b.wt.workTree, link);
  assert.equal(resolveGit({ PATH: `${link}${delimiter}${REAL_PATH}` }, process.platform, [b.wt.workTree]), realGit());
});

test("an upgrade that replaces the git behind a stable path is followed; a vanished injected path is looked up again through the trusted resolver only", { skip: !posix }, async () => {
  const f = fixture();
  const root = tmp("axis-upgrade-");
  const script = (v: string): string => `#!/bin/sh\necho "git version fake-${v}"\n`;
  for (const v of ["v1", "v2"]) {
    mkdirSync(join(root, v));
    writeFileSync(join(root, v, "git"), script(v));
    chmodSync(join(root, v, "git"), 0o755);
  }
  mkdirSync(join(root, "bin"));
  symlinkSync(join(root, "v1", "git"), join(root, "bin", "git"));
  const runner = createNodeRunner({ allowPtyContext: true });
  const ask = () => withPath(join(root, "bin"), () => runner.run({ ...version, cwd: f.wt.workTree }));
  assert.match((await ask()).stdout, /fake-v1/);
  rmSync(join(root, "bin", "git"));
  symlinkSync(join(root, "v2", "git"), join(root, "bin", "git"));
  rmSync(join(root, "v1"), { recursive: true });
  assert.match((await ask()).stdout, /fake-v2/, "the stable path was cached, not its old target");
  // An injected path that vanished: found again, in the same call, from the trusted PATH only.
  mkdirSync(join(root, "v3"));
  writeFileSync(join(root, "v3", "git"), script("v3"));
  chmodSync(join(root, "v3", "git"), 0o755);
  rmSync(join(root, "bin", "git"));
  symlinkSync(join(root, "v3", "git"), join(root, "bin", "git"));
  const injected = createNodeRunner({ allowPtyContext: true, gitPath: join(root, "v1", "git") });
  const again = await withPath(join(root, "bin"), () => injected.run({ ...version, cwd: f.wt.workTree }));
  assert.match(again.stdout, /fake-v3/, "v1 is gone; the lookup through the trusted PATH found the replacement");
  // With nothing to find, nothing is spawned.
  rmSync(join(root, "v3"), { recursive: true });
  const none = createNodeRunner({ allowPtyContext: true, gitPath: join(root, "v1", "git") });
  await assert.rejects(withPath(join(root, "bin"), () => none.run({ ...version, cwd: f.wt.workTree })), (e: unknown) => e instanceof GitOpsError && e.code === "E_UNAVAILABLE");
});

test("with no git in a trusted PATH entry the runner reports E_UNAVAILABLE and spawns nothing", { skip: !posix }, async () => {
  const f = fixture();
  const marker = planted(f.wt.workTree);
  await withPath(delimiter, async () => {
    await assert.rejects(createNodeRunner({ allowPtyContext: true }).run({ ...version, cwd: f.wt.workTree, env: { PATH: delimiter } }), (e: unknown) => e instanceof GitOpsError && e.code === "E_UNAVAILABLE");
  });
  assert.equal(existsSync(marker), false);
});
