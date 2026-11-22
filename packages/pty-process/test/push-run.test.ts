// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// H9-hooks S4 part 1: the `push` control message. The service builds the argv (its pins, the one refspec, no hook), the cwd and the
// environment (the transport list of the push transports only, prompts off, the exec allow-list from the message); real git.
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pipeExec } from "../testing/exec.js";
import { channelPair, pipeSpawn, settle, until } from "../testing/helpers.js";
import { GIT, gitRig, SKIP } from "../testing/git.js";
import { expectOf, fixture, remoteRefs } from "../testing/push.js";
import { createPtyProcessPort, createPtyService, pushUrlsDigest } from "../src/index.js";


test("push: the service runs git push of the one refspec as a terminal, with its own pins and environment; the remote gets the tip", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const f = fixture(r);
  const spawned = await r.send(f.msg());
  assert.equal(spawned.t, "spawned", JSON.stringify(spawned));
  const exit = await r.exit(spawned.term as string);
  assert.equal(exit.exitCode, 0);
  assert.equal(remoteRefs(r, f.remote), `refs/heads/axis/feat ${f.tip}`);
  const s = r.spawned.at(-1);
  assert.ok(s !== undefined);
  // The literal token list (review N-2): a dropped or changed pin fails here.
  assert.deepEqual(s.argv, [
    GIT, "--no-pager", "--no-replace-objects", `--git-dir=${f.gitDir}`, `--work-tree=${f.top}`,
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "protocol.allow=never", "-c", "protocol.ext.allow=never", "-c", "help.autocorrect=0",
    "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always", "-c", "protocol.git.allow=always", "-c", "protocol.file.allow=always",
    "-c", "alias.remote-https=", "-c", "alias.remote-ssh=", "-c", "alias.remote-git=", "-c", "alias.remote-file=",
    "push", "--no-follow-tags", "--no-recurse-submodules", "--no-verify", "--", "origin", `${f.tip}:refs/heads/axis/feat`,
  ]);
  assert.equal(s.argv[0], GIT, "the service's own git");
  assert.equal(s.cwd, f.top);
  assert.equal(s.env["GIT_ALLOW_PROTOCOL"], "https:ssh:git:file", "exactly the push transports, whatever the repository allows");
  assert.equal(s.env["GIT_TERMINAL_PROMPT"], "0", "prompts off even when the message asks for them");
  assert.equal(s.env["GIT_NO_LAZY_FETCH"], "1");
  assert.equal(s.env["LANG"], "C");
  assert.equal(s.env["HOME"], r.home, "the user's startup environment (credentials, ssh) is the base");
  for (const n of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) assert.equal(s.env[n], undefined, n);
});

test("push: a force, another ref, a tag, a delete, a symbolic source, a URL, a path or an option is bad_argv and nothing starts", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const f = fixture(r);
  const cases: Array<Record<string, unknown>> = [
    { refspec: `+${f.tip}:refs/heads/axis/feat` },
    { refspec: `${f.tip}:refs/heads/main` },
    { refspec: `${f.tip}:refs/heads/axis/` },
    { refspec: `${f.tip}:refs/heads/axis/a/b` },
    { refspec: `${f.tip}:refs/tags/v1` },
    { refspec: ":refs/heads/axis/feat" },
    { refspec: "HEAD:refs/heads/axis/feat" },
    { refspec: `${f.tip.slice(0, 12)}:refs/heads/axis/feat` },
    { refspec: `${f.tip}:refs/heads/axis/*` },
    { remote: "https://example.invalid/r.git" },
    { remote: f.remote },
    { remote: "--receive-pack=/bin/sh" },
    { remote: "-o" },
    { remote: "ext::sh" },
    { repo: { gitDir: ".git", workTree: f.top } },
    { repo: { gitDir: f.gitDir, workTree: "work" } },
    { force: true },
    { argv: [GIT, "push", "--force"] },
  ];
  for (const extra of cases) {
    const reply = await r.send(f.msg(extra));
    assert.deepEqual([reply.t, reply["code"]], ["spawn-failed", "bad_argv"], JSON.stringify(extra));
  }
  assert.equal(r.spawned.length, 0);
  assert.equal(remoteRefs(r, f.remote), "");
});

test("push: a message env naming anything outside the exec allow-list is env_denied (GIT_SSH_COMMAND, HOME, a redirector, a config location)", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const f = fixture(r);
  for (const name of ["GIT_SSH_COMMAND", "GIT_SSH", "HOME", "GIT_DIR", "GIT_INDEX_FILE", "GIT_CONFIG_GLOBAL", "GIT_ALLOW_PROTOCOL", "GIT_TRACE", "SSH_AUTH_SOCK"]) {
    const reply = await r.send(f.msg({ env: { [name]: join(r.tmp, "x") } }));
    assert.deepEqual([reply.t, reply["code"]], ["spawn-failed", "env_denied"], name);
  }
  assert.equal(r.spawned.length, 0);
});

test("push: a data channel cannot send a push; a service without git refuses one; a planted pre-push never runs", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const f = fixture(r);
  const d = channelPair();
  r.service.serveData(d.b, "conn1");
  const got: unknown[] = [];
  d.a.onMessage((m) => void got.push(m));
  d.a.send(f.msg());
  await until(() => got.length > 0, "the data channel's refusal");
  await settle();
  assert.deepEqual(got, [{ t: "refused", term: null, code: "unsupported" }]);
  assert.equal(r.spawned.length, 0);

  const bare = createPtyService({ spawn: () => assert.fail("must not spawn") });
  const c = channelPair();
  bare.serveControl(c.b);
  const replies: unknown[] = [];
  c.a.onMessage((m) => void replies.push(m));
  const m = f.msg();
  c.a.send(m);
  await until(() => replies.length > 0, "the spawn-failed reply of a service without git");
  await settle();
  assert.deepEqual(replies, [{ t: "spawn-failed", req: m["req"], code: "spawn_failed" }]);
  bare.dispose();

  const hook = r.marker("pre-push");
  copyFileSync(hook, join(f.gitDir, "hooks", "pre-push"));
  chmodSync(join(f.gitDir, "hooks", "pre-push"), 0o755);
  const spawned = await r.send(f.msg());
  assert.equal((await r.exit(spawned.term as string)).exitCode, 0);
  assert.equal(r.markers(), "", "the hooks pin and --no-verify: no pre-push");
  assert.equal(existsSync(join(f.gitDir, "hooks", "pre-push")), true);
  r.git(["push", "origin", `${f.tip}:refs/heads/axis/control`], f.top);
  assert.match(readFileSync(join(r.tmp, "markers.log"), "utf8"), /pre-push/, "control: plain git runs it");
});

test("the host port's push: settles on spawned with a handle whose exit is the status, rejects with the closed code, and on a closed channel", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const f = fixture(r);
  const c = channelPair();
  r.service.dispose();
  const svc = createPtyService({ spawn: pipeSpawn(), git: { exec: pipeExec(), gitPath: GIT as string, hooksOff: "/dev/null", scratchParent: r.scratchParent, baseEnv: r.baseEnv } });
  t.after(() => svc.dispose());
  svc.serveControl(c.b);
  const port = createPtyProcessPort({ channel: c.a });
  t.after(() => port.dispose());
  const call = { runId: "p1", repo: { gitDir: f.gitDir, workTree: f.top }, remote: "origin", refspec: `${f.tip}:refs/heads/axis/feat`, pushUrls: pushUrlsDigest([f.remote]), env: {}, expectEnv: expectOf(r.baseEnv) as never, cols: 80, rows: 24 };
  const h = await port.push(call);
  const exit = await new Promise((resolve) => h.onExit(resolve));
  assert.deepEqual(exit, { exitCode: 0, signal: null });
  assert.equal(remoteRefs(r, f.remote), `refs/heads/axis/feat ${f.tip}`);
  await assert.rejects(port.push({ ...call, refspec: `+${f.tip}:refs/heads/axis/feat` }), (e: unknown) => (e as { code?: string }).code === "bad_argv");
  await assert.rejects(port.push({ ...call, env: { HOME: "/x" } }), (e: unknown) => (e as { code?: string }).code === "env_denied");
  c.b.close();
  await settle();
  await assert.rejects(port.push(call), (e: unknown) => (e as { code?: string }).code === "channel_closed");
});
