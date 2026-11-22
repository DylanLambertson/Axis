// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-D2 slice 2: the host port's `forgeList`. The request is checked by the shared schema before it is sent and carries exactly
// its five fields; the reply is checked by the shared reply schema; every call settles (reply, send failure, close, dispose,
// its own bound); a forge reply never reaches the exec calls and an exec reply never settles a forge call.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPtyProcessPort, FORGE_CALL_TIMEOUT_MS, PtyForgeError, type Channel } from "../src/index.js";
import { forgeReq, forgeRig } from "../testing/forge.js";
import { channelPair, ManualClock } from "../testing/helpers.js";

const SKIP = process.platform === "win32" ? "POSIX shebang scripts" : false;
const code = (c: string) => (e: unknown): boolean => e instanceof PtyForgeError && e.code === c;
const REQ = { t: "forge-list" as const, req: "f-1", host: "github.com" as const, owner: "acme", repo: "app" };

function unserved(opts: { maxPending?: number; send?: Channel["send"] } = {}) {
  const pair = channelPair();
  const clock = new ManualClock();
  const bounds: number[] = [];
  const channel: Channel = opts.send === undefined ? pair.a : { ...pair.a, send: opts.send };
  const port = createPtyProcessPort({
    channel,
    clock: { setTimeout: (f, ms) => (bounds.push(ms), clock.setTimeout(f)), clearTimeout: (id) => clock.clearTimeout(id) },
    ...(opts.maxPending === undefined ? {} : { maxPending: opts.maxPending }),
  });
  const reply = (m: unknown): void => pair.b.send(m);
  return { pair, clock, bounds, port, reply };
}
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

test("forgeList reaches the real service's forge path and the parsed reply comes back", { skip: SKIP }, async () => {
  const r = forgeRig({ list: 'process.stdout.write("[]");' });
  const port = createPtyProcessPort({ channel: r.pair.a });
  try {
    const req = forgeReq() as typeof REQ;
    assert.deepEqual(await port.forgeList(req), { t: "forge-result", req: req.req, exit: 0, class: "none", stdout: "[]", truncated: false });
  } finally {
    port.dispose();
    r.cleanup();
  }
});

test("the request is checked before it leaves and carries exactly the five schema fields", async () => {
  const { pair, port } = unserved();
  for (const bad of [{ ...REQ, owner: "--upload-pack" }, { ...REQ, repo: ".." }, { ...REQ, host: "gitlab.com" }, { ...REQ, req: "r 1" }, { ...REQ, argv: ["x"] }]) {
    await assert.rejects(port.forgeList(bad as typeof REQ), code("bad_request"), JSON.stringify(bad));
  }
  const hostile = new Proxy(REQ, { get: () => { throw new Error("trap"); } });
  await assert.rejects(port.forgeList(hostile), code("bad_request"));
  assert.equal(pair.sent.a.length, 0, "nothing was sent");
  const pending = port.forgeList({ ...REQ });
  assert.deepEqual(pair.sent.a, [REQ]);
  assert.deepEqual(Object.keys(pair.sent.a[0] as object).sort(), ["host", "owner", "repo", "req", "t"]);
  await assert.rejects(port.forgeList({ ...REQ }), code("bad_request"), "an id already waiting is refused");
  assert.equal(pair.sent.a.length, 1);
  port.dispose();
  await assert.rejects(pending, code("channel_closed"));
});

test("a value that changes after it was checked: what is sent is what was checked, never a second read", async () => {
  const { pair, port } = unserved();
  let reads = 0;
  const shifty = { ...REQ };
  Object.defineProperty(shifty, "owner", { enumerable: true, get: () => (++reads === 1 ? "acme" : "--upload-pack=evil") });
  const p = port.forgeList(shifty);
  assert.deepEqual(pair.sent.a, [REQ]);
  port.dispose();
  await assert.rejects(p, code("channel_closed"));
});

test("replies: parsed by the shared schema; a malformed reply to a pending call is undefined; others are dropped", async () => {
  const { port, reply } = unserved();
  const ok = port.forgeList({ ...REQ, req: "a" });
  reply({ t: "forge-result", req: "a", exit: 1, class: "auth_missing", stdout: "", truncated: false });
  assert.deepEqual(await ok, { t: "forge-result", req: "a", exit: 1, class: "auth_missing", stdout: "", truncated: false });
  const failed = port.forgeList({ ...REQ, req: "b" });
  reply({ t: "forge-failed", req: "b", code: "too_old" });
  assert.deepEqual(await failed, { t: "forge-failed", req: "b", code: "too_old" });
  for (const bad of [
    { t: "forge-result", req: "c", exit: 0, class: "none", stdout: "[]", truncated: false, stderr: "HTTP 401 secret" },
    { t: "forge-result", req: "c", exit: 0, class: "stderr text", stdout: "[]", truncated: false },
    { t: "forge-failed", req: "c", code: "ENOENT" },
  ]) {
    const p = port.forgeList({ ...REQ, req: "c" });
    reply(bad);
    assert.equal(await p, undefined, JSON.stringify(bad));
  }
  // A reply for nobody, or a second reply for a settled call, changes nothing; the next call is answered by its own reply.
  reply({ t: "forge-failed", req: "zzz", code: "timeout" });
  const d = port.forgeList({ ...REQ, req: "d" });
  reply({ t: "forge-failed", req: "a", code: "timeout" });
  reply({ t: "forge-failed", req: "d", code: "capacity" });
  assert.deepEqual(await d, { t: "forge-failed", req: "d", code: "capacity" });
  port.dispose();
});

test("a forge reply never settles an exec call, and an exec reply never settles a forge call", async () => {
  const { port, reply, pair } = unserved();
  const call = port.exec({ argv: ["/g", "write-tree"], cwd: "/w", env: {}, timeoutMs: 10, maxOutput: 10, repo: { gitDir: "/w/.git", workTree: "/w" } });
  const execReq = (pair.sent.a[0] as { req: string }).req;
  const forge = port.forgeList({ ...REQ, req: execReq });
  reply({ t: "exec-failed", req: execReq, code: "bad_argv" });
  await assert.rejects(call, (e: unknown) => (e as { code?: unknown }).code === "bad_argv");
  let settled = false;
  void forge.then(() => (settled = true), () => (settled = true));
  await flush();
  assert.equal(settled, false, "the exec reply did not settle the forge call of the same id");
  reply({ t: "forge-failed", req: execReq, code: "timeout" });
  assert.deepEqual(await forge, { t: "forge-failed", req: execReq, code: "timeout" });
  port.dispose();
});

test("every call settles: its own bound, a send failure, capacity, a close, a dispose; no timer is left", async () => {
  {
    const { port, clock, bounds } = unserved();
    const p = port.forgeList({ ...REQ });
    assert.deepEqual(bounds, [FORGE_CALL_TIMEOUT_MS]);
    assert.ok(FORGE_CALL_TIMEOUT_MS > 25_000, "longer than the service's own version step and list call");
    clock.fire();
    await assert.rejects(p, code("timeout"));
    assert.equal(clock.timers.size, 0);
    port.dispose();
  }
  {
    const { port, clock } = unserved({ send: () => { throw new Error("gone"); } });
    await assert.rejects(port.forgeList({ ...REQ }), code("channel_closed"));
    assert.equal(clock.timers.size, 0);
    port.dispose();
  }
  {
    const { port } = unserved({ maxPending: 1 });
    const first = port.forgeList({ ...REQ, req: "one" });
    await assert.rejects(port.forgeList({ ...REQ, req: "two" }), code("capacity"));
    port.dispose();
    await assert.rejects(first, code("channel_closed"));
    await assert.rejects(port.forgeList({ ...REQ, req: "three" }), code("channel_closed"));
  }
  {
    const { port, pair, clock } = unserved();
    const p = port.forgeList({ ...REQ });
    pair.b.close();
    await assert.rejects(p, code("channel_closed"));
    assert.equal(clock.timers.size, 0);
    await assert.rejects(port.forgeList({ ...REQ, req: "later" }), code("channel_closed"));
    port.dispose();
  }
});
