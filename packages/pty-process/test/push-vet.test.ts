// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// H9-hooks S4 review 2 N-5: the service's remote check before a push (`vetPushRemote`), over a scripted exec: a failed or odd read
// refuses, the check is bounded and counted, and a control channel that closes while it runs starts nothing and kills its reads.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createPtyService, pushUrlAllowed, pushUrlsDigest, vetPushRemote, type ExecChild, type ExecOutcome, type ExecRequest } from "../src/index.js";
import { channelPair, FakeChild, ManualClock, settle, until } from "../testing/helpers.js";

const GIT = "/opt/fake-git/bin/git";
const URL = "https://example.invalid/r.git";
const BASE = { PATH: "/usr/bin:/bin", HOME: "/home/u" };
const EXPECT = { HOME: "/home/u", XDG_CONFIG_HOME: null, GIT_CONFIG: null, GIT_CONFIG_GLOBAL: null, GIT_CONFIG_SYSTEM: null, GIT_CONFIG_NOSYSTEM: null, GIT_SSH: null, GIT_SSH_COMMAND: null, GIT_SSH_VARIANT: null, GIT_PROXY_COMMAND: null };
const out = (stdout: string, code: number | null = 0): ExecOutcome => ({ code, signal: null, stdout: Buffer.from(stdout), stderr: new Uint8Array(), truncated: false });

type Answer = ExecOutcome | "hang" | "throw";
/** A service whose exec answers `config` (the vcs read) and `remote` (get-url) as scripted, and whose terminals are fakes. */
function rig(t: TestContext, answers: { vcs?: Answer; urls?: Answer }) {
  const scratch = mkdtempSync(join(tmpdir(), "axis-push-vet-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const execs: ExecRequest[] = [];
  const killed: string[] = [];
  const hanging: Array<(o: ExecOutcome) => void> = [];
  const spawned: string[][] = [];
  const exec = (req: ExecRequest): ExecChild => {
    execs.push(req);
    const sub = req.argv.find((a) => a === "config" || a === "remote") ?? "";
    const a: Answer = (sub === "config" ? answers.vcs : answers.urls) ?? (sub === "config" ? out("", 1) : out(`${URL}\n`));
    if (a === "throw") throw new Error("spawn failed");
    if (a === "hang") return { done: new Promise((resolve) => void hanging.push(resolve)), kill: () => void killed.push(sub) };
    return { done: Promise.resolve(a), kill: () => void killed.push(sub) };
  };
  const clock = new ManualClock();
  const svc = createPtyService({ clock, spawn: (q) => (spawned.push([...q.argv]), new FakeChild(4242)), git: { exec, gitPath: GIT, hooksOff: "/dev/null", scratchParent: scratch, baseEnv: BASE } });
  const pair = channelPair();
  svc.serveControl(pair.b);
  const replies: Array<Record<string, unknown>> = [];
  pair.a.onMessage((m) => void replies.push(m as Record<string, unknown>));
  t.after(() => svc.dispose());
  let n = 0;
  const msg = (extra: Record<string, unknown> = {}) => ({ t: "push", req: `v${++n}`, runId: "r", repo: { gitDir: "/w/.git", workTree: "/w" }, remote: "origin", refspec: `${"a".repeat(40)}:refs/heads/axis/feat`, pushUrls: pushUrlsDigest([URL]), env: {}, expectEnv: EXPECT, cols: 80, rows: 24, ...extra });
  const send = async (m: Record<string, unknown>): Promise<Record<string, unknown>> => {
    pair.a.send(m);
    await until(() => replies.some((x) => x["req"] === m["req"]));
    return replies.find((x) => x["req"] === m["req"]) as Record<string, unknown>;
  };
  return { msg, send, pair, replies, execs, killed, hanging, spawned, clock };
}
const code = (r: Record<string, unknown>): unknown => (r["t"] === "spawned" ? "spawned" : r["code"]);

test("a clean remote check spawns the push; the reads use the service's git, pinned, with the startup environment", async (t) => {
  const r = rig(t, {});
  assert.equal(code(await r.send(r.msg())), "spawned");
  assert.deepEqual(r.execs[0]?.argv.slice(-3), ["config", "--get-all", "remote.origin.vcs"]);
  assert.deepEqual(r.execs[1]?.argv.slice(-6), ["remote", "get-url", "--push", "--all", "--", "origin"]);
  assert.equal(r.execs[0]?.argv[0], GIT);
  assert.ok(r.execs.every((e) => e.argv.includes("core.hooksPath=/dev/null")));
  assert.equal(r.spawned.length, 1);
});

test("a failed read refuses: a vcs read that cannot start or exits other than a clean 1 (or prints anything), a get-url that fails, is empty or exits non-zero", async (t) => {
  const cases: Array<[string, { vcs?: Answer; urls?: Answer }, string]> = [
    ["vcs read cannot start", { vcs: "throw" }, "spawn_failed"],
    ["vcs read killed by a signal", { vcs: out("", null) }, "remote_refused"],
    ["vcs read exits 0 with a value", { vcs: out("file\n", 0) }, "remote_refused"],
    ["vcs read exits 3 (bad config)", { vcs: out("", 3) }, "remote_refused"],
    ["vcs read exits 1 but prints", { vcs: out("x\n", 1) }, "remote_refused"],
    ["get-url cannot start", { urls: "throw" }, "spawn_failed"],
    ["get-url exits 2 with a good URL", { urls: out(`${URL}\n`, 2) }, "remote_refused"],
    ["get-url prints nothing", { urls: out("\n", 0) }, "remote_refused"],
    ["get-url adds a URL", { urls: out(`${URL}\n${URL}x\n`, 0) }, "remote_refused"],
    ["get-url names another scheme", { urls: out("ftp://example.invalid/r.git\n", 0) }, "remote_refused"],
  ];
  for (const [what, answers, want] of cases) {
    const r = rig(t, answers);
    assert.equal(code(await r.send(r.msg())), want, what);
    assert.equal(r.spawned.length, 0, what);
  }
  // No URL at all is refused even when the expected digest is that of no URL (the empty list is not a destination).
  const none = rig(t, { urls: out("", 0) });
  assert.equal(code(await none.send(none.msg({ pushUrls: pushUrlsDigest([]) }))), "remote_refused");
  assert.equal(none.spawned.length, 0);
});

test("a hanging read is killed at its bound and refuses; at most four checks run at once, the fifth push is refused capacity", async (t) => {
  const r = rig(t, { vcs: "hang" });
  for (let i = 0; i < 4; i++) r.pair.a.send(r.msg());
  await until(() => r.hanging.length === 4);
  assert.equal(code(await r.send(r.msg())), "capacity");
  // Each hanging read is killed at its bound (the clock), then the push is refused.
  assert.equal(r.clock.timers.size, 4, "one bound per running read");
  r.clock.fire();
  await until(() => r.replies.filter((x) => x["code"] === "spawn_failed").length === 4);
  assert.deepEqual(r.killed, ["config", "config", "config", "config"]);
  assert.equal(r.spawned.length, 0);
});

test("the control channel closes while the check runs: its reads are killed, nothing spawns and nothing is sent", async (t) => {
  const r = rig(t, { vcs: "hang" });
  r.pair.a.send(r.msg());
  await until(() => r.hanging.length === 1);
  const before = r.replies.length;
  r.pair.b.close();
  await settle();
  assert.deepEqual(r.killed, ["config"], "the read was killed with the channel");
  for (const done of r.hanging) done(out("", 1)); // the read answers late: nothing may start from it
  await settle();
  assert.equal(r.spawned.length, 0);
  assert.equal(r.replies.length, before);
});

test("pushUrlAllowed follows git's helper grammar: a digit-led or any `<x>::` form and a scheme in another case are refused", () => {
  for (const u of ["https://h/r.git", "ssh://h/r", "git://h/r", "file:///r", "/abs/r.git", "rel/r.git", "user@host:r.git"]) assert.equal(pushUrlAllowed(u), true, u);
  for (const u of ["", "9p::x", "file::/r", "ext::sh", "x-y::z", "HTTPS://h/r", "SSH://h/r", "FILE:///r", "ftp://h/r", "git+ssh://h/r", "9p://h/r"]) assert.equal(pushUrlAllowed(u), false, u);
});

test("each read of the check is bounded well under the host's 10 s spawn bound", async () => {
  const bounds: number[] = [];
  const clock = { setTimeout: (_fn: () => void, ms: number) => (bounds.push(ms), bounds.length), clearTimeout: () => undefined };
  const exec = (req: ExecRequest): ExecChild => ({ done: Promise.resolve(req.argv.includes("config") ? out("", 1) : out(`${URL}\n`)), kill: () => undefined });
  const verdict = await vetPushRemote({ exec, gitPath: GIT, hooksOff: "/dev/null", baseEnv: BASE }, clock, { gitDir: "/w/.git", workTree: "/w" }, "origin", pushUrlsDigest([URL]), {}, new Set());
  assert.equal(verdict, true);
  assert.equal(bounds.length, 2);
  assert.ok(bounds.every((ms) => ms > 0 && ms <= 3_000), String(bounds));
});
