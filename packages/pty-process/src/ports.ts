// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * The shapes of the Axis pty process. `PtySpawn`, `PtyHandle` and `PtyPort` repeat `@axis/runs` field for field (a compile-time
 * test in `test/types.test.ts` asserts both directions), because the host's binding is the only place that imports that package.
 */
export interface Disposable {
  dispose(): void;
}

export type PtySignal = "SIGINT" | "SIGTERM" | "SIGKILL";

export interface PtySpawn {
  readonly runId: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
}

export interface PtyExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal: PtySignal): void;
  groupAlive(): boolean;
  onData(listener: (chunk: string) => void): Disposable;
  onExit(listener: (exit: PtyExit) => void): Disposable;
}

export interface PtyPort {
  spawn(spec: PtySpawn): Promise<PtyHandle>;
}

/** What the pty process asks its spawn function for. Nothing else reaches the child: the env is used as given. */
export interface SpawnRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
}

/**
 * How the group of one child is observed. POSIX: the child leads a new session or group, so `pgid` equals its pid and
 * `kill(-pgid, 0)` answers. Windows: the child is in a job object that disallows breakaway; the child reports when the job's
 * active count reaches 0 through `onGroupEmpty`.
 */
export type ChildGroup = { readonly kind: "pgid"; readonly pgid: number } | { readonly kind: "job" };

/** One running child, as the injected spawn function returns it (a native pty binding in the shipped entry, a pipe fake in tests). */
export interface PtyChild {
  readonly pid: number;
  readonly group: ChildGroup;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Signals the leader; for a `job` group it must end the whole job. A `pgid` group is signalled by the service itself. */
  kill(signal: PtySignal): void;
  onData(listener: (chunk: string) => void): Disposable;
  onExit(listener: (exit: PtyExit) => void): Disposable;
  /** Stops and restarts reading the child's output, so the child blocks on a full pty buffer (backpressure). Absent: output over the hard bound is dropped. */
  pause?(): void;
  resume?(): void;
  /** `job` groups only: called once when the job has no active process left. */
  onGroupEmpty?(listener: () => void): Disposable;
}

/** Synchronous like a native pty binding. A throw is a failed spawn. The function must start the child in its own session or job. */
export type SpawnFn = (request: SpawnRequest) => PtyChild;

/** `process.kill` as a seam. It throws an error whose `code` is `ESRCH`, `EPERM` or another errno string, as Node does. */
export interface ProcessOps {
  signal(pid: number, signal: number | NodeJS.Signals): void;
}

export const systemProcessOps: ProcessOps = {
  signal: (pid, signal) => void process.kill(pid, signal),
};

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export const systemClock: Clock = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms) as unknown as NodeJS.Timeout;
    t.unref();
    return t;
  },
  clearTimeout: (id) => clearTimeout(id as NodeJS.Timeout),
};

/** A bidirectional message pipe (a MessagePort or a pipe in production). Messages are untrusted on both ends. */
export interface Channel {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): Disposable;
  onClose(listener: () => void): Disposable;
  close(): void;
}
