// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A control channel that closes while an exec or a scratch step is in progress: nothing more starts, and no reply for the
// old request reaches the next control channel (which never sent it).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPtyService, type ExecFn, type ExecOutcome, type ExecRequest } from "../src/index.js";
import { FAKE_GIT, out } from "../testing/fake-exec.js";
import { channelPair, ManualClock, settle } from "../testing/helpers.js";

const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** An exec function whose `git version` waits for `versionGate`, and whose `write-tree` runs until killed. */
function gatedExec(versionGate: Promise<void>): { exec: ExecFn; log: ExecRequest[] } {
  const log: ExecRequest[] = [];
  const exec: ExecFn = (req) => {
    if (req.argv[1] === "version") return { done: versionGate.then(() => out("git version 2.53.0\n")), kill: () => undefined };
    log.push(req);
    if (req.argv.includes("--get-regexp")) return { done: Promise.resolve(out("", 1)), kill: () => undefined };
    if (req.argv.includes("write-tree")) {
      let end: (o: ExecOutcome) => void = () => undefined;
      const done = new Promise<ExecOutcome>((res) => (end = res));
      // Like a real child, the killed process reports later, after the next control channel may already be open.
      return { done, kill: () => void setImmediate(() => end({ code: null, signal: "SIGKILL", stdout: new Uint8Array(), stderr: new Uint8Array(), truncated: false })) };
    }
    return { done: Promise.resolve(out("")), kill: () => undefined };
  };
  return { exec, log };
}

function setup(t: { after(fn: () => void): void }, exec: ExecFn): { first: ReturnType<typeof channelPair>; reopen(): unknown[]; gitDir: string } {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "axis-pty-close-")));
  const gitDir = join(tmp, "repo", ".git");
  mkdirSync(join(gitDir, "objects"), { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  const service = createPtyService({ spawn: () => { throw new Error("no spawn"); }, clock: new ManualClock(), git: { exec, gitPath: FAKE_GIT, hooksOff: "/dev/null", scratchParent: tmp, baseEnv: { PATH: "/usr/bin" } } });
  t.after(() => (service.dispose(), rmSync(tmp, { recursive: true, force: true })));
  const first = channelPair();
  service.serveControl(first.b);
  return {
    first,
    gitDir,
    reopen: () => {
      const second = channelPair();
      service.serveControl(second.b);
      const got: unknown[] = [];
      second.a.onMessage((m) => void got.push(m));
      return got;
    },
  };
}

test("a close during the version read of scratch-begin starts no filter read and no ls-tree, and the next channel gets no scratch-failed", async (t) => {
  let release: () => void = () => undefined;
  const g = gatedExec(new Promise<void>((res) => (release = res)));
  const s = setup(t, g.exec);
  s.first.a.send({ t: "scratch-begin", req: "b1", attempt: "attempt-close1", gitDir: s.gitDir, worktree: join(s.gitDir, ".."), tree: TREE });
  await settle();
  s.first.a.close();
  await settle();
  const got = s.reopen();
  release();
  await settle();
  assert.deepEqual(g.log, [], "nothing started after the close");
  assert.deepEqual(got, []);
});

test("a close while the subcommand itself runs kills it, and its result never reaches the next channel", async (t) => {
  const g = gatedExec(Promise.resolve());
  const s = setup(t, g.exec);
  s.first.a.send({ t: "exec", req: "x1", argv: [FAKE_GIT, "write-tree"], cwd: "/w", env: {}, timeoutMs: 600_000, maxOutput: 4096, repo: { gitDir: s.gitDir, workTree: join(s.gitDir, "..") } });
  await settle();
  assert.ok(g.log.some((r) => r.argv.includes("write-tree")), "the subcommand is running");
  s.first.a.close();
  for (let i = 0; i < 4; i++) await Promise.resolve(); // the service sees the close; the killed child has not reported yet
  const got = s.reopen();
  await settle();
  assert.deepEqual(got, []);
});

test("a close while scratch-verify's write-tree runs sends nothing to the next channel", async (t) => {
  const g = gatedExec(Promise.resolve());
  const s = setup(t, g.exec);
  const replies: unknown[] = [];
  s.first.a.onMessage((m) => void replies.push(m));
  s.first.a.send({ t: "scratch-begin", req: "v1", attempt: "attempt-close3", gitDir: s.gitDir, worktree: join(s.gitDir, ".."), tree: TREE });
  await settle();
  assert.deepEqual(replies, [{ t: "scratch-ready", req: "v1" }]);
  s.first.a.send({ t: "scratch-verify", req: "v2", attempt: "attempt-close3" });
  await settle();
  assert.ok(g.log.some((r) => r.argv.includes("write-tree")), "verification is running write-tree");
  s.first.a.close();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  const got = s.reopen();
  await settle();
  assert.deepEqual(got, []);
});
