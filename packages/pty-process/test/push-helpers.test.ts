// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// H9-hooks S4 review 1: what a repository or the pty process's own environment could start through the service's push, each with a
// plain-git control that DOES start it. B-1: a `remote.<r>.vcs` helper (an allowed transport name included) or a `<t>::` URL, by
// alias or by a `git-remote-<t>` program; S-2: configuration and ssh variables other than the host's; S-3: a relative or
// worktree `PATH` entry supplying `ssh`.
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createPtyService } from "../src/index.js";
import { pipeExec } from "../testing/exec.js";
import { channelPair, pipeSpawn, until } from "../testing/helpers.js";
import { GIT, gitRig, SKIP, type GitRig } from "../testing/git.js";
import { expectOf, fixture, remoteRefs } from "../testing/push.js";

const TRANSPORTS = ["file", "git", "ssh"] as const;
const tryGit = (r: GitRig, args: string[], cwd: string, env?: Record<string, string>): void => {
  try {
    r.git(args, cwd, undefined, env);
  } catch {
    /* the markers and stubs exit non-zero */
  }
};
/** Refused by the service's own remote check: `spawn-failed` `remote_refused`, nothing spawned. */
async function refused(r: GitRig, msg: Record<string, unknown>): Promise<void> {
  const before = r.spawned.length;
  const reply = await r.send(msg);
  assert.deepEqual([reply.t, reply["code"]], ["spawn-failed", "remote_refused"], JSON.stringify(reply));
  assert.equal(r.spawned.length, before, "no push started");
}

for (const t of TRANSPORTS) {
  test(`B-1: remote.origin.vcs=${t} with alias.remote-${t} never runs through the service's push; control: plain git runs the alias`, { skip: SKIP }, async (tc) => {
    const r = gitRig();
    tc.after(() => r.cleanup());
    const f = fixture(r, `alias-${t}`);
    r.git(["config", "remote.origin.vcs", t], f.top);
    r.git(["config", `alias.remote-${t}`, `!${r.marker(`alias-${t}`, "exit 1\n")}`], f.top);
    await refused(r, f.msg());
    assert.equal(r.markers(), "");
    assert.equal(remoteRefs(r, f.remote), "");
    tryGit(r, ["push", "origin", `${f.tip}:refs/heads/axis/feat`], f.top);
    assert.match(r.markers(), new RegExp(`alias-${t}`), "control: plain git runs it");
  });

  test(`B-1: remote.origin.vcs=${t} with a git-remote-${t} program on the service's PATH never runs; control: plain git runs it`, { skip: SKIP }, async (tc) => {
    const r = gitRig();
    tc.after(() => r.cleanup());
    const f = fixture(r, `prog-${t}`);
    r.git(["config", "remote.origin.vcs", t], f.top);
    copyFileSync(r.marker(`prog-${t}`, "exit 1\n"), join(r.bin, `git-remote-${t}`));
    chmodSync(join(r.bin, `git-remote-${t}`), 0o755);
    await refused(r, f.msg());
    assert.equal(r.markers(), "");
    tryGit(r, ["push", "origin", `${f.tip}:refs/heads/axis/feat`], f.top);
    assert.match(r.markers(), new RegExp(`prog-${t}`), "control: plain git runs it");
  });

  test(`B-1: a ${t}:: URL (as written, or made by url.<base>.pushInsteadOf) never reaches its helper; control: plain git runs the alias`, { skip: SKIP }, async (tc) => {
    const r = gitRig();
    tc.after(() => r.cleanup());
    const f = fixture(r, `url-${t}`);
    r.git(["config", `alias.remote-${t}`, `!${r.marker(`url-${t}`, "exit 1\n")}`], f.top);
    r.git(["remote", "set-url", "origin", `${t}::${f.remote}`], f.top);
    await refused(r, f.msg());
    r.git(["remote", "set-url", "origin", f.remote], f.top);
    r.git(["config", `url.${t}::${f.remote}.pushInsteadOf`, f.remote], f.top);
    await refused(r, f.msg());
    assert.equal(r.markers(), "");
    tryGit(r, ["push", "origin", `${f.tip}:refs/heads/axis/feat`], f.top);
    assert.match(r.markers(), new RegExp(`url-${t}`), "control: plain git runs it");
  });
}

test("B-1: any remote.<r>.vcs, https included, is refused; a remote with none pushes", { skip: SKIP }, async (tc) => {
  const r = gitRig();
  tc.after(() => r.cleanup());
  const f = fixture(r, "vcs-any");
  for (const v of ["https", "/", "none"]) {
    r.git(["config", "remote.origin.vcs", v], f.top);
    await refused(r, f.msg());
  }
  r.git(["config", "--unset-all", "remote.origin.vcs"], f.top);
  const spawned = await r.send(f.msg());
  assert.equal((await r.exit(spawned.term as string)).exitCode, 0);
});

/** A service started with `baseEnv`, its control channel, and helpers to send a push and wait for its exit. */
function service(r: GitRig, baseEnv: Record<string, string>) {
  const replies: Array<Record<string, unknown>> = [];
  const spawned: Array<{ env: Readonly<Record<string, string>> }> = [];
  const spawn = pipeSpawn();
  const scratch = join(r.tmp, `scratch-${Object.keys(baseEnv).length}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(scratch, { mode: 0o700 });
  const svc = createPtyService({ spawn: (q) => (spawned.push(q), spawn(q)), git: { exec: pipeExec(), gitPath: GIT as string, hooksOff: "/dev/null", scratchParent: scratch, baseEnv } });
  const pair = channelPair();
  svc.serveControl(pair.b);
  pair.a.onMessage((m) => void replies.push(m as Record<string, unknown>));
  return {
    spawned,
    dispose: () => svc.dispose(),
    async send(m: Record<string, unknown>) {
      pair.a.send(m);
      await until(() => replies.some((x) => x["req"] === m["req"]));
      return replies.find((x) => x["req"] === m["req"]) as Record<string, unknown>;
    },
    async exit(term: string) {
      await until(() => replies.some((x) => x["t"] === "exit" && x["term"] === term));
      return replies.find((x) => x["t"] === "exit" && x["term"] === term) as Record<string, unknown>;
    },
  };
}

test("S-2: the push's configuration and ssh variables must be the host's: another GIT_CONFIG_GLOBAL (with a pushInsteadOf), HOME or GIT_SSH_COMMAND is env_denied", { skip: SKIP }, async (tc) => {
  const r = gitRig();
  tc.after(() => r.cleanup());
  const f = fixture(r, "cfg");
  const other = join(r.tmp, "other.git");
  r.git(["init", "-q", "--bare", other], r.tmp);
  const redirect = join(r.tmp, "redirect.gitconfig");
  writeFileSync(redirect, `[url "${other}"]\n\tpushInsteadOf = ${f.remote}\n`);
  const base = { PATH: r.baseEnv["PATH"] as string, HOME: r.home, LANG: "C" };
  const s = service(r, { ...base, GIT_CONFIG_GLOBAL: redirect });
  tc.after(() => s.dispose());
  // The host validated the push without that file: refused, and neither remote moves.
  const denied = await s.send(f.msg({ expectEnv: expectOf(base) }));
  assert.deepEqual([denied["t"], denied["code"]], ["spawn-failed", "env_denied"]);
  // Control: when the host did see the same file, the push runs, and it goes where that file says.
  const same = await s.send(f.msg({ expectEnv: expectOf({ ...base, GIT_CONFIG_GLOBAL: redirect }) }));
  assert.equal((await s.exit(same["term"] as string)).exitCode, 0);
  assert.equal(remoteRefs(r, f.remote), "");
  assert.match(remoteRefs(r, other), /refs\/heads\/axis\/feat/);
  for (const [name, value] of [["HOME", join(r.tmp, "elsewhere")], ["XDG_CONFIG_HOME", r.tmp], ["GIT_SSH_COMMAND", "ssh -F /dev/null"]] as const) {
    const reply = await s.send(f.msg({ expectEnv: { ...expectOf({ ...base, GIT_CONFIG_GLOBAL: redirect }), [name]: value } }));
    assert.deepEqual([reply["t"], reply["code"]], ["spawn-failed", "env_denied"], name);
  }
  assert.equal(s.spawned.length, 1);
});

test("S-3: a relative PATH entry and one inside the work tree never supply ssh; the push's PATH keeps only absolute entries outside the checkout; control: plain git runs them", { skip: SKIP }, async (tc) => {
  const r = gitRig();
  tc.after(() => r.cleanup());
  const f = fixture(r, "pathfix");
  const inTree = join(f.top, "node_modules", ".bin");
  mkdirSync(inTree, { recursive: true });
  mkdirSync(join(f.top, "relbin"));
  for (const [dir, name] of [[inTree, "tree-ssh"], [join(f.top, "relbin"), "rel-ssh"]] as const) {
    copyFileSync(r.marker(name, "exit 1\n"), join(dir, "ssh"));
    chmodSync(join(dir, "ssh"), 0o755);
  }
  r.git(["remote", "set-url", "origin", `ssh://host.invalid${f.remote}`], f.top);
  const sysPath = process.env["PATH"] ?? "/usr/bin:/bin";
  const path = `relbin:${inTree}:${sysPath}`;
  const base = { PATH: path, HOME: r.home, LANG: "C" };
  const s = service(r, base);
  tc.after(() => s.dispose());
  const reply = await s.send(f.msg({ expectEnv: expectOf(base) }));
  assert.equal(reply["t"], "spawned");
  await s.exit(reply["term"] as string);
  assert.equal(r.markers(), "", "neither planted ssh ran");
  const pushPath = s.spawned[0]?.env["PATH"] ?? "";
  assert.ok(!pushPath.split(":").includes("relbin") && !pushPath.includes(f.top), pushPath);
  // Control: the same PATH for plain git, from the work tree, runs the first planted ssh it finds.
  tryGit(r, ["push", "origin", `${f.tip}:refs/heads/axis/feat`], f.top, { PATH: path });
  assert.match(r.markers(), /rel-ssh|tree-ssh/);
});
