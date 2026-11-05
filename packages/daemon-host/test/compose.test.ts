// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { AxisError } from "@axis/audit";
import type { GitRunner } from "@axis/git-ops";
import {
  composeDaemonHost,
  createActiveRunForwarder,
  createHandlerRegistrar,
  createProjectsListHandler,
  exitCodeForStartupError,
  EXIT,
  daemonAuditSink,
  handleProjectsRegister,
  projectDisplayName,
  recordingRegistrar,
  type ComposeOptions,
  type PtyPort,
} from "../src/index.js";
import { hostFixture } from "../testing/host-fixture.js";

const pty: PtyPort = { spawn: () => Promise.reject(new Error("unused")) };
const runner: GitRunner = { run: () => Promise.reject(new Error("unused")) };
const snapshotter: NonNullable<ComposeOptions["snapshotter"]> = { before: () => Promise.resolve(), after: () => Promise.resolve({ drift: false }) };

function options(fix: ReturnType<typeof hostFixture>, over: Partial<ComposeOptions> = {}): ComposeOptions {
  const { control: _control, ...ports } = fix.ports as typeof fix.ports & { control: unknown };
  return { config: fix.config, control: fix.client, ports, pty, ptyGitRunner: runner, snapshotter, process, exit: () => undefined, ...over };
}

const reasonOf = (e: unknown): unknown => (e instanceof AxisError ? [e.code, e.detail["reason"]] : e);

test("the composition refuses to be built without the pty port, the pty git runner or a snapshotter, before it touches storage", () => {
  const fix = hostFixture();
  try {
    for (const [over, reason] of [
      [{ pty: undefined }, "pty_required"],
      [{ pty: {} as PtyPort }, "pty_required"],
      [{ ptyGitRunner: undefined }, "pty_git_runner_required"],
      [{ ptyGitRunner: {} as GitRunner }, "pty_git_runner_required"],
      [{ snapshotter: undefined }, "snapshotter_required"],
    ] as const) {
      assert.throws(() => composeDaemonHost(options(fix, over)), (e: unknown) => JSON.stringify(reasonOf(e)) === JSON.stringify(["E_INVALID_ARGUMENT", reason]), reason);
    }
    assert.equal(existsSync(fix.dataDir), false, "no lock, directory or database was created");
  } finally {
    fix.cleanup();
  }
});

test("a refused composition is exit code 78 (a bad configuration), not an internal failure", () => {
  assert.equal(exitCodeForStartupError(new AxisError("E_INVALID_ARGUMENT", "x", { reason: "pty_required" })), EXIT.BAD_CONFIG);
});

test("the run forwarder answers active until the runs service is bound, never false, and fails closed afterwards", () => {
  const f = createActiveRunForwarder();
  assert.equal(f.hasActiveRun("any"), true, "before the runs binding exists a run may be active");
  f.bind({ hasActiveRun: (id) => id === "busy" });
  assert.deepEqual([f.hasActiveRun("busy"), f.hasActiveRun("idle")], [true, false], "then it is the real answer");
  assert.throws(() => f.bind({ hasActiveRun: () => false }), { code: "E_CONFLICT" }, "the binding cannot be swapped for one that says no");
  const broken = createActiveRunForwarder();
  broken.bind({ hasActiveRun: () => { throw new Error("down"); } });
  assert.equal(broken.hasActiveRun("x"), true, "a service that cannot answer counts as active");
  const odd = createActiveRunForwarder();
  odd.bind({ hasActiveRun: () => undefined as unknown as boolean });
  assert.equal(odd.hasActiveRun("x"), true, "an answer that is not the boolean false is not a no");
});

test("the recording registrar passes every registration on and lists the methods handed to it", () => {
  const seen: string[] = [];
  const inner = createHandlerRegistrar({ register: (c, v, h) => void seen.push(`${c}/${v}:${Object.keys(h).join(",")}`) }, { check: () => undefined });
  const { registrar, methods } = recordingRegistrar(inner);
  registrar.register("axis.audit", 1, { status: () => ({}) });
  assert.deepEqual([...methods()], ["axis.audit/1.status"]);
  assert.deepEqual(seen, ["axis.audit/1:status"]);
  assert.ok(Object.isFrozen(registrar), "handler code cannot replace `register`");
});

test("the daemon audit sink writes and tells the anchor manager; without a writer it accepts and drops (degraded)", async () => {
  const written: unknown[] = [];
  let noted = 0;
  const event = { actor: "user", action: "rpc.execute", target: "t", outcome: "success", payload: {} } as const;
  await daemonAuditSink({ append: (e: unknown) => void written.push(e) } as never, () => void noted++).append(event);
  assert.deepEqual([written.length, noted], [1, 1]);
  assert.doesNotThrow(() => void daemonAuditSink(undefined, () => assert.fail("no write, no note")).append(event));
  const failing = daemonAuditSink({ append: () => { throw new Error("disk"); } } as never, () => void noted++);
  assert.throws(() => failing.append(event), "a write that fails fails the request closed");
  assert.equal(noted, 1, "and is not counted as a write");
});

test("projects.register answers the project id or a closed code, and never what the journal said", () => {
  const sent: Array<Record<string, unknown>> = [];
  const control = { send: (m: unknown) => void sent.push(m as Record<string, unknown>) };
  const journal = { registerProject: (i: { id: string; path: string; displayName: string }) => ({ id: i.id }) } as never;
  const msg = (path: string) => ({ type: "projects.register" as const, requestId: "r1", path, trusted: true });
  const abs = process.platform === "win32" ? "C:\\repos\\axis" : "/repos/axis";
  handleProjectsRegister({ journal, control }, msg(abs));
  assert.deepEqual([sent[0]?.["ok"], typeof sent[0]?.["projectId"]], [true, "string"]);
  handleProjectsRegister({ journal: undefined, control }, msg(abs));
  assert.deepEqual(sent[1], { type: "projects.result", requestId: "r1", ok: false, code: "E_UNAVAILABLE" });
  handleProjectsRegister({ journal, control }, msg(`${abs}${process.platform === "win32" ? "\\" : "/"}..${process.platform === "win32" ? "\\" : "/"}x`));
  assert.equal(sent[2]?.["code"], "E_INVALID_ARGUMENT", "a path that is not normalised is refused");
  for (const [thrown, code] of [[new AxisError("E_CONFLICT", "secret path /home/x"), "E_CONFLICT"], [new Error("boom /home/x"), "E_INTERNAL"]] as const) {
    handleProjectsRegister({ journal: { registerProject: () => { throw thrown; } } as never, control }, msg(abs));
    assert.deepEqual(sent[sent.length - 1], { type: "projects.result", requestId: "r1", ok: false, code });
  }
  assert.ok(!JSON.stringify(sent).includes("/home/x"), "no message text is forwarded");
});

test("a project display name comes from the folder name, or a fixed word when that is not plain text", () => {
  assert.equal(projectDisplayName("/work/my-repo"), "my-repo");
  assert.equal(projectDisplayName("/work/\u202eevil"), "project");
});

test("axis.projects/1.list answers ids, names and trust only, and only to the user", () => {
  const handler = createProjectsListHandler({ projects: () => [{ id: "p-1", displayName: "Repo", trusted: true }] });
  const ctx = (actor: string) => ({ identity: { actor }, signal: new AbortController().signal }) as never;
  assert.deepEqual(handler(ctx("user"), undefined as never), { projects: [{ id: "p-1", name: "Repo", trusted: true }] });
  assert.throws(() => handler(ctx("agent:x"), undefined as never), { code: "E_NOT_FOUND" });
  const bad = createProjectsListHandler({ projects: () => [{ id: "p-1", displayName: "", trusted: true }] });
  assert.throws(() => bad(ctx("user"), undefined as never), { code: "E_INTERNAL" }, "a reply that breaks the contract is not sent");
});
