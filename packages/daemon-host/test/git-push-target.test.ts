// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { GitRefusal } from "../src/index.js";
import { pushTargetKey } from "../src/bindings/push-target.js";
import { gitRig, gitUnavailable, type GitClient, type GitRig, type GitRigOptions } from "./git-rig.js";

const SKIP = gitUnavailable();
const CANARY = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
type Hosts = Record<string, { hostname: string; port?: number; user?: string }>;
const resolver = (hosts: Hosts) => async (host: string) => {
  const h = hosts[host];
  if (h === undefined) throw new Error("no such alias");
  return { hostname: h.hostname, port: h.port ?? 22, ...(h.user === undefined ? {} : { user: h.user }) };
};
function scratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "axis-push-target-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const refused = (e: unknown): boolean => e instanceof GitRefusal && e.code === "E_INVALID_ARGUMENT";

test("an ssh alias is keyed by where it connects: one name resolving elsewhere misses, two names for one host share", async (t) => {
  const wt = scratch(t);
  const one = await pushTargetKey(["work:team/app.git"], wt, resolver({ work: { hostname: "git.example.test" } }));
  const moved = await pushTargetKey(["work:team/app.git"], wt, resolver({ work: { hostname: "git.other.test" } }));
  assert.notEqual(one, moved, "an alias edited to another host is another destination");
  const alias = await pushTargetKey(["ssh://second/team/app.git"], wt, resolver({ second: { hostname: "GIT.example.test" } }));
  const scp = await pushTargetKey(["second:/team/app.git"], wt, resolver({ second: { hostname: "git.example.test" } }));
  assert.equal(alias, scp, "scp-like and ssh:// forms of the same host and path share, case aside");
  const port = await pushTargetKey(["work:team/app.git"], wt, resolver({ work: { hostname: "git.example.test", port: 2222 } }));
  assert.notEqual(one, port, "the port is part of the destination");
  const user = await pushTargetKey(["work:team/app.git"], wt, resolver({ work: { hostname: "git.example.test", user: "ci" } }));
  assert.notEqual(one, user, "the user is part of the destination");
  const path = await pushTargetKey(["work:team/other.git"], wt, resolver({ work: { hostname: "git.example.test" } }));
  assert.notEqual(one, path, "the path is part of the destination");
});

test("an ssh alias that cannot be resolved, or resolves to nothing usable, refuses (fail closed)", async (t) => {
  const wt = scratch(t);
  await assert.rejects(pushTargetKey(["nope:app.git"], wt, resolver({})), refused);
  const bad = (answer: unknown) => pushTargetKey(["hh:app.git"], wt, (async () => answer) as never);
  await assert.rejects(bad(undefined), refused);
  await assert.rejects(bad({ hostname: "", port: 22 }), refused);
  await assert.rejects(bad({ hostname: "a b", port: 22 }), refused);
  await assert.rejects(bad({ hostname: "h", port: 0 }), refused);
  await assert.rejects(bad({ hostname: "h", port: 70000 }), refused);
  await assert.rejects(bad({ hostname: "h", port: 22, user: "a\nb" }), refused);
  assert.equal(typeof (await bad({ hostname: "good.example.test", port: 22 })), "string", "a good answer is accepted");
  await assert.rejects(bad({ hostname: "h", port: 22.5 }), refused);
  await assert.rejects(bad({ hostname: "h", port: "22" }), refused);
  await assert.rejects(bad(null), refused);
  // No resolver: keyed as written, and a different name is a different destination.
  assert.notEqual(await pushTargetKey(["aa:app.git"], wt), await pushTargetKey(["bb:app.git"], wt));
});

test("the URL's user and port win over the resolver's, a password never reaches it, and an option-like host is refused first", async (t) => {
  const wt = scratch(t);
  const seen: Array<[string, string | undefined]> = [];
  const spy = async (host: string, user: string | undefined) => (seen.push([host, user]), { hostname: "git.example.test", port: 22, user: "cfg" });
  const alice = await pushTargetKey(["alice@al:x.git"], wt, spy);
  const carol = await pushTargetKey(["carol@al:x.git"], wt, spy);
  assert.notEqual(alice, carol, "two URL users are two destinations whatever the configuration says");
  const viaPort = await pushTargetKey(["ssh://al:2200/x.git"], wt, spy);
  assert.notEqual(viaPort, await pushTargetKey(["ssh://al/x.git"], wt, spy), "the URL's port is kept");
  await pushTargetKey(["ssh://u:pw0rd@al/x.git"], wt, spy);
  assert.deepEqual(seen.at(-1), ["al", "u"]);
  assert.equal(await pushTargetKey(["ssh://u:pw0rd@al/x.git"], wt, spy), await pushTargetKey(["ssh://u@al/x.git"], wt, spy));
  const calls = seen.length;
  for (const bad of ["ssh://-oProxyCommand=x/p", "-oXx:p", "ssh://al:99999/x"]) {
    await assert.rejects(pushTargetKey([bad], wt, spy), refused, bad);
  }
  assert.equal(seen.length, calls, "the resolver saw none of them");
  assert.ok((await pushTargetKey(["ssh://[::1]:2200/p"], wt, spy)).length > 0, "an ipv6 host with a port parses");
  await assert.rejects(pushTargetKey(["file:///%zz"], wt), refused);
});

test("a path remote is keyed by its real directory: a symlink and a relative form share, another directory or a missing one does not", async (t) => {
  const dir = scratch(t);
  const a = join(dir, "a");
  const b = join(dir, "b");
  mkdirSync(a);
  mkdirSync(b);
  const link = join(dir, "link");
  try {
    symlinkSync(a, link, "dir");
  } catch {
    t.skip("symlinks are not available");
    return;
  }
  const ka = await pushTargetKey([a], dir);
  assert.equal(await pushTargetKey([link], dir), ka);
  assert.equal(await pushTargetKey(["./a"], dir), ka);
  assert.equal(await pushTargetKey([`file://${a}`], dir), ka);
  assert.notEqual(await pushTargetKey([b], dir), ka);
  // The same name now pointing at another directory is another destination.
  const swap = join(dir, "swap");
  symlinkSync(a, swap, "dir");
  const before = await pushTargetKey([swap], dir);
  rmSync(swap);
  symlinkSync(b, swap, "dir");
  assert.notEqual(await pushTargetKey([swap], dir), before);
  await assert.rejects(pushTargetKey([join(dir, "missing")], dir), refused);
  // Several push URLs: order does not matter, one unresolvable fails the lot.
  assert.equal(await pushTargetKey([a, b], dir), await pushTargetKey([b, a], dir));
  await assert.rejects(pushTargetKey([a, join(dir, "missing")], dir), refused);
});

test("https and other URL forms are keyed as written", async (t) => {
  const wt = scratch(t);
  assert.equal(await pushTargetKey(["https://h.example.test/x.git"], wt), await pushTargetKey(["https://h.example.test/x.git"], wt));
  assert.notEqual(await pushTargetKey(["https://h.example.test/x.git"], wt), await pushTargetKey(["https://h.example.test/y.git"], wt));
});

async function setup(t: TestContext, options: GitRigOptions = {}): Promise<{ r: GitRig; c: GitClient }> {
  const r = await gitRig(options);
  t.after(() => r.cleanup());
  return { r, c: await r.connect("user") };
}
type Plan = { tip: string; digest: string; requiresConfirmation: boolean };

test("end to end: an ssh alias that cannot be resolved refuses the plan before any scan", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t, { scanMode: "warn", resolveSshHost: resolver({}) });
  r.write("cfg.txt", `aws_id = ${CANARY}\n`);
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "add cfg");
  const ok = await c.rpc("axis.git", "pushPlan", { workspaceId: r.workspaceId, remote: "origin" });
  assert.equal((ok.result as unknown as Plan).requiresConfirmation, true);
  r.git("remote", "add", "lost", "lostalias:team/app.git");
  const res = await c.rpc("axis.git", "pushPlan", { workspaceId: r.workspaceId, remote: "lost" });
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, "E_INVALID_ARGUMENT");
  assert.equal(r.calls.planPush.length, 1, "no scan ran for a destination that could not be named");
});
