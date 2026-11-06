// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { constants } from "node:os";
import { test } from "node:test";
import { createNodePtySpawn, signalName, type NodePtyLike, type NodePtySpawn, type NodePtySpawnOptions } from "../src/index.js";

class FakePty implements NodePtyLike {
  readonly calls: string[] = [];
  readonly _writeStream: { _writeQueue: Array<{ buffer: { byteLength: number }; offset: number }> } = { _writeQueue: [] };
  private dl: Array<(d: string) => void> = [];
  private el: Array<(e: { exitCode: number; signal?: number | undefined }) => void> = [];
  constructor(readonly pid: number) {}
  onData = (l: (d: string) => void) => (this.dl.push(l), { dispose: () => void this.calls.push("dispose-data") });
  onExit = (l: (e: { exitCode: number; signal?: number | undefined }) => void) => (this.el.push(l), { dispose: () => undefined });
  write(d: string): void { this.calls.push(`write:${d}`); }
  resize(c: number, r: number): void { this.calls.push(`resize:${c}x${r}`); }
  kill(s?: string): void { this.calls.push(`kill:${s}`); }
  pause(): void { this.calls.push("pause"); }
  resume(): void { this.calls.push("resume"); }
  emit(d: string): void { this.dl.forEach((l) => l(d)); }
  exit(e: { exitCode: number; signal?: number | undefined }): void { this.el.forEach((l) => l(e)); }
}

const REQ = { argv: ["/bin/sh", "-c", "x"], cwd: "/work", env: { PATH: "/usr/bin", SSH_AUTH_SOCK: "/run/a" }, cols: 90, rows: 30 };

function rig(): { pty: FakePty; seen: Array<{ file: string; args: string[]; options: NodePtySpawnOptions }>; spawn: ReturnType<typeof createNodePtySpawn> } {
  const pty = new FakePty(4242);
  const seen: Array<{ file: string; args: string[]; options: NodePtySpawnOptions }> = [];
  const fake: NodePtySpawn = (file, args, options) => (seen.push({ file, args, options }), pty);
  return { pty, seen, spawn: createNodePtySpawn(fake, "linux") };
}

test("node-pty is called directly with argv split, the environment as given, utf8 and flow control OFF", () => {
  const { seen, spawn } = rig();
  spawn(REQ);
  const s = seen[0]!;
  assert.equal(s.file, "/bin/sh");
  assert.deepEqual(s.args, ["-c", "x"]);
  assert.deepEqual(s.options.env, REQ.env);
  assert.notEqual(s.options.env, REQ.env, "a copy: node-pty's own PWD/TERM additions never write into the request");
  assert.equal(s.options.handleFlowControl, false, "XOFF typed by the user must not pause the child");
  assert.equal(s.options.encoding, "utf8");
  assert.equal(s.options.name, "xterm-256color");
  assert.deepEqual([s.options.cols, s.options.rows, s.options.cwd], [90, 30, "/work"]);
});

test("an environment TERM is the pty name", () => {
  const { seen, spawn } = rig();
  spawn({ ...REQ, env: { ...REQ.env, TERM: "vt100" } });
  assert.equal(seen[0]?.options.name, "vt100");
});

test("the child leads its own group: pgid equals pid; pause, resume, write, resize, kill reach the pty", () => {
  const { pty, spawn } = rig();
  const c = spawn(REQ);
  assert.deepEqual(c.group, { kind: "pgid", pgid: 4242 });
  assert.equal(c.pid, 4242);
  c.write("a");
  c.resize(100, 40);
  c.kill("SIGKILL");
  c.pause?.();
  c.resume?.();
  assert.deepEqual(pty.calls, ["write:a", "resize:100x40", "kill:SIGKILL", "pause", "resume"]);
});

test("data and exit are forwarded; an exit signal number becomes its name, none stays null", () => {
  const { pty, spawn } = rig();
  const c = spawn(REQ);
  const data: string[] = [];
  const exits: unknown[] = [];
  c.onData((d) => void data.push(d));
  c.onExit((e) => void exits.push(e));
  pty.emit("hi");
  pty.exit({ exitCode: 0 });
  pty.exit({ exitCode: 0, signal: 0 });
  pty.exit({ exitCode: 1, signal: constants.signals.SIGKILL });
  assert.deepEqual(data, ["hi"]);
  assert.deepEqual(exits, [
    { exitCode: 0, signal: null },
    { exitCode: 0, signal: null },
    { exitCode: 1, signal: "SIGKILL" },
  ]);
  assert.equal(signalName(9999), "SIG9999");
});

test("Windows has no job object through ConPTY: the spawn throws and node-pty is never called", () => {
  const seen: unknown[] = [];
  const spawn = createNodePtySpawn(() => (seen.push(1), new FakePty(1)), "win32");
  assert.throws(() => spawn(REQ));
  assert.deepEqual(seen, []);
});

test("PTY-4: pendingWrite is the unwritten bytes of node-pty's own write queue, and a queue of another shape is Infinity", () => {
  const { pty, spawn } = rig();
  const c = spawn(REQ);
  assert.equal(c.pendingWrite?.(), 0);
  pty._writeStream._writeQueue.push({ buffer: { byteLength: 100 }, offset: 30 }, { buffer: { byteLength: 50 }, offset: 0 });
  assert.equal(c.pendingWrite?.(), 120);
  pty._writeStream._writeQueue.push({ buffer: {} as never, offset: 0 });
  assert.equal(c.pendingWrite?.(), Number.POSITIVE_INFINITY);
  (pty as unknown as { _writeStream: unknown })._writeStream = undefined;
  assert.equal(c.pendingWrite?.(), Number.POSITIVE_INFINITY, "a node-pty that drops the queue is treated as full, not empty");
});

test("PTY-4: a node-pty whose input queue cannot be measured is killed and the spawn fails (nothing runs unbounded)", () => {
  const pty = new FakePty(7);
  (pty as unknown as { _writeStream: unknown })._writeStream = undefined;
  const spawn = createNodePtySpawn(() => pty, "linux");
  assert.throws(() => spawn(REQ));
  assert.deepEqual(pty.calls, ["kill:SIGKILL"]);
});
