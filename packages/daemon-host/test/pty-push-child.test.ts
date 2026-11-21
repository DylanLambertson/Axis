// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-X1a end to end: a confirmed push to a local bare remote, with the Axis pty process as a CHILD NODE PROCESS running the real
// entry. Its git (the service's remote check before the push, every exec) goes through the production exec function
// (`createNodeExec`), not a test exec; the daemon reaches it through the pty-control slot (`createPtyControlSlot`) over a control
// channel relayed on the IPC pipe. The push itself is a terminal (the node:child_process stand-in for Code OSS's node-pty).
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import type { GitRunner } from "@axis/git-ops";
import { createPtyControlSlot, type ControlPortLike } from "../src/bindings/pty-control.js";
import { createPtyGitRunner } from "../src/bindings/pty-git.js";
import { gitRig, gitUnavailable, type GitClient, type GitRig } from "./git-rig.js";

const SKIP = process.platform === "win32" ? "POSIX process groups are needed (Windows refuses: PV-X1w)" : gitUnavailable();
const CHILD = join(dirname(fileURLToPath(import.meta.url)), "pty-entry-child.js");

function electronShaped(port: MessagePort): ControlPortLike {
  const wrapped = new Map<unknown, (data: unknown) => void>();
  return {
    on(event: "message" | "close", listener: (arg: never) => void) {
      if (event === "message") {
        const w = (data: unknown): void => (listener as (e: unknown) => void)({ data, ports: [] });
        wrapped.set(listener, w);
        return port.on("message", w);
      }
      return port.on("close", listener as () => void);
    },
    removeListener(event: "message" | "close", listener: (arg: never) => void) {
      return port.removeListener(event, (event === "message" ? wrapped.get(listener) : listener) as () => void);
    },
    postMessage: (m: unknown) => port.postMessage(m),
    close: () => port.close(),
    start: () => port.start(),
  };
}

interface ChildPty {
  readonly runner: GitRunner;
  readonly child: ChildProcess;
  readonly stderr: () => string;
  cleanup(): void;
}

/** Forks the pty entry with the hand-over names main would set, and attaches its relayed control channel to a slot. */
function childPty(gitPath: string, env: Record<string, string>, handOver = true): ChildPty {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "axis-pty-child-")));
  chmodSync(scratch, 0o700);
  mkdirSync(join(scratch, "s"), { mode: 0o700 });
  const child = fork(CHILD, [], { env: handOver ? { ...env, AXIS_PTY_GIT: gitPath, AXIS_PTY_SCRATCH: join(scratch, "s") } : env, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced" });
  let err = "";
  child.stderr?.on("data", (c: Buffer) => void (err += c.toString("utf8")));
  const { port1, port2 } = new MessageChannel();
  port2.on("message", (m: unknown) => {
    if (child.connected) child.send(m as never);
  });
  child.on("message", (m: unknown) => port2.postMessage(m));
  const slot = createPtyControlSlot();
  slot.attach(electronShaped(port1));
  return {
    runner: createPtyGitRunner(slot.port, { gitPath, platform: process.platform, hooksOffPath: "/dev/null" }),
    child,
    stderr: () => err,
    cleanup() {
      slot.dispose();
      port2.close();
      if (child.connected) child.disconnect();
      child.kill("SIGKILL");
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

async function setup(t: TestContext, handOver = true): Promise<{ r: GitRig; c: GitClient; pty: ChildPty }> {
  let pty: ChildPty | undefined;
  const r = await gitRig({
    ptyRunner: ({ home, gitPath, path }) => {
      pty = childPty(gitPath, { PATH: path, HOME: home, LANG: "C" }, handOver);
      return pty.runner;
    },
  });
  const p = pty as unknown as ChildPty;
  t.after(() => (p.cleanup(), r.cleanup()));
  return { r, c: await r.connect("user"), pty: p };
}

async function confirmedPush(r: GitRig, c: GitClient): Promise<{ tip: string; res: Awaited<ReturnType<GitClient["rpc"]>> }> {
  r.write("b.txt", "bee\n");
  r.git("add", "-A");
  r.git("commit", "-q", "--no-verify", "-m", "add b");
  const tip = r.head();
  const planned = await c.rpc("axis.git", "pushPlan", { workspaceId: r.workspaceId, remote: "origin" });
  assert.equal(planned.ok, true, JSON.stringify(planned.error));
  const p = planned.result as unknown as { tip: string; digest: string };
  assert.equal(p.tip, tip);
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
  const res = await c.rpc("axis.git", "push", { ...req, approval: { challengeId: ch.challengeId } }, key);
  return { tip, res };
}

test("a confirmed push lands through the pty process in a child node process, whose git runs through the production exec function", { skip: SKIP ?? false }, async (t) => {
  const { r, c, pty } = await setup(t);
  const { tip, res } = await confirmedPush(r, c);
  assert.equal(res.ok, true, `${JSON.stringify(res.error)}\n${pty.stderr()}`);
  assert.deepEqual(res.result, { remote: "origin", branch: "axis/feat", tip });
  assert.equal(r.remoteTip(), tip, "the planned tip is on the remote");
  assert.equal(pty.child.exitCode, null, "the pty process is still running");
  assert.equal(pty.stderr(), "", "the entry refused nothing");
});

test("control: the same pty process without the git hand-over runs no git, so the push is refused unavailable and the remote does not move", { skip: SKIP ?? false }, async (t) => {
  const { r, c, pty } = await setup(t, false);
  const before = r.remoteTip();
  const { res } = await confirmedPush(r, c);
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, "E_UNAVAILABLE", JSON.stringify(res.error));
  assert.equal(r.remoteTip(), before);
  assert.equal(pty.child.exitCode, null, "terminals stay on: the process runs");
});
