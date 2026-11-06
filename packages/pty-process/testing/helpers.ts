// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { spawn as nodeSpawn } from "node:child_process";
import type { Channel, Clock, Disposable, ProcessOps, PtyChild, PtyExit, SpawnFn, SpawnRequest } from "../src/index.js";

/** TEST ONLY. A pair of connected channels that deliver in a later microtask, like a MessagePort. */
export interface ChannelPair {
  readonly a: Channel;
  readonly b: Channel;
  /** Everything each side sent, in order. */
  readonly sent: { readonly a: unknown[]; readonly b: unknown[] };
}

class End {
  peer: End | undefined;
  open = true;
  readonly ml = new Set<(m: unknown) => void>();
  readonly cl = new Set<() => void>();
  constructor(readonly log: unknown[]) {}
  readonly channel: Channel = {
    send: (m) => {
      if (!this.open) throw new Error("closed");
      this.log.push(m);
      queueMicrotask(() => this.peer?.receive(m));
    },
    onMessage: (l) => (this.ml.add(l), { dispose: () => void this.ml.delete(l) }),
    onClose: (l) => (this.cl.add(l), { dispose: () => void this.cl.delete(l) }),
    close: () => {
      this.shut();
      queueMicrotask(() => this.peer?.shut());
    },
  };
  receive(m: unknown): void {
    if (this.open) for (const l of [...this.ml]) l(m);
  }
  shut(): void {
    if (!this.open) return;
    this.open = false;
    for (const l of [...this.cl]) l();
  }
}

export function channelPair(): ChannelPair {
  const sent = { a: [] as unknown[], b: [] as unknown[] };
  const x = new End(sent.a);
  const y = new End(sent.b);
  x.peer = y;
  y.peer = x;
  return { a: x.channel, b: y.channel, sent };
}

/** Lets queued microtasks and I/O callbacks run; it measures no time. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Polls a condition by yielding to the event loop, bounded by iterations rather than by a clock. */
export async function until(cond: () => boolean, iterations = 50_000): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    if (cond()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error("condition never became true");
}

export class ManualClock implements Clock {
  private next = 1;
  readonly timers = new Map<number, () => void>();
  setTimeout(fn: () => void): unknown {
    const id = this.next++;
    this.timers.set(id, fn);
    return id;
  }
  clearTimeout(id: unknown): void {
    this.timers.delete(id as number);
  }
  /** Fires every pending timer once. */
  fire(): void {
    for (const [id, fn] of [...this.timers]) {
      this.timers.delete(id);
      fn();
    }
  }
}

/** A scripted `process.kill`: groups by pgid, with the errno codes Node reports. */
export class FakeProcs implements ProcessOps {
  readonly live = new Set<number>();
  readonly calls: Array<[number, number | string]> = [];
  /** Groups that ignore SIGKILL and SIGTERM (a stand-in for a group that cannot be ended right now). */
  readonly unkillable = new Set<number>();
  failWith: string | undefined;
  signal(pid: number, signal: number | NodeJS.Signals): void {
    this.calls.push([pid, signal]);
    if (this.failWith !== undefined) throw Object.assign(new Error("boom"), { code: this.failWith });
    if (pid >= 0) throw Object.assign(new Error("not a group"), { code: "EINVAL" });
    const pgid = -pid;
    if (!this.live.has(pgid)) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    if ((signal === "SIGKILL" || signal === "SIGTERM") && !this.unkillable.has(pgid)) this.live.delete(pgid);
  }
}

export class FakeChild implements PtyChild {
  readonly written: string[] = [];
  readonly killed: string[] = [];
  readonly resized: Array<[number, number]> = [];
  pending = 0;
  pauses = 0;
  resumes = 0;
  private readonly dl = new Set<(c: string) => void>();
  private readonly el = new Set<(e: PtyExit) => void>();
  private readonly gl = new Set<() => void>();
  constructor(readonly pid: number, readonly group: PtyChild["group"] = { kind: "pgid", pgid: pid }) {}
  write(d: string): void { this.written.push(d); }
  resize(c: number, r: number): void { this.resized.push([c, r]); }
  kill(s: string): void { this.killed.push(s); }
  pendingWrite(): number { return this.pending; }
  pause(): void { this.pauses++; }
  resume(): void { this.resumes++; }
  onData(l: (c: string) => void): Disposable { this.dl.add(l); return { dispose: () => void this.dl.delete(l) }; }
  onExit(l: (e: PtyExit) => void): Disposable { this.el.add(l); return { dispose: () => void this.el.delete(l) }; }
  onGroupEmpty(l: () => void): Disposable { this.gl.add(l); return { dispose: () => void this.gl.delete(l) }; }
  emit(chunk: string): void { this.dl.forEach((l) => l(chunk)); }
  exit(e: PtyExit = { exitCode: 0, signal: null }): void { this.el.forEach((l) => l(e)); }
  groupEmpty(): void { this.gl.forEach((l) => l()); }
}

/** A deterministic id source. */
export function counterRandom(): (n: number) => Uint8Array {
  let c = 0;
  return (n) => Uint8Array.from({ length: n }, (_, i) => (i === n - 1 ? ++c : 0));
}

/**
 * TEST ONLY, POSIX: a `SpawnFn` over `node:child_process` with pipes instead of a pty. The child leads a NEW session
 * (`detached`), so its pgid equals its pid, and it inherits only stdio 0, 1 and 2. It is the reference for the fd and
 * group-kill conformance tests; the shipped entry's native binding must pass the same tests. `children` records every pid.
 */
export function pipeSpawn(children: number[] = []): SpawnFn {
  return (req: SpawnRequest): PtyChild => {
    const cp = nodeSpawn(req.argv[0] as string, req.argv.slice(1), { cwd: req.cwd, env: { ...req.env }, detached: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    if (cp.pid === undefined) throw new Error("spawn failed");
    children.push(cp.pid);
    const dl = new Set<(c: string) => void>();
    const el = new Set<(e: PtyExit) => void>();
    cp.stdout.setEncoding("utf8");
    cp.stdout.on("data", (c: string) => dl.forEach((l) => l(c)));
    cp.stderr.setEncoding("utf8");
    cp.stderr.on("data", (c: string) => dl.forEach((l) => l(c)));
    cp.stdin.on("error", () => undefined);
    cp.on("error", () => undefined);
    cp.once("exit", (exitCode, signal) => el.forEach((l) => l({ exitCode, signal })));
    return {
      pid: cp.pid,
      group: { kind: "pgid", pgid: cp.pid },
      write: (d) => void cp.stdin.write(d),
      pendingWrite: () => cp.stdin.writableLength,
      resize: () => undefined,
      kill: (s) => void cp.kill(s),
      onData: (l) => (dl.add(l), { dispose: () => void dl.delete(l) }),
      onExit: (l) => (el.add(l), { dispose: () => void el.delete(l) }),
    };
  };
}
