// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// CLI-1/CFG-1: a `git` planted in the worktree must not run, whatever PATH looks like.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { GitOpsError, createNodeRunner } from "../src/index.js";
import { resolveGit, trustedPath } from "../src/gitPath.js";
import { fixture } from "./realFixture.js";

const posix = process.platform !== "win32";
const REAL_PATH = process.env["PATH"] ?? "";

function planted(dir: string): string {
  const marker = join(dir, "planted-ran");
  writeFileSync(join(dir, "git"), `#!/bin/sh\necho ran > "${marker}"\nexit 0\n`);
  chmodSync(join(dir, "git"), 0o755);
  return marker;
}

test("an empty PATH entry does not run a git planted in the worktree: the real git is used", { skip: !posix }, async () => {
  const f = fixture();
  const marker = planted(f.wt.workTree);
  const saved = process.env["PATH"];
  process.env["PATH"] = `${delimiter}${REAL_PATH}`;
  try {
    const r = await createNodeRunner({ allowPtyContext: true }).run({ argv: ["--version"], cwd: f.wt.workTree, env: { PATH: `${delimiter}${REAL_PATH}` }, context: "pty" });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^git version /);
  } finally {
    process.env["PATH"] = saved;
  }
  assert.equal(existsSync(marker), false, "the planted git did not run");
});

test("a relative PATH entry (\".\") is ignored too, for the daemon and for git's own children", { skip: !posix }, async () => {
  const f = fixture();
  const marker = planted(f.wt.workTree);
  const saved = process.env["PATH"];
  process.env["PATH"] = `.${delimiter}${REAL_PATH}`;
  try {
    const r = await createNodeRunner({ allowPtyContext: true }).run({ argv: ["--version"], cwd: f.wt.workTree, env: { PATH: `.${delimiter}${REAL_PATH}` }, context: "pty" });
    assert.match(r.stdout, /^git version /);
  } finally {
    process.env["PATH"] = saved;
  }
  assert.equal(existsSync(marker), false);
});

test("the children of git do not see an empty PATH entry (a planted git-foo or hook helper cannot be found through it)", { skip: !posix }, async () => {
  const f = fixture();
  writeFileSync(join(f.wt.workTree, "git-axisprobe"), `#!/bin/sh\necho planted > "${join(f.wt.workTree, "probe-ran")}"\n`);
  chmodSync(join(f.wt.workTree, "git-axisprobe"), 0o755);
  const r = await createNodeRunner({ allowPtyContext: true }).run({ argv: ["axisprobe"], cwd: f.wt.workTree, env: { PATH: `${delimiter}${REAL_PATH}`, HOME: f.home }, context: "pty" });
  assert.notEqual(r.code, 0, "git does not know the command");
  assert.equal(existsSync(join(f.wt.workTree, "probe-ran")), false);
});

test("a git executable inside the worktree is refused, even when the host passed it as gitPath", { skip: !posix }, async () => {
  const f = fixture();
  const marker = planted(f.wt.workTree);
  const runner = createNodeRunner({ allowPtyContext: true, gitPath: join(f.wt.workTree, "git") });
  await assert.rejects(runner.run({ argv: ["--version"], cwd: f.wt.workTree, env: { PATH: REAL_PATH }, context: "pty" }), (e: unknown) => e instanceof GitOpsError && e.code === "E_POLICY_DENIED");
  // Nor through a request whose cwd is elsewhere but whose work tree holds it.
  await assert.rejects(runner.run({ argv: [`--work-tree=${f.wt.workTree}`, "--version"], cwd: tmpdir(), env: { PATH: REAL_PATH }, context: "pty" }), GitOpsError);
  assert.equal(existsSync(marker), false);
});

test("a relative gitPath is refused, and an injected absolute one outside the worktree is used", { skip: !posix }, async () => {
  const f = fixture();
  await assert.rejects(createNodeRunner({ allowPtyContext: true, gitPath: "git" }).run({ argv: ["--version"], cwd: f.wt.workTree, env: {}, context: "pty" }), GitOpsError);
  const real = resolveGit(REAL_PATH) as string;
  const r = await createNodeRunner({ allowPtyContext: true, gitPath: real }).run({ argv: ["--version"], cwd: f.wt.workTree, env: {}, context: "pty" });
  assert.match(r.stdout, /^git version /);
});

test("resolveGit and trustedPath skip empty and relative entries and return a real absolute path", { skip: !posix }, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "axis-path-")));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "git"), "#!/bin/sh\n");
  chmodSync(join(dir, "bin", "git"), 0o755);
  assert.equal(trustedPath(`${delimiter}rel${delimiter}${join(dir, "bin")}${delimiter}.`), join(dir, "bin"));
  assert.equal(resolveGit(`${delimiter}${join(dir, "bin")}`), join(dir, "bin", "git"));
  assert.equal(resolveGit(`${delimiter}rel`), undefined);
  assert.equal(resolveGit(undefined), undefined);
});

test("with no git in a trusted PATH entry the runner reports E_UNAVAILABLE and spawns nothing", { skip: !posix }, async () => {
  const f = fixture();
  const marker = planted(f.wt.workTree);
  const saved = process.env["PATH"];
  process.env["PATH"] = delimiter;
  try {
    await assert.rejects(createNodeRunner({ allowPtyContext: true }).run({ argv: ["--version"], cwd: f.wt.workTree, env: { PATH: delimiter }, context: "pty" }), (e: unknown) => e instanceof GitOpsError && e.code === "E_UNAVAILABLE");
  } finally {
    process.env["PATH"] = saved;
  }
  assert.equal(existsSync(marker), false);
});
