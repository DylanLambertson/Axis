// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { delimiter, join, parse } from "node:path";
import { test } from "node:test";
import { createSshResolver, parseSshConfig, type SshProcess, type SshSpawn } from "../src/index.js";

interface Call {
  file: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  options: Record<string, unknown>;
}
type Script = (child: FakeChild) => void;
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  killed = 0;
  kill(): boolean {
    this.killed += 1;
    return true;
  }
}
function rig(script: Script, extra: { timeoutMs?: number; maxOutputBytes?: number; maxPending?: number; excludeDirs?: () => readonly string[]; path?: string } = {}) {
  const calls: Call[] = [];
  const children: FakeChild[] = [];
  const spawn: SshSpawn = (file, args, options) => {
    const { env, ...rest } = options;
    calls.push({ file, args, env, options: rest });
    const c = new FakeChild();
    children.push(c);
    setImmediate(() => script(c));
    return c as unknown as SshProcess;
  };
  const resolve = createSshResolver({ spawn, env: { PATH: extra.path ?? "/p", HOME: "/h", SECRETISH: "x", SSH_ASKPASS: "/evil", USER: "u" }, ...extra });
  return { calls, children, resolve };
}
const answer = (text: string, code = 0): Script => (c) => {
  c.stdout.emit("data", Buffer.from(text));
  c.emit("close", code);
};
const GOOD = "host alias\nuser git\nhostname git.example.test\nport 22\nidentityfile ~/x\n";

test("the argv is pinned, no shell, the environment is scrubbed, and only hostname, port and user are read", async () => {
  const r = rig(answer(GOOD));
  const got = await r.resolve("alias", undefined, undefined);
  assert.deepEqual(got, { hostname: "git.example.test", port: 22, user: "git" });
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]?.file, "ssh");
  assert.deepEqual(r.calls[0]?.args, ["-G", "--", "alias"]);
  assert.deepEqual(r.calls[0]?.env, { LC_ALL: "C", PATH: "/p", HOME: "/h", USER: "u" });
  assert.deepEqual(r.calls[0]?.options, { shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, detached: true }, "the options make a pass-through embedder correct");
  const withUser = rig(answer(GOOD));
  await withUser.resolve("alias", "bob", 2200);
  assert.deepEqual(withUser.calls[0]?.args, ["-G", "-l", "bob", "-p", "2200", "--", "alias"]);
});

test("an ipv6 literal is passed without its brackets", async () => {
  const r = rig(answer("hostname ::1\nport 22\n"));
  assert.equal((await r.resolve("[::1]", undefined, undefined)).hostname, "::1");
  assert.equal(r.calls[0]?.args.at(-1), "::1");
});

test("a host outside the strict character set never starts a process", async () => {
  const r = rig(answer(GOOD));
  const bad = ["", "-v", "--", "-", "-oX", "[-v]", "-oProxyCommand=x", "a@b", "a b", "a\nb", "a\u0085b", "a\u0000b", "hoét", "a;b", "a$(x)", "a/b", "a%b", "x".repeat(256), "[a", "[]"];
  for (const h of bad) await assert.rejects(r.resolve(h, undefined, undefined), () => true, JSON.stringify(h));
  for (const u of ["-x", "a b", "a\nb", "a@b", "", "\u0085"]) await assert.rejects(r.resolve("good", u, undefined), () => true, JSON.stringify(u));
  for (const p of [0, 65536, 1.5, Number.NaN]) await assert.rejects(r.resolve("good", undefined, p));
  assert.equal(r.calls.length, 0, "nothing was started");
});

test("a non-zero exit, a start failure, a process error and an unusable answer all throw", async () => {
  await assert.rejects(rig(answer(GOOD, 255)).resolve("a1", undefined, undefined));
  await assert.rejects(rig((c) => c.emit("error", new Error("ENOENT"))).resolve("a1", undefined, undefined));
  const thrower = createSshResolver({ spawn: () => { throw new Error("EACCES"); }, env: {} });
  await assert.rejects(thrower("a1", undefined, undefined));
  for (const text of ["", "port 22\n", "hostname h\n", "hostname h\nport 0\n", "hostname h\nport 70000\n", "hostname h\nport 22x\n", "hostname a b\nport 22\n", "hostname h\nport 22\nuser -x\n", "hostname h\nport 22\nuser a b\n"]) {
    await assert.rejects(rig(answer(text)).resolve("a1", undefined, undefined), () => true, JSON.stringify(text));
  }
  await assert.rejects(rig((c) => { c.stdout.emit("data", Buffer.from([0xff, 0xfe])); c.emit("close", 0); }).resolve("a1", undefined, undefined), () => true, "bad utf-8");
});

test("two different values for one key are an anomaly; a repeated equal value is not; other keys are ignored", () => {
  assert.throws(() => parseSshConfig("hostname a\nhostname b\nport 22\n"));
  assert.throws(() => parseSshConfig("hostname a\nport 22\nport 23\n"));
  assert.deepEqual(parseSshConfig("hostname a\nhostname a\nport 22\nproxycommand evil $(x)\nhostname\n"), { hostname: "a", port: 22 });
});

test("too much output kills the process and throws; a late event changes nothing", async () => {
  const r = rig((c) => { c.stdout.emit("data", Buffer.alloc(40)); c.stdout.emit("data", Buffer.alloc(40)); c.emit("close", 0); }, { maxOutputBytes: 64 });
  await assert.rejects(r.resolve("a1", undefined, undefined));
  assert.equal(r.children[0]?.killed, 1);
  const exact = rig((c) => { c.stdout.emit("data", Buffer.from("hostname h\nport 22\n")); c.emit("close", 0); }, { maxOutputBytes: 19 });
  assert.equal((await exact.resolve("a1", undefined, undefined)).port, 22, "output exactly at the bound is accepted");
  const over = rig((c) => { c.stdout.emit("data", Buffer.from("hostname h\nport 22\n")); c.emit("close", 0); }, { maxOutputBytes: 18 });
  await assert.rejects(over.resolve("a1", undefined, undefined), () => true, "one byte over the bound is refused");
});

test("a process that never answers is killed at the timeout", async () => {
  const r = rig(() => undefined, { timeoutMs: 20 });
  await assert.rejects(r.resolve("a1", undefined, undefined));
  assert.equal(r.children[0]?.killed, 1);
});

test("resolutions run one at a time and the queue is bounded", async () => {
  let live = 0;
  let peak = 0;
  const r = rig((c) => {
    live += 1;
    peak = Math.max(peak, live);
    setImmediate(() => { live -= 1; answer(GOOD)(c); });
  }, { maxPending: 3 });
  const three = [r.resolve("h1", undefined, undefined), r.resolve("h2", undefined, undefined), r.resolve("h3", undefined, undefined)];
  await assert.rejects(r.resolve("h4", undefined, undefined), "a fourth waiting resolution is refused");
  await Promise.all(three);
  assert.equal(peak, 1);
  await r.resolve("h5", undefined, undefined); // room again
});

test("with the real resolver wired to the key, an alias that now resolves elsewhere misses and the URL's user wins", async () => {
  const { pushTargetKey } = await import("../src/bindings/push-target.js");
  const config = (host: string, user = "git") => `user ${user}\nhostname ${host}\nport 22\n`;
  const keyFor = async (text: string, url: string) => pushTargetKey([url], "/", rig(answer(text)).resolve);
  const one = await keyFor(config("git.example.test"), "work:team/app.git");
  assert.equal(one, await keyFor(config("git.example.test"), "work:team/app.git"), "stable for one answer");
  assert.notEqual(one, await keyFor(config("git.other.test"), "work:team/app.git"), "another host is another destination");
  assert.notEqual(one, await keyFor(config("git.example.test", "ci"), "work:team/app.git"), "another configured user is another destination");
  assert.equal(await keyFor(config("git.example.test", "ci"), "git@work:team/app.git"), one, "the URL's user wins over the configured one");
  await assert.rejects(keyFor("", "work:team/app.git"), () => true, "an unusable answer refuses the key");
  await assert.rejects(keyFor(config("git.example.test"), "ssh://a@b@work/app.git"), () => true, "an @ in the host is refused");
  await assert.rejects(keyFor(config("git.example.test"), "ssh://work\u0085/app.git"), () => true, "a C1 control in the host is refused");
});

test("with no way to start ssh, an ssh destination is refused and a path destination is not", async () => {
  const { pushTargetKey } = await import("../src/bindings/push-target.js");
  const { unavailableSshResolver } = await import("../src/index.js");
  await assert.rejects(pushTargetKey(["work:team/app.git"], "/", unavailableSshResolver), (e: unknown) => (e as { code?: string }).code === "E_INVALID_ARGUMENT");
  assert.equal(typeof (await pushTargetKey(["/"], "/", unavailableSshResolver)), "string");
});

test("PATH keeps absolute entries only, minus the excluded directories; with none left nothing starts", async () => {
  const abs = (p: string) => join(parse(process.cwd()).root, p);
  const bin = abs("usr-bin");
  const work = abs("work-tree");
  const path = ["", ".", "rel", "./x", bin, join(work, "bin"), work, `${work}-sibling`].join(delimiter);
  const r = rig(answer(GOOD), { path, excludeDirs: () => [work] });
  await r.resolve("alias", undefined, undefined);
  assert.equal(r.calls[0]?.env["PATH"], [bin, `${work}-sibling`].join(delimiter), "empty, relative and worktree entries are gone; a sibling with the same prefix stays");
  const none = rig(answer(GOOD), { path: [".", "", "rel"].join(delimiter) });
  await assert.rejects(none.resolve("alias", undefined, undefined));
  assert.equal(none.calls.length, 0, "no safe PATH: ssh is not started");
});
