// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A partial clone whose OWN config chooses what a lazy fetch runs: no daemon-side git call may start it (security ticket
// "lazy fetch from daemon-side git"; docs/design/daemon-host-hooks-s1.md item 8 is the pty side of the same class).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createNodeRunner, daemonGitEnv, daemonGitFor, type GitOpsDeps, type GitRunRequest, type WorktreeRef } from "../src/index.js";
import { PATHS, tmp } from "./realFixture.js";

const GIT = ((): string | undefined => {
  const r = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
})();
const version = ((): number[] => {
  const m = GIT === undefined ? null : /git version (\d+)\.(\d+)\.(\d+)/.exec(execFileSync(GIT, ["--version"], { encoding: "utf8" }));
  return m === null ? [0, 0, 0] : [Number(m[1]), Number(m[2]), Number(m[3])];
})();
const atLeast = (v: number[]): boolean => {
  for (let i = 0; i < 3; i++) if ((version[i] ?? 0) !== (v[i] ?? 0)) return (version[i] ?? 0) > (v[i] ?? 0);
  return true;
};
const SKIP = process.platform === "win32" ? "POSIX shell fixture" : GIT === undefined ? "no git" : !atLeast([2, 27, 0]) ? "partial clone over file:// needs git 2.27" : false;

/** Each vector is a repository's own config that makes a lazy fetch run `evil` (writes MARKER). */
export const VECTORS: Readonly<Record<string, (evil: string) => ReadonlyArray<readonly [string, string]>>> = {
  uploadpack: (e) => [["protocol.file.allow", "always"], ["remote.origin.uploadpack", e]],
  vcsAlias: (e) => [["protocol.evil.allow", "always"], ["remote.origin.vcs", "evil"], ["alias.remote-evil", `!${e}`]],
  helperUrl: (e) => [["protocol.evil.allow", "always"], ["remote.origin.url", "evil::x"], ["alias.remote-evil", `!${e}`]],
  sshCommand: (e) => [["protocol.ssh.allow", "always"], ["remote.origin.url", "ssh://h.invalid/x"], ["core.sshCommand", e]],
  ext: (e) => [["protocol.ext.allow", "always"], ["remote.origin.url", `ext::${e} %S x`]],
  slashAutocorrect: (e) => [["protocol./.allow", "always"], ["remote.origin.vcs", "/"], ["help.autocorrect", "1"], ["alias.remote-a", `!${e}`]],
  emptyVcs: (e) => [["protocol.allow", "always"], ["remote.origin.vcs", ""], ["alias.remote-", `!${e}`]],
};

interface Hostile {
  readonly wt: WorktreeRef;
  readonly marker: string;
  readonly env: Record<string, string>;
  readonly missingBlob: string;
  fired(): boolean;
}

/**
 * A `--filter=blob:none` clone of a local bare repository: the index entry of `a.txt` (the work tree differs) and both sides
 * of a staged rename `old.txt` -> `new.txt` are missing blobs, so status (rename detection), diff, log --stat, show and
 * cat-file each need one. The repository config then gets the vector.
 */
function hostile(vector: string): Hostile {
  const g = GIT as string;
  const root = tmp("axis-lazy-");
  const home = join(root, "home");
  mkdirSync(home);
  const env = { PATH: PATHS, HOME: home, GIT_CONFIG_NOSYSTEM: "1", LANG: "C" };
  const run = (cwd: string, ...args: string[]): string => execFileSync(g, args, { cwd, env: { ...env, GIT_NO_LAZY_FETCH: "1" }, encoding: "utf8" });
  run(root, "init", "-q", "--bare", "up.git");
  const src = join(root, "src");
  run(root, "init", "-q", src);
  for (const [k, v] of [["user.email", "a@b"], ["user.name", "a"], ["commit.gpgsign", "false"]] as const) run(src, "config", k, v);
  writeFileSync(join(src, "a.txt"), "one\ntwo\n");
  writeFileSync(join(src, "old.txt"), "old\n");
  run(src, "add", ".");
  run(src, "commit", "-qm", "c1");
  writeFileSync(join(src, "a.txt"), "one\nTWO\n");
  run(src, "commit", "-qam", "c2");
  run(src, "push", "-q", join(root, "up.git"), "HEAD:refs/heads/main");
  run(join(root, "up.git"), "symbolic-ref", "HEAD", "refs/heads/main");
  run(join(root, "up.git"), "config", "uploadpack.allowFilter", "true");
  run(join(root, "up.git"), "config", "uploadpack.allowAnySHA1InWant", "true");
  const repo = join(root, "repo");
  execFileSync(g, ["-c", "protocol.file.allow=always", "clone", "-q", "--filter=blob:none", "--no-checkout", `file://${join(root, "up.git")}`, repo], { cwd: root, env, stdio: "ignore" });
  run(repo, "read-tree", "HEAD");
  writeFileSync(join(repo, "a.txt"), "local edit\n");
  const missingBlob = run(repo, "rev-parse", "HEAD~1:a.txt").trim();
  run(repo, "update-index", "--force-remove", "old.txt");
  run(repo, "update-index", "--add", "--cacheinfo", `100644,${missingBlob},new.txt`);
  const marker = join(root, "MARKER");
  const evil = join(root, "evil.sh");
  writeFileSync(evil, `#!/bin/sh\necho "$0 $*" >> '${marker}'\nexit 1\n`);
  chmodSync(evil, 0o755);
  for (const [k, v] of (VECTORS[vector] as (e: string) => ReadonlyArray<readonly [string, string]>)(evil)) run(repo, "config", k, v);
  assert.notEqual(spawnSync(g, ["cat-file", "-e", missingBlob], { cwd: repo, env: { ...env, GIT_NO_LAZY_FETCH: "1" } }).status, 0, "the blob is really missing");
  return { wt: { workTree: repo, gitDir: join(repo, ".git") }, marker, env, missingBlob, fired: () => existsSync(marker) };
}

/** The real git with one variable of the environment removed before it starts. */
function without(name: string): string {
  const p = join(tmp("axis-gitwrap-"), "git");
  writeFileSync(p, `#!/bin/sh\nunset ${name}\nexec '${GIT as string}' "$@"\n`);
  chmodSync(p, 0o755);
  return p;
}

const deps = (gitPath: string, env: Record<string, string>): GitOpsDeps => ({
  runner: createNodeRunner({ gitPath, env }),
  env: { daemon: env, pty: {} },
  runHooks: false,
  isCliRunActive: () => false,
  assertNoDrift: async () => undefined,
  platform: "linux",
});

/** The daemon-side read shapes: composer git_status / git_diff, the broker's log and show rows, a review blob read. */
const SHAPES = (blob: string): ReadonlyArray<readonly string[]> => [
  ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=normal"],
  ["diff", "--patch", "--no-ext-diff", "--no-textconv"],
  ["diff", "--patch", "--cached", "--no-ext-diff", "--no-textconv"],
  ["log", "--stat", "--no-ext-diff"],
  ["show", "-p", "--no-ext-diff", "--no-textconv", "HEAD"],
  ["diff", "--no-ext-diff", "--no-textconv", "HEAD~1", "HEAD"],
  ["cat-file", "-p", blob],
];

// Each pin is the only protection in one variant, so dropping it makes a vector fire there:
// - as installed: every pin;
// - an old-git stand-in (git 2.24 to 2.43 have no GIT_NO_LAZY_FETCH): GIT_ALLOW_PROTOCOL=/ and help.autocorrect=0 alone;
// - with GIT_ALLOW_PROTOCOL removed (git 2.44 and later): GIT_NO_LAZY_FETCH alone.
const VARIANTS: ReadonlyArray<readonly [string, () => string, string | false]> = [
  ["git as installed", () => GIT as string, false],
  ["old-git stand-in (no GIT_NO_LAZY_FETCH)", () => without("GIT_NO_LAZY_FETCH"), false],
  ["GIT_NO_LAZY_FETCH alone (no GIT_ALLOW_PROTOCOL)", () => without("GIT_ALLOW_PROTOCOL"), atLeast([2, 44, 0]) ? false : "GIT_NO_LAZY_FETCH needs git 2.44"],
];

for (const [label, pick, needs] of VARIANTS) {
  for (const vector of Object.keys(VECTORS)) {
    test(`no daemon-side git read runs a lazy-fetch program: ${vector}, ${label}`, { skip: SKIP || needs }, async () => {
      const h = hostile(vector);
      // Control: the same git with no Axis environment or options runs the repository's program.
      spawnSync(pick(), ["diff"], { cwd: h.wt.workTree, env: h.env, stdio: "ignore", timeout: 30_000 });
      assert.equal(h.fired(), true, `control: plain git diff runs the ${vector} program`);
      rmSync(h.marker, { force: true });
      const g = await daemonGitFor(h.wt, deps(pick(), h.env));
      for (const shape of SHAPES(h.missingBlob)) {
        // git may fail; a refusal must not pass for a safe call (the call has to really run).
        await g([...shape]).catch((e: unknown) => assert.notEqual((e as { code?: string }).code, "E_POLICY_DENIED", `${shape.join(" ")} was refused`));
        assert.equal(h.fired(), false, `${shape.join(" ")} ran it: ${h.fired() ? readFileSync(h.marker, "utf8") : ""}`);
      }
    });
  }
}

test("daemonGitEnv pins GIT_NO_LAZY_FETCH=1 and GIT_ALLOW_PROTOCOL=/ whatever the parent environment says", () => {
  for (const parent of [{ PATH: "/bin" }, { PATH: "/bin", GIT_NO_LAZY_FETCH: "0", GIT_ALLOW_PROTOCOL: "file:ssh:ext", GIT_PROTOCOL_FROM_USER: "1" }]) {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const env = daemonGitEnv(parent, platform);
      assert.deepEqual([env["GIT_NO_LAZY_FETCH"], env["GIT_ALLOW_PROTOCOL"]], ["1", "/"], platform);
      assert.equal(env["GIT_PROTOCOL_FROM_USER"], undefined);
    }
  }
});

test("daemonGitFor sets the pins after its fixed variables, so a fixed.env cannot replace one", async () => {
  const seen: GitRunRequest[] = [];
  const runner = {
    run: async (req: GitRunRequest) => (seen.push(req), { code: req.argv.includes("--version") ? 0 : 1, stdout: "git version 2.53.0\n", stderr: "" }),
  };
  const d: GitOpsDeps = { ...deps("/usr/bin/git", { PATH: "/bin" }), runner };
  const g = await daemonGitFor({ workTree: "/w", gitDir: "/w/.git" }, d, {}, { env: { GIT_NO_LAZY_FETCH: "0", GIT_ALLOW_PROTOCOL: "ext", GIT_ATTR_NOSYSTEM: "1" } });
  await g(["cat-file", "-p", "HEAD"]);
  assert.ok(seen.length >= 3, "the version check, the filter scan and the call");
  for (const r of seen) {
    assert.deepEqual([r.env["GIT_NO_LAZY_FETCH"], r.env["GIT_ALLOW_PROTOCOL"], r.env["GIT_ATTR_NOSYSTEM"]], ["1", "/", "1"], r.argv.join(" "));
  }
});
