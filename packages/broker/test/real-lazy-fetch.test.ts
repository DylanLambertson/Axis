// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The broker's git (composer git_status / git_diff and the log and show rows) on a partial clone whose OWN config chooses what
// a lazy fetch runs: no call may start it. The same vectors as git-ops test/real-lazy-fetch.test.ts, through createBrokerGit.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createNodeRunner, type WorktreeRef } from "@axis/git-ops";
import { createBrokerGit, type GitCall } from "../src/index.js";

const GIT = ((): string | undefined => {
  const r = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
})();
const minor = ((): number => {
  const m = GIT === undefined ? null : /git version (\d+)\.(\d+)/.exec(execFileSync(GIT, ["--version"], { encoding: "utf8" }));
  return m === null ? 0 : Number(m[1]) > 2 ? Infinity : Number(m[1]) === 2 ? Number(m[2]) : 0;
})();
const partialOk = minor >= 27;
const SKIP = process.platform === "win32" ? "POSIX shell fixture" : !partialOk ? "partial clone over file:// needs git 2.27" : false;
const PATH = process.env["PATH"] ?? "/usr/bin:/bin";

const VECTORS: Readonly<Record<string, (evil: string) => ReadonlyArray<readonly [string, string]>>> = {
  uploadpack: (e) => [["protocol.file.allow", "always"], ["remote.origin.uploadpack", e]],
  vcsAlias: (e) => [["protocol.evil.allow", "always"], ["remote.origin.vcs", "evil"], ["alias.remote-evil", `!${e}`]],
  helperUrl: (e) => [["protocol.evil.allow", "always"], ["remote.origin.url", "evil::x"], ["alias.remote-evil", `!${e}`]],
  sshCommand: (e) => [["protocol.ssh.allow", "always"], ["remote.origin.url", "ssh://h.invalid/x"], ["core.sshCommand", e]],
  slashAutocorrect: (e) => [["protocol./.allow", "always"], ["remote.origin.vcs", "/"], ["help.autocorrect", "1"], ["alias.remote-a", `!${e}`]],
  emptyVcs: (e) => [["protocol.allow", "always"], ["remote.origin.vcs", ""], ["alias.remote-", `!${e}`]],
};

const dirs: string[] = [];
process.on("exit", () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};

/** A partial clone with missing blobs behind a modified file and a staged rename, its config set to `vector`. */
function hostile(vector: string) {
  const g = GIT as string;
  const root = tmp("axis-broker-lazy-");
  const home = join(root, "home");
  mkdirSync(home);
  const env = { PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", LANG: "C" };
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
  const blob = run(repo, "rev-parse", "HEAD~1:a.txt").trim();
  run(repo, "update-index", "--force-remove", "old.txt");
  run(repo, "update-index", "--add", "--cacheinfo", `100644,${blob},new.txt`);
  const marker = join(root, "MARKER");
  const evil = join(root, "evil.sh");
  writeFileSync(evil, `#!/bin/sh\necho "$0 $*" >> '${marker}'\nexit 1\n`);
  chmodSync(evil, 0o755);
  for (const [k, v] of (VECTORS[vector] as (e: string) => ReadonlyArray<readonly [string, string]>)(evil)) run(repo, "config", k, v);
  const w: WorktreeRef = { workTree: repo, gitDir: join(repo, ".git") };
  return { w, env, marker, fired: () => existsSync(marker) };
}

function without(name: string): string {
  const p = join(tmp("axis-broker-gitwrap-"), "git");
  writeFileSync(p, `#!/bin/sh\nunset ${name}\nexec '${GIT as string}' "$@"\n`);
  chmodSync(p, 0o755);
  return p;
}

/** The calls the composer's git_status / git_diff build (daemon-host bindings/agent-git.ts) and the log and show rows. */
const CALLS: ReadonlyArray<readonly [string, GitCall]> = [
  ["git_status", { command: "status", flags: ["--porcelain=v1", "-z", "--branch", "--untracked-files=normal"] }],
  ["git_diff", { command: "diff", flags: ["--patch"] }],
  ["git_diff staged", { command: "diff", flags: ["--patch", "--cached"] }],
  ["git_diff context paths", { command: "diff", flags: ["--patch", "--unified=0"], paths: ["a.txt"] }],
  ["git_diff staged context", { command: "diff", flags: ["--patch", "--cached", "--unified=5"] }],
  ["log --stat", { command: "log", flags: ["--stat"] }],
  ["show -p HEAD", { command: "show", flags: ["-p"], revs: ["HEAD"] }],
];

// Each pin is the only protection in one variant: as installed (every pin); the old-git stand-in (GIT_ALLOW_PROTOCOL=/ and
// help.autocorrect=0 alone); GIT_ALLOW_PROTOCOL removed (GIT_NO_LAZY_FETCH alone, git 2.44 and later).
const VARIANTS: ReadonlyArray<readonly [string, () => string, string | false]> = [
  ["git as installed", () => GIT as string, false],
  ["old-git stand-in (no GIT_NO_LAZY_FETCH)", () => without("GIT_NO_LAZY_FETCH"), false],
  ["GIT_NO_LAZY_FETCH alone (no GIT_ALLOW_PROTOCOL)", () => without("GIT_ALLOW_PROTOCOL"), minor >= 44 ? false : "GIT_NO_LAZY_FETCH needs git 2.44"],
];

for (const [label, pick, needs] of VARIANTS) {
  for (const vector of Object.keys(VECTORS)) {
    test(`no broker git call runs a lazy-fetch program: ${vector}, ${label}`, { skip: SKIP || needs }, async () => {
      const h = hostile(vector);
      spawnSync(pick(), ["diff"], { cwd: h.w.workTree, env: h.env, stdio: "ignore", timeout: 30_000 });
      assert.equal(h.fired(), true, `control: plain git diff runs the ${vector} program`);
      rmSync(h.marker, { force: true });
      const git = createBrokerGit({ runner: createNodeRunner({ gitPath: pick(), env: h.env }), parentEnv: h.env, assertNoDrift: async () => undefined, platform: "linux" });
      for (const [name, call] of CALLS) {
        // git may fail; a refusal must not pass for a safe call (the call has to really run).
        await git.run(h.w, call).catch((e: unknown) => assert.notEqual((e as { code?: string }).code, "E_POLICY_DENIED", `${name} was refused`));
        assert.equal(h.fired(), false, `${name} ran it: ${h.fired() ? readFileSync(h.marker, "utf8") : ""}`);
      }
    });
  }
}
