// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// CLI-1/CFG-1: a `git` planted in a worktree must not run, whatever PATH looks like; git is spawned by absolute path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    const r = await withPath(path, () => createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true }).run({ ...version, cwd: f.wt.workTree, env: { PATH: path } }));
    assert.match(r.stdout, /^git version /);
    assert.equal(existsSync(marker), false, `entry "${bad}"`);
  }
});

test("an absolute PATH entry that IS the worktree is ignored too, for the daemon's lookup and for git's own children", { skip: !posix }, async () => {
  const f = fixture();
  const marker = planted(f.wt.workTree);
  const probe = planted(f.wt.workTree, "git-axisprobe");
  const path = `${f.wt.workTree}${delimiter}${REAL_PATH}`;
  const r = await withPath(path, () => createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true }).run({ ...version, cwd: f.wt.workTree, env: { PATH: path } }));
  assert.match(r.stdout, /^git version /);
  const p = await withPath(path, () => createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true }).run({ argv: ["axisprobe"], cwd: f.wt.workTree, env: { PATH: path, HOME: f.home }, context: "pty" }));
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
  // The worktree reached only through --work-tree or --git-dir, with an unrelated cwd that does not contain the fixture.
  const elsewhere = tmp("axis-elsewhere-");
  const gitDir = tmp("axis-gitdir-");
  const outside = join(gitDir, "git");
  writeFileSync(outside, "#!/bin/sh\nexit 0\n");
  chmodSync(outside, 0o755);
  const wtGit = join(f.wt.workTree, "..bin", "git");
  await assert.rejects(run(wtGit, { argv: [`--work-tree=${f.wt.workTree}`, "--version"], cwd: elsewhere }), denied);
  await assert.rejects(run(wtGit, { argv: [`--git-dir=${f.wt.workTree}`, "--version"], cwd: elsewhere }), denied);
  // Control: the same unrelated cwd with a git outside everything is allowed.
  assert.equal((await run(outside, { cwd: elsewhere })).code, 0);
  // A relative --git-dir/--work-tree would be read against cwd by git, so it is refused rather than compared as spelled.
  await assert.rejects(run(realGit(), { argv: ["--git-dir=.git", "--version"], cwd: elsewhere }), denied);
  await assert.rejects(run(realGit(), { argv: ["--work-tree=.", "--version"], cwd: elsewhere }), denied);
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
  const runner = createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true, env: { PATH: join(root, "bin") } });
  const ask = () => runner.run({ ...version, cwd: f.wt.workTree });
  assert.match((await ask()).stdout, /fake-v1/);
  rmSync(join(root, "bin", "git"));
  symlinkSync(join(root, "v2", "git"), join(root, "bin", "git"));
  rmSync(join(root, "v1"), { recursive: true });
  assert.match((await ask()).stdout, /fake-v2/, "the stable path was cached, not its old target");
  // An injected path that vanished and no exclusion list from the host: refused, nothing is looked up or spawned.
  mkdirSync(join(root, "v3"));
  writeFileSync(join(root, "v3", "git"), script("v3"));
  chmodSync(join(root, "v3", "git"), 0o755);
  rmSync(join(root, "bin", "git"));
  symlinkSync(join(root, "v3", "git"), join(root, "bin", "git"));
  const bare = createNodeRunner({ allowPtyContext: true, gitPath: join(root, "v1", "git"), env: { PATH: join(root, "bin") } });
  await assert.rejects(bare.run({ ...version, cwd: f.wt.workTree }), (e: unknown) => e instanceof GitOpsError && e.code === "E_UNAVAILABLE");
  // With the host's exclusion list it is found again, in the same call, from the environment snapshot.
  const listed = createNodeRunner({ allowPtyContext: true, gitPath: join(root, "v1", "git"), env: { PATH: join(root, "bin") }, excludeDirs: () => [] });
  assert.match((await listed.run({ ...version, cwd: f.wt.workTree })).stdout, /fake-v3/, "v1 is gone; the replacement was found through the resolver");
  // With nothing to find, nothing is spawned.
  rmSync(join(root, "v3"), { recursive: true });
  const none = createNodeRunner({ allowPtyContext: true, gitPath: join(root, "v1", "git"), env: { PATH: join(root, "bin") }, excludeDirs: () => [] });
  await assert.rejects(none.run({ ...version, cwd: f.wt.workTree }), (e: unknown) => e instanceof GitOpsError && e.code === "E_UNAVAILABLE");
});

test("a vanished injected gitPath never lets a git planted in a SIBLING worktree on PATH run, with or without the host's list", { skip: !posix }, async () => {
  const a = fixture();
  const b = fixture();
  const marker = planted(b.wt.workTree);
  const inst = tmp("axis-inst-");
  mkdirSync(join(inst, "bin"));
  symlinkSync(realGit(), join(inst, "bin", "git"));
  const env = { PATH: `${join(inst, "bin")}${delimiter}${b.wt.workTree}${delimiter}${REAL_PATH}` };
  const gitPath = resolveGit(env, process.platform, [a.wt.workTree, b.wt.workTree]) as string;
  assert.equal(gitPath, join(inst, "bin", "git"));
  const mk = (extra: object) => createNodeRunner({ allowPtyContext: true, gitPath, env, ...extra });
  const hostList = mk({ excludeDirs: () => [a.wt.workTree, b.wt.workTree] });
  const noList = mk({});
  assert.match((await hostList.run({ ...version, cwd: a.wt.workTree })).stdout, /^git version /);
  assert.match((await noList.run({ ...version, cwd: a.wt.workTree })).stdout, /^git version /);
  rmSync(join(inst, "bin", "git")); // mid-upgrade: the package manager unlinks it
  const rejects = (e: unknown): boolean => e instanceof GitOpsError && e.code === "E_UNAVAILABLE";
  await assert.rejects(noList.run({ ...version, cwd: a.wt.workTree }), rejects, "no list from the host: refuse, let the host resolve again");
  const again = await hostList.run({ ...version, cwd: a.wt.workTree });
  assert.match(again.stdout, /^git version /, "re-resolved with the host's list: the sibling is skipped and the real git is found");
  assert.equal(existsSync(marker), false, "the planted git never ran");
  // Control: with only this request's worktree excluded (the old behaviour) the sibling's git would have been chosen.
  assert.equal(resolveGit(env, process.platform, [a.wt.workTree]), join(b.wt.workTree, "git"));
});

test("the real path is what is spawned: a symlink gitPath to a recording wrapper reports the target", { skip: !posix }, async () => {
  const f = fixture();
  const dir = tmp("axis-real-");
  const rec = join(dir, "recorded");
  writeFileSync(join(dir, "target"), `#!/bin/sh
printf '%s' "$0" > "${rec}"
exec "${realGit()}" "$@"
`);
  chmodSync(join(dir, "target"), 0o755);
  symlinkSync(join(dir, "target"), join(dir, "git"));
  const r = await createNodeRunner({ allowPtyContext: true, gitPath: join(dir, "git") }).run({ ...version, cwd: f.wt.workTree });
  assert.match(r.stdout, /^git version /);
  assert.equal(readFileSync(rec, "utf8"), join(dir, "target"), "the target was started, not the symlink");
});

test("git's own children never see a PATH entry that leads into the worktree, by spelling or through a symlink", { skip: !posix }, async () => {
  const f = fixture();
  const probe = planted(f.wt.workTree, "git-axisprobe");
  const link = join(f.root, "wt-link");
  symlinkSync(f.wt.workTree, link);
  const path = `${link}${delimiter}${REAL_PATH}`;
  const p = await createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true }).run({ argv: ["axisprobe"], cwd: f.wt.workTree, env: { PATH: path, HOME: f.home }, context: "pty" });
  assert.notEqual(p.code, 0);
  assert.equal(existsSync(probe), false);
});

test("with no git in a trusted PATH entry the runner reports E_UNAVAILABLE and spawns nothing", { skip: !posix }, async () => {
  const f = fixture();
  const marker = planted(f.wt.workTree);
  await withPath(delimiter, async () => {
    await assert.rejects(createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true }).run({ ...version, cwd: f.wt.workTree, env: { PATH: delimiter } }), (e: unknown) => e instanceof GitOpsError && e.code === "E_UNAVAILABLE");
  });
  assert.equal(existsSync(marker), false);
});

// ---- the host's excludeDirs result is validated; nothing the host returned or threw is echoed ----

function vanishedSetup(): { gitPath: string; env: { PATH: string }; cwd: string; marker: string } {
  const a = fixture();
  const b = fixture();
  const marker = planted(b.wt.workTree);
  const inst = tmp("axis-vanish-");
  mkdirSync(join(inst, "bin"));
  symlinkSync(realGit(), join(inst, "bin", "git"));
  const gitPath = join(inst, "bin", "git");
  return { gitPath, env: { PATH: `${join(inst, "bin")}${delimiter}${b.wt.workTree}${delimiter}${REAL_PATH}` }, cwd: a.wt.workTree, marker };
}

test("a bad excludeDirs result (undefined, relative or empty entry, throw, Promise, string, number) refuses with a closed E_UNAVAILABLE and the planted git never runs", { skip: !posix }, async () => {
  const bad: Array<[string, () => unknown]> = [
    ["undefined", () => undefined],
    ["relative entry", () => ["rel/b"]],
    ["empty entry", () => [""]],
    ["unnormalised entry", () => ["/tmp/x/../y"]],
    ["number entry", () => [42]],
    ["throws", () => { throw new Error("SECRET-host-message /home/secret"); }],
    ["Promise", () => Promise.resolve([])],
    ["string", () => "/"],
    ["number", () => 7],
    ["null", () => null],
  ];
  for (const [name, fn] of bad) {
    const s = vanishedSetup();
    const runner = createNodeRunner({ allowPtyContext: true, gitPath: join(tmp("axis-gone-"), "git"), env: s.env, excludeDirs: fn as () => readonly string[] });
    await assert.rejects(runner.run({ ...version, cwd: s.cwd }), (e: unknown) => {
      assert.ok(e instanceof GitOpsError, `${name}: a raw error leaked`);
      assert.equal(e.code, "E_UNAVAILABLE", name);
      assert.doesNotMatch(e.message, /SECRET|secret|rel\/b|\/tmp\/x/, `${name}: the host's value or message was echoed`);
      return true;
    });
    assert.equal(existsSync(s.marker), false, `${name}: the planted git ran`);
  }
});

test("a good excludeDirs result is copied: emptying the host's array right after the first lookup changes nothing", { skip: !posix }, async () => {
  const f = fixture();
  const b = fixture();
  const marker = planted(b.wt.workTree);
  const list = [b.wt.workTree];
  const runner = createNodeRunner({ allowPtyContext: true, gitPath: join(tmp("axis-gone-"), "git"), env: { PATH: `${b.wt.workTree}${delimiter}${REAL_PATH}` }, excludeDirs: () => { listRead = true; return list; } });
  // The runner reads req.argv after it read the host's list; that read empties the host's array, as a registry reload would.
  let listRead = false;
  let argvReads = 0;
  const req = { cwd: f.wt.workTree, env: {}, context: "pty" as const, get argv(): readonly string[] { if (listRead) { argvReads++; list.length = 0; } return ["--version"]; } };
  const r = await runner.run(req);
  assert.match(r.stdout, /^git version /);
  assert.ok(argvReads > 0 && list.length === 0, "the host's array was emptied after the lookup began");
  assert.equal(existsSync(marker), false, "the copy still excluded the sibling's worktree");
});

test("with neither gitPath nor excludeDirs the runner refuses; allowUnpinnedGit opts into the weaker lookup", { skip: !posix }, async () => {
  const f = fixture();
  const refuse = (e: unknown): boolean => e instanceof GitOpsError && e.code === "E_UNAVAILABLE" && /gitPath or excludeDirs/.test(e.message);
  await assert.rejects(createNodeRunner({ allowPtyContext: true }).run({ ...version, cwd: f.wt.workTree }), refuse);
  assert.match((await createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true }).run({ ...version, cwd: f.wt.workTree })).stdout, /^git version /);
  // A list that covers none of the request's directories re-opens the sibling-git hole: refused, nothing is spawned.
  const sibling = fixture();
  const marker = planted(sibling.wt.workTree);
  const env = { PATH: `${sibling.wt.workTree}${delimiter}${REAL_PATH}` };
  const uncovered = (e: unknown): boolean => e instanceof GitOpsError && e.code === "E_UNAVAILABLE" && /does not cover/.test(e.message);
  await assert.rejects(createNodeRunner({ allowPtyContext: true, env, excludeDirs: () => [] }).run({ ...version, cwd: f.wt.workTree }), uncovered);
  await assert.rejects(createNodeRunner({ allowPtyContext: true, env, excludeDirs: () => [sibling.wt.workTree] }).run({ ...version, cwd: f.wt.workTree }), uncovered);
  assert.equal(existsSync(marker), false);
  // A list that covers the request is accepted, and the planted sibling listed in it is skipped.
  assert.match((await createNodeRunner({ allowPtyContext: true, env, excludeDirs: () => [f.wt.workTree, sibling.wt.workTree] }).run({ ...version, cwd: f.wt.workTree })).stdout, /^git version /);
  assert.equal(existsSync(marker), false);
  assert.match((await createNodeRunner({ allowPtyContext: true, gitPath: realGit() }).run({ ...version, cwd: f.wt.workTree })).stdout, /^git version /);
});

test("an empty cwd, an empty --work-tree= and the -C and split --git-dir/--work-tree forms are refused before git runs", async () => {
  const f = fixture();
  const runner = createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true });
  const denied = (e: unknown): boolean => e instanceof GitOpsError && e.code === "E_POLICY_DENIED";
  const base = f.wt.workTree;
  for (const [cwd, argv] of [
    ["", ["--version"]],
    [base, ["--work-tree=", "--version"]],
    [base, ["--git-dir=", "--version"]],
    [base, ["-C", base, "--version"]],
    [base, ["-C" + base, "--version"]],
    [base, ["--git-dir", base, "--version"]],
    [base, ["--work-tree", base, "--version"]],
  ] as Array<[string, string[]]>) {
    await assert.rejects(runner.run({ argv, cwd, env: {}, context: "pty" }), denied, JSON.stringify([cwd, argv]));
  }
  assert.match((await runner.run({ ...version, cwd: base })).stdout, /^git version /, "control");
});
