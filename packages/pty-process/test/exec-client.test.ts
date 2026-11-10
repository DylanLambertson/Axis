// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The host port's `exec` (H9-hooks §4.1): it reaches the service as a plain exec, and every call settles.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPtyProcessPort, createPtyService, PtyExecError, type ExecOutcome, type ExecRequest, type PtyExecCall } from "../src/index.js";
import { fakeExec, FAKE_GIT, out } from "../testing/fake-exec.js";
import { channelPair, ManualClock } from "../testing/helpers.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const code = (c: string) => (e: unknown): boolean => e instanceof PtyExecError && e.code === c;
const CALL: PtyExecCall = { argv: [FAKE_GIT, "write-tree"], cwd: "/w", env: { LANG: "C" }, timeoutMs: 5000, maxOutput: 4096, repo: { gitDir: "/w/.git", workTree: "/w" } };

function served(t: { after(fn: () => void): void }, answer?: (req: ExecRequest) => ExecOutcome) {
  const f = fakeExec(answer === undefined ? {} : { answer });
  const scratchParent = realpathSync(mkdtempSync(join(tmpdir(), "axis-pty-xc-")));
  const service = createPtyService({ spawn: () => { throw new Error("no spawn"); }, git: { exec: f.exec, gitPath: FAKE_GIT, hooksOff: "/dev/null", scratchParent, baseEnv: { PATH: "/usr/bin" } } });
  const pair = channelPair();
  service.serveControl(pair.b);
  const port = createPtyProcessPort({ channel: pair.a });
  t.after(() => (port.dispose(), service.dispose(), rmSync(scratchParent, { recursive: true, force: true })));
  return { f, port, pair };
}

test("exec: the call reaches the service as a plain exec with `repo`, and the result comes back", async (t) => {
  const { f, port, pair } = served(t, () => out("4b825dc642cb6eb9a060e54bf8d69288fbee4904\n"));
  const r = await port.exec({ ...CALL, stdin: "msg\n" });
  assert.deepEqual(r, { code: 0, signal: null, stdout: "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n", stderr: "", truncated: false });
  const sent = pair.sent.a.at(-1) as Record<string, unknown>;
  assert.equal(sent["t"], "exec");
  assert.deepEqual(sent["repo"], CALL.repo);
  assert.equal(sent["stdin"], "msg\n");
  assert.equal("bind" in sent, false);
  const ran = f.log.at(-1);
  assert.ok(ran?.argv.includes("--git-dir=/w/.git") && ran.argv.includes("--work-tree=/w"), "the service emitted repo as --git-dir/--work-tree");
});

test("exec: a service refusal rejects with its code only", async (t) => {
  const { port } = served(t);
  await assert.rejects(port.exec({ ...CALL, argv: [FAKE_GIT, "update-ref", "HEAD", "x"] }), code("bad_argv"));
  await assert.rejects(port.exec({ ...CALL, env: { HOME: "/x" } }), code("env_denied"));
  await assert.rejects(port.exec({ ...CALL, argv: ["/usr/bin/git", "write-tree"] }), code("bad_argv"));
});

test("exec: unanswered calls time out after their own timeout plus the grace, and leave no timer", async () => {
  const pair = channelPair(); // nothing serves pair.b
  const clock = new ManualClock();
  const seen: number[] = [];
  const port = createPtyProcessPort({ channel: pair.a, spawnTimeoutMs: 7, clock: { setTimeout: (f, ms) => (seen.push(ms), clock.setTimeout(f)), clearTimeout: (id) => clock.clearTimeout(id) } });
  const p = port.exec(CALL);
  assert.deepEqual(seen, [5007]);
  clock.fire();
  await assert.rejects(p, code("timeout"));
  assert.equal(clock.timers.size, 0);
  port.dispose();
});

test("exec: a closed channel or a disposed port rejects pending and later calls with channel_closed", async () => {
  const pair = channelPair();
  const clock = new ManualClock();
  const port = createPtyProcessPort({ channel: pair.a, clock });
  const p = port.exec(CALL);
  pair.b.close();
  await assert.rejects(p, code("channel_closed"));
  assert.equal(clock.timers.size, 0);
  await assert.rejects(port.exec(CALL), code("channel_closed"));
  const other = createPtyProcessPort({ channel: channelPair().a, clock });
  const q = other.exec(CALL);
  other.dispose();
  await assert.rejects(q, code("channel_closed"));
});

test("exec: a send that throws rejects at once; pending calls are bounded", async () => {
  const pair = channelPair();
  pair.a.close();
  const port = createPtyProcessPort({ channel: { ...pair.a, onClose: () => ({ dispose: () => undefined }) }, clock: new ManualClock() });
  await assert.rejects(port.exec(CALL), code("channel_closed"));
  const bounded = createPtyProcessPort({ channel: channelPair().a, clock: new ManualClock(), maxPending: 1 });
  const first = bounded.exec(CALL);
  await assert.rejects(bounded.exec(CALL), code("capacity"));
  bounded.dispose();
  await assert.rejects(first, code("channel_closed"));
});

test("exec: replies to unknown requests and spawn-family replies do not settle a call", async () => {
  const pair = channelPair();
  const clock = new ManualClock();
  const port = createPtyProcessPort({ channel: pair.a, clock });
  let settled = false;
  const p = port.exec(CALL).then(() => (settled = true), () => (settled = true));
  pair.b.send({ t: "exec-result", req: "x999", code: 0, signal: null, stdout: "", stderr: "", truncated: false });
  pair.b.send({ t: "spawn-failed", req: "x1", code: "capacity" });
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
  assert.equal(settled, false);
  pair.b.send({ t: "exec-failed", req: "x1", code: "capacity" });
  await p;
  assert.equal(settled, true);
  port.dispose();
});
