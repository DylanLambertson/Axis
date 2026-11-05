// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AuditLog, Redactor, openDatabase, type AuditActor } from "@axis/audit";
import { Journal } from "@axis/journal";
import { RUN_AUDIT_ALLOWLIST } from "../src/audit.js";
import { attestTrust } from "../src/daemon-attestation.js";
import type { TrustAttestation } from "../src/attestation.js";
import type { Clock, Disposable, PtyExit, PtyHandle, PtyPort, PtySignal, PtySpawn, RunSnapshotter, RunWorktree, SnapshotContext, WorktreeLocator } from "../src/ports.js";
import { RunSupervisor } from "../src/supervisor.js";
import type { RunLimits } from "../src/limits.js";

export class FakeClock implements Clock {
  t = 1_700_000_000_000;
  #next = 1;
  readonly timers = new Map<number, { at: number; fn: () => void }>();
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): number {
    const id = this.#next++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(id: unknown): void {
    this.timers.delete(id as number);
  }
  get pending(): number {
    return this.timers.size;
  }
  /** Move time forward, running every timer that falls due (including ones scheduled meanwhile). */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = Math.max(this.t, due[1].at);
      due[1].fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

export async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
}

type Listener<T> = (v: T) => void;

export class FakeHandle implements PtyHandle {
  readonly kills: PtySignal[] = [];
  readonly resized: Array<[number, number]> = [];
  readonly dataAll: Array<Listener<string>> = [];
  readonly exitAll: Array<Listener<PtyExit>> = [];
  readonly dataLive = new Set<Listener<string>>();
  readonly exitLive = new Set<Listener<PtyExit>>();
  exitOn: PtySignal | undefined;
  throwOnKill = false;
  throwOnSubscribe: "exit" | "data" | undefined;
  exitDuringSubscribe: PtyExit | undefined;
  write(): void {}
  resize(c: number, r: number): void {
    this.resized.push([c, r]);
  }
  kill(sig: PtySignal): void {
    this.kills.push(sig);
    if (this.throwOnKill) throw new Error("kill failed");
    if (this.exitOn === sig) this.emitExit({ exitCode: null, signal: sig });
  }
  onData(l: Listener<string>): Disposable {
    if (this.throwOnSubscribe === "data") throw new Error("subscribe failed");
    this.dataAll.push(l);
    this.dataLive.add(l);
    return { dispose: () => void this.dataLive.delete(l) };
  }
  onExit(l: Listener<PtyExit>): Disposable {
    if (this.throwOnSubscribe === "exit") throw new Error("subscribe failed");
    this.exitAll.push(l);
    this.exitLive.add(l);
    const d = { dispose: () => void this.exitLive.delete(l) };
    if (this.exitDuringSubscribe) l(this.exitDuringSubscribe);
    return d;
  }
  /** Delivered to every listener ever registered, disposed or not: a hostile port ignores `dispose`. */
  emitData(s: string): void {
    for (const l of [...this.dataAll]) l(s);
  }
  emitExit(e: PtyExit = { exitCode: 0, signal: null }): void {
    for (const l of [...this.exitAll]) l(e);
  }
  get listenerCount(): number {
    return this.dataLive.size + this.exitLive.size;
  }
}

export class FakePty implements PtyPort {
  mode: "ok" | "reject" | "throw" | "hang" | "garbage" = "ok";
  readonly spawns: PtySpawn[] = [];
  readonly handles: FakeHandle[] = [];
  readonly pending: Array<{ resolve: (h: PtyHandle) => void; reject: (e: unknown) => void }> = [];
  configure: (h: FakeHandle) => void = () => {};
  spawn(spec: PtySpawn): Promise<PtyHandle> {
    this.spawns.push(spec);
    if (this.mode === "throw") throw new Error("spawn exploded");
    if (this.mode === "reject") return Promise.reject(new Error("spawn rejected"));
    if (this.mode === "garbage") return Promise.resolve(undefined as unknown as PtyHandle);
    if (this.mode === "hang") return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
    const h = new FakeHandle();
    this.configure(h);
    this.handles.push(h);
    return Promise.resolve(h);
  }
  /** A handle for a hung spawn to resolve with later. */
  makeHandle(): FakeHandle {
    const h = new FakeHandle();
    this.handles.push(h);
    return h;
  }
}

export class FakeSnapshotter implements RunSnapshotter {
  readonly log: string[] = [];
  before_: "ok" | "throw" | "hang" = "ok";
  after_: "ok" | "throw" | "hang" | "drift" = "ok";
  releaseBefore: (() => void) | undefined;
  before(ctx: SnapshotContext): Promise<void> {
    this.log.push(`before:${ctx.runId}`);
    if (this.before_ === "throw") return Promise.reject(new Error("snap"));
    if (this.before_ === "hang") return new Promise<void>((r) => (this.releaseBefore = r));
    return Promise.resolve();
  }
  after(ctx: SnapshotContext): Promise<{ drift: boolean }> {
    this.log.push(`after:${ctx.runId}`);
    if (this.after_ === "throw") return Promise.reject(new Error("snap"));
    if (this.after_ === "hang") return new Promise(() => {});
    return Promise.resolve({ drift: this.after_ === "drift" });
  }
}

export const SHA = "a".repeat(40);
export const CLI = { id: "fake", label: "Fake CLI", command: ["fakecli"], args: ["--flag-one"] };

export interface HarnessOptions {
  limits?: Partial<RunLimits>;
  newId?: () => string;
  env?: Record<string, string | undefined>;
  executables?: string[];
}

export function harness(options: HarnessOptions = {}) {
  const clock = new FakeClock();
  const db = openDatabase(":memory:");
  const now = (): Date => new Date(clock.now());
  const audit = new AuditLog(db, { payloadAllowlist: RUN_AUDIT_ALLOWLIST, now });
  const journal = Journal.open(db, { audit, now, ...(options.newId ? { newId: options.newId } : {}) });
  const pty = new FakePty();
  const snapshotter = new FakeSnapshotter();
  const redactor = new Redactor();
  const trees = new Map<string, RunWorktree>();
  const errors: string[] = [];
  let env: Record<string, string | undefined> = options.env ?? { PATH: "/usr/bin", HOME: "/home/u", SSH_AUTH_SOCK: "/tmp/agent.sock" };
  const executables = new Set(options.executables ?? ["/usr/bin/fakecli"]);
  const locator: WorktreeLocator = {
    locate: (id) => {
      const t = trees.get(id);
      return t ? Promise.resolve(t) : Promise.reject(new Error("unknown"));
    },
  };
  const supervisor = new RunSupervisor({
    journal, audit, pty, clock, locator, snapshotter, redactor,
    env: () => env,
    platform: "linux",
    fs: { isExecutableFile: (p) => executables.has(p) },
    managedWorktreeRoots: () => [...trees.values()].map((t) => t.workTree),
    ...(options.limits ? { limits: options.limits } : {}),
    onInternalError: (where, code) => void errors.push(`${where}:${code}`),
  });
  let n = 0;
  const h = {
    clock, db, audit, journal, pty, snapshotter, redactor, supervisor, errors, trees, executables,
    setEnv: (e: Record<string, string | undefined>) => void (env = e),
    workspace(): { id: string; projectId: string; tree: RunWorktree } {
      n++;
      const projectId = `proj-${n}`;
      const w = journal.createWorkspace({ projectId, branch: `axis/ws-${n}`, baseRef: "main", baseSha: SHA, createdBy: "daemon" }).value;
      journal.transitionWorkspace(w.id, "READY");
      const tree = { workTree: `/work/ws-${n}`, gitDir: `/repo/.git/worktrees/ws-${n}` };
      trees.set(w.id, tree);
      return { id: w.id, projectId, tree };
    },
    attest(w: { id: string; projectId: string }, issuedAt = clock.now()): TrustAttestation {
      return attestTrust({ workspaceId: w.id, projectId: w.projectId, issuedAt });
    },
    start(w: { id: string; projectId: string }, extra: { agent?: unknown; actor?: AuditActor; trust?: unknown; idempotencyKey?: string } = {}) {
      return supervisor.start({
        workspaceId: w.id,
        agent: "agent" in extra ? extra.agent : CLI,
        actor: extra.actor ?? "user",
        trust: ("trust" in extra ? extra.trust : h.attest(w)) as TrustAttestation,
        ...(extra.idempotencyKey ? { idempotencyKey: extra.idempotencyKey } : {}),
      });
    },
    /** Start a run and settle it so the handle exists. */
    async running(w: { id: string; projectId: string }) {
      const res = await h.start(w);
      return { run: res.run, handle: pty.handles[pty.handles.length - 1] as FakeHandle };
    },
    auditRows: () => audit.list({ limit: 1000 }),
    state: (id: string) => journal.getRun(id),
  };
  return h;
}

export type Harness = ReturnType<typeof harness>;

/** The first run id announced through `onChange`, for tests that act while `start` is still pending. */
export function firstRunId(h: Harness): Promise<string> {
  return new Promise((resolve) => {
    const d = h.supervisor.onChange((e) => {
      d.dispose();
      resolve(e.runId);
    });
  });
}
