// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// H9-hooks S4 part 1 with real git: git-ops' real push, sent by the host's push handler after a spent tier 4 approval, runs as a
// terminal in the real pty service over the real host port, against a local bare remote (a path) and over a stubbed ssh. Replaces
// the S1 guard "push over the pty process is not available until S4".
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { GitRunRequest } from "@axis/git-ops";
import type { PtySpawnError } from "@axis/pty-process";
import { gitRig, gitUnavailable, type GitClient, type GitRig, type GitRigOptions } from "./git-rig.js";
import { ptyProcessRig, type PtyProcessRig } from "./pty-process-rig.js";

const SKIP = process.platform === "win32" ? "POSIX process groups are needed (the Windows path is unverified)" : gitUnavailable();
/** Assembled at runtime so no credential-shaped literal sits in this file. */
const CANARY = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
type Plan = { tip: string; digest: string };

async function setup(t: TestContext, options: GitRigOptions = {}, pathPrefix = ""): Promise<{ r: GitRig; c: GitClient; pty: PtyProcessRig; sent: GitRunRequest[] }> {
  let pty: PtyProcessRig | undefined;
  const sent: GitRunRequest[] = [];
  const r = await gitRig({
    ...options,
    ptyRunner: ({ home, gitPath, path }) => {
      pty = ptyProcessRig(gitPath, { PATH: `${pathPrefix}${path}`, HOME: home, GIT_CONFIG_NOSYSTEM: "1", LANG: "C" });
      const runner = pty.runner;
      return { run: (req) => (sent.push(req), runner.run(req)) };
    },
  });
  const p = pty as unknown as PtyProcessRig;
  t.after(() => (p.cleanup(), r.cleanup()));
  return { r, c: await r.connect("user"), pty: p, sent };
}
const commitFile = (r: GitRig, name: string, text: string): string => {
  r.write(name, text);
  r.git("add", "-A");
  r.git("commit", "-q", "--no-verify", "-m", `add ${name}`);
  return r.head();
};
async function plan(r: GitRig, c: GitClient): Promise<Plan> {
  const res = await c.rpc("axis.git", "pushPlan", { workspaceId: r.workspaceId, remote: "origin" });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  return res.result as unknown as Plan;
}
/** The tier 4 flow up to the spend: the challenge, the approval and the native confirmation. `finish` sends the push with the approval. */
async function approve(r: GitRig, c: GitClient, p: Plan): Promise<() => ReturnType<GitClient["rpc"]>> {
  const req = { workspaceId: r.workspaceId, remote: "origin", confirmedPlan: { tip: p.tip, digest: p.digest } };
  const key = randomUUID();
  const first = await c.rpc("axis.git", "push", req, key);
  assert.equal(first.error?.code, "E_APPROVAL_REQUIRED", JSON.stringify(first.error));
  const ch = (first.error?.details as { challenge: { challengeId: string; digest: string } }).challenge;
  const resolved = await c.rpc("axis.approvals", "resolve", { challengeId: ch.challengeId, decision: "approve", digest: ch.digest });
  assert.equal(resolved.ok, true, JSON.stringify(resolved.error));
  await r.confirmNative(ch.challengeId);
  const end = Date.now() + 5000;
  while (r.approvals.stats().native.entries !== 0) {
    if (Date.now() > end) assert.fail("native confirmation not applied");
    await new Promise((x) => setTimeout(x, 5));
  }
  return () => c.rpc("axis.git", "push", { ...req, approval: { challengeId: ch.challengeId } }, key);
}
const pushes = (pty: PtyProcessRig) => pty.spawned.filter((s) => s.argv.includes("push"));
const remoteRefs = (r: GitRig, dir = r.remote): string => execFileSync("git", ["--git-dir", dir, "for-each-ref", "--format=%(refname) %(objectname)"], { env: r.genv, encoding: "utf8" }).trim();
const noLeak = (r: GitRig, m: unknown): void => {
  const text = JSON.stringify(m);
  assert.ok(!text.includes(r.root) && !text.includes("remote.git") && !text.includes("To ") && !text.includes("->"), text);
};

test("a confirmed push runs git push in the pty process as a terminal: the remote gets the planned tip, the service's pins, only an exit status back", { skip: SKIP ?? false }, async (t) => {
  const { r, c, pty, sent } = await setup(t);
  const tip = commitFile(r, "b.txt", "bee\n");
  const p = await plan(r, c);
  assert.equal(p.tip, tip);
  const res = await (await approve(r, c, p))();
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.deepEqual(res.result, { remote: "origin", branch: "axis/feat", tip });
  noLeak(r, res);
  assert.equal(r.remoteTip(), tip, "the planned tip is on the remote");
  assert.ok(sent.some((q) => q.argv.includes("push")), "git-ops' real push request went through the runner");
  assert.equal(pty.execs.filter((e) => e.argv.includes("push")).length, 0, "a push is never an exec");
  const run = pushes(pty);
  assert.equal(run.length, 1);
  const s = run[0] as (typeof run)[number];
  const at = s.argv.indexOf("push");
  assert.deepEqual(s.argv.slice(at), ["push", "--no-follow-tags", "--no-recurse-submodules", "--no-verify", "--", "origin", `${tip}:refs/heads/axis/feat`]);
  for (const pin of ["core.hooksPath=/dev/null", "core.fsmonitor=", "protocol.allow=never", "protocol.ext.allow=never", "protocol.file.allow=always"]) {
    assert.ok(s.argv.slice(0, at).includes(pin), pin);
  }
  assert.ok(s.argv.includes(`--git-dir=${join(r.repo, ".git")}`) && s.argv.includes(`--work-tree=${r.repo}`), "the journal's directories (GIT-4)");
  assert.equal(s.cwd, r.repo);
  assert.equal(s.env["GIT_ALLOW_PROTOCOL"], "https:ssh:git:file");
  assert.equal(s.env["GIT_TERMINAL_PROMPT"], "0");
  assert.equal(s.env["GIT_DIR"], undefined);
  assert.equal(r.gate.recordPushed.at(-1), tip, "recorded as pushed");
});

test("plan digest mismatch: a push whose confirmed digest is not the plan's is plan_changed before any challenge, and nothing runs", { skip: SKIP ?? false }, async (t) => {
  const { r, c, pty } = await setup(t);
  commitFile(r, "b.txt", "bee\n");
  const p = await plan(r, c);
  const res = await c.rpc("axis.git", "push", { workspaceId: r.workspaceId, remote: "origin", confirmedPlan: { tip: p.tip, digest: "0".repeat(64) } }, randomUUID());
  assert.equal(res.error?.code, "E_CONFLICT");
  assert.equal((res.error?.details as { reason?: string }).reason, "plan_changed");
  assert.equal(pushes(pty).length, 0);
  assert.equal(r.remoteTip(), null);
});

test("the remote re-pointed after the approval: the approved digest named the old destination, so the spend is plan_changed and neither remote moves", { skip: SKIP ?? false }, async (t) => {
  const { r, c, pty } = await setup(t);
  commitFile(r, "b.txt", "bee\n");
  const finish = await approve(r, c, await plan(r, c));
  const other = join(r.root, "other.git");
  execFileSync("git", ["init", "-q", "--bare", other], { env: r.genv, stdio: "ignore" });
  r.git("remote", "set-url", "origin", other);
  const res = await finish();
  assert.equal(res.error?.code, "E_CONFLICT", JSON.stringify(res.error));
  assert.equal((res.error?.details as { reason?: string }).reason, "plan_changed");
  assert.equal(pushes(pty).length, 0);
  assert.equal(remoteRefs(r, other), "", "the new destination got nothing");
  assert.equal(r.remoteTip(), null);
});

test("the remote branch moved between the plan and the push (another pusher): the push is not forced; refused, their commit stays", { skip: SKIP ?? false }, async (t) => {
  const { r, c, pty } = await setup(t);
  commitFile(r, "b.txt", "bee\n");
  const finish = await approve(r, c, await plan(r, c));
  // A commit that is not an ancestor of the tip lands on the remote's branch.
  const theirs = execFileSync("git", ["commit-tree", "-p", r.baseSha, "-m", "theirs", `${r.baseSha}^{tree}`], { cwd: r.repo, env: r.genv, encoding: "utf8" }).trim();
  r.git("push", "-q", "--no-verify", "origin", `${theirs}:refs/heads/axis/feat`);
  const res = await finish();
  assert.equal(res.error?.code, "E_UNAVAILABLE", JSON.stringify(res.error));
  noLeak(r, res);
  assert.equal(pushes(pty).length, 1, "git ran and the remote refused the non-fast-forward");
  assert.equal(r.remoteTip(), theirs);
  assert.equal(r.gate.recordPushed.length, 0, "nothing is recorded as pushed");
});

for (const where of ["the common hooks directory", "a repository core.hooksPath"] as const) {
  test(`a planted pre-push and reference-transaction hook in ${where} (rewriting refs, planting config) never run; control: plain git runs them`, { skip: SKIP ?? false }, async (t) => {
    const { r, c } = await setup(t);
    const tip = commitFile(r, "b.txt", "bee\n");
    const dir = where === "a repository core.hooksPath" ? join(r.repo, ".githooks") : join(r.repo, ".git", "hooks");
    mkdirSync(dir, { recursive: true });
    if (where === "a repository core.hooksPath") r.git("config", "core.hooksPath", dir);
    const marker = join(r.root, "hook-ran");
    const hook = (name: string, body: string): void => {
      writeFileSync(join(dir, name), `#!/bin/sh\necho ${name} >> '${marker}'\n${body}`);
      chmodSync(join(dir, name), 0o755);
    };
    hook("pre-push", `git config core.fsmonitor '${join(r.root, "planted")}'\ngit update-ref refs/heads/planted HEAD\nexit 0\n`);
    hook("reference-transaction", "exit 0\n");
    const refsBefore = r.git("for-each-ref", "--format=%(refname)", "refs/heads");
    const res = await (await approve(r, c, await plan(r, c)))();
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(r.remoteTip(), tip);
    assert.equal(existsSync(marker), false, "no hook ran");
    assert.equal(r.git("for-each-ref", "--format=%(refname)", "refs/heads"), refsBefore, "no ref was rewritten");
    assert.throws(() => r.git("config", "--get", "core.fsmonitor"), "no config was planted");
    // Control: the same hooks are live for plain git, so the assertions above could fail.
    r.git("push", "-q", "origin", `${tip}:refs/heads/axis/control`);
    assert.match(readFileSync(marker, "utf8"), /pre-push/);
    assert.equal(r.git("config", "--get", "core.fsmonitor").trim(), join(r.root, "planted"));
  });
}

test("only the planned ref goes out: no tag (push.followTags), no configured push refspec, no other branch; another ref or a force is refused by the pty process", { skip: SKIP ?? false }, async (t) => {
  const { r, c, pty } = await setup(t);
  const tip = commitFile(r, "b.txt", "bee\n");
  r.git("config", "push.followTags", "true");
  r.git("config", "remote.origin.push", "+refs/heads/*:refs/heads/*");
  r.git("tag", "-a", "-m", "release", "v1", tip);
  r.git("branch", "other", r.baseSha);
  const res = await (await approve(r, c, await plan(r, c)))();
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(remoteRefs(r), `refs/heads/axis/feat ${tip}`);
  // The pty process itself refuses anything but `<id>:refs/heads/axis/<slug>`, whoever asks.
  const call = { runId: "x", repo: { gitDir: join(r.repo, ".git"), workTree: r.repo }, remote: "origin", env: {}, cols: 80, rows: 24 };
  for (const refspec of [`+${tip}:refs/heads/axis/feat`, `${tip}:refs/heads/main`, `${tip}:refs/tags/v2`, ":refs/heads/axis/feat", "refs/heads/other:refs/heads/axis/feat", `${tip}:refs/heads/axis/feat --force`]) {
    await assert.rejects(pty.port.push({ ...call, refspec }), (e: unknown) => (e as PtySpawnError).code === "bad_argv", refspec);
  }
  for (const remote of ["--receive-pack=/bin/sh", r.remote, "https://example.invalid/r.git"]) {
    await assert.rejects(pty.port.push({ ...call, remote, refspec: `${tip}:refs/heads/axis/feat` }), (e: unknown) => (e as PtySpawnError).code === "bad_argv", remote);
  }
  await assert.rejects(pty.port.push({ ...call, env: { GIT_SSH_COMMAND: "/bin/sh" }, refspec: `${tip}:refs/heads/axis/feat` }), (e: unknown) => (e as PtySpawnError).code === "env_denied");
  assert.equal(pushes(pty).length, 1, "only the approved push ran");
  assert.equal(remoteRefs(r), `refs/heads/axis/feat ${tip}`);
});

test("the branch moved after the plan: the commit made since is not pushed; plan_changed", { skip: SKIP ?? false }, async (t) => {
  const { r, c, pty } = await setup(t);
  commitFile(r, "b.txt", "bee\n");
  const finish = await approve(r, c, await plan(r, c));
  commitFile(r, "c.txt", "sea\n");
  const res = await finish();
  assert.equal((res.error?.details as { reason?: string }).reason, "plan_changed", JSON.stringify(res.error));
  assert.equal(pushes(pty).length, 0);
  assert.equal(r.remoteTip(), null);
});

test("without an approval nothing is pushed (tier 4); a forged approval is refused too", { skip: SKIP ?? false }, async (t) => {
  const { r, c, pty } = await setup(t);
  commitFile(r, "b.txt", "bee\n");
  const p = await plan(r, c);
  const req = { workspaceId: r.workspaceId, remote: "origin", confirmedPlan: { tip: p.tip, digest: p.digest } };
  assert.equal((await c.rpc("axis.git", "push", req, randomUUID())).error?.code, "E_APPROVAL_REQUIRED");
  const forged = await c.rpc("axis.git", "push", { ...req, approval: { challengeId: "A".repeat(43) } }, randomUUID());
  assert.equal(forged.ok, false);
  assert.equal(pushes(pty).length, 0);
  assert.equal(r.remoteTip(), null);
});

test("a secret in a pushed blob: the plan is blocked secrets_found, the push is refused before a challenge and nothing runs", { skip: SKIP ?? false }, async (t) => {
  const { r, c, pty } = await setup(t);
  commitFile(r, "cfg.txt", `aws_access_key_id = ${CANARY}\n`);
  const planned = await c.rpc("axis.git", "pushPlan", { workspaceId: r.workspaceId, remote: "origin" });
  assert.equal((planned.result as { blocked?: { reason: string } }).blocked?.reason, "secrets_found", JSON.stringify(planned));
  const p = planned.result as unknown as Plan;
  const res = await c.rpc("axis.git", "push", { workspaceId: r.workspaceId, remote: "origin", confirmedPlan: { tip: p.tip, digest: p.digest } }, randomUUID());
  assert.equal(res.error?.code, "E_CONFLICT");
  assert.equal((res.error?.details as { reason?: string }).reason, "secrets_found");
  assert.ok(!JSON.stringify([planned, res]).includes(CANARY), "no matched text");
  assert.equal(pushes(pty).length, 0);
  assert.equal(r.remoteTip(), null);
});

/** An `ssh` for the pty process's PATH that serves the remote locally: `-G` (git's variant probe) answers, a command runs `git <cmd>`. */
function sshStub(t: TestContext): { bin: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), "axis-ssh-stub-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "ssh.log");
  writeFileSync(
    join(bin, "ssh"),
    `#!/bin/sh\nfor a in "$@"; do [ "$a" = "-G" ] && exit 0; done\nfor a in "$@"; do last="$a"; done\necho "$*" >> '${log}'\ncase "$last" in git-receive-pack*) exec sh -c "git \${last#git-}";; esac\nexit 9\n`,
  );
  chmodSync(join(bin, "ssh"), 0o755);
  return { bin, log };
}
const resolver = async (host: string) => {
  if (host !== "axis-test-host") throw new Error("no such alias");
  return { hostname: "git.example.test", port: 22 };
};

test("over ssh: a push to a resolvable alias runs through the user's ssh (stubbed) and lands; an unknown alias fails closed before any scan or run", { skip: SKIP ?? false }, async (t) => {
  const stub = sshStub(t);
  const { r, c, pty } = await setup(t, { resolveSshHost: resolver }, `${stub.bin}:`);
  r.git("remote", "set-url", "origin", `ssh://axis-test-host${r.remote}`);
  const tip = commitFile(r, "b.txt", "bee\n");
  const p = await plan(r, c);
  const res = await (await approve(r, c, p))();
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(r.remoteTip(), tip);
  assert.match(readFileSync(stub.log, "utf8"), /axis-test-host/, "the push went through ssh");
  // An alias the person's ssh cannot resolve: no destination, so no scan base and no push.
  r.git("remote", "set-url", "origin", `ssh://unknown-alias${r.remote}`);
  commitFile(r, "c.txt", "sea\n");
  const unknown = await c.rpc("axis.git", "pushPlan", { workspaceId: r.workspaceId, remote: "origin" });
  assert.equal(unknown.error?.code, "E_INVALID_ARGUMENT", JSON.stringify(unknown));
  const pushed = await c.rpc("axis.git", "push", { workspaceId: r.workspaceId, remote: "origin", confirmedPlan: { tip: r.head(), digest: p.digest } }, randomUUID());
  assert.equal(pushed.error?.code, "E_INVALID_ARGUMENT");
  assert.equal(pushes(pty).length, 1, "only the first push ran");
  assert.equal(r.remoteTip(), tip);
});
