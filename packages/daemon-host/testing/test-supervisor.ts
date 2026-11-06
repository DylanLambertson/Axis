// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { Connection, Identity } from "@axis/daemon";
import type { ChainHead } from "@axis/protocol";
import {
  adaptNodeIpc,
  adaptNodePort,
  ChannelMux,
  outboundMessageSchema,
  signAttestation,
  type Attestation,
  type ChannelFlow,
  type DisposableChannel,
  type OutboundMessage,
} from "../src/index.js";

/**
 * The test-only supervisor (plan section 1.1): it starts a host as a real child process (or as a worker thread for
 * fast tests), sends `init` with a fresh data directory, answers `anchor.get`/`anchor.put`/`anchor.ack` from a store it
 * owns, answers `native.confirm` on command, answers `trust.check` and `settings.get` from tables the test sets,
 * mints attestations with the real key, and speaks `ChannelMux`. It never reaches into the host. Everything it
 * creates (processes, workers, listeners, the temporary directory) is released by `dispose()`.
 */

export const ECHO_HOST_ENTRY = fileURLToPath(new URL("./echo-host.js", import.meta.url));

export interface TestSupervisorOptions {
  /** Absolute path of the script to run. Defaults to the control-channel echo host. */
  readonly entry?: string;
  readonly mode?: "process" | "worker";
  /** Merged over the default init config. */
  readonly config?: Record<string, unknown>;
  /** Do not send `init` (to test the host's own wait). */
  readonly skipInit?: boolean;
  /** Initial anchor in the store, as the supervisor's keychain would hold. */
  readonly anchor?: ChainHead;
  /** Do not ack `anchor.put`. */
  readonly holdAcks?: boolean;
  /** Environment of the host child process (a process host only; replaces the test's own). Default: the test's own. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Reuse this directory (a second host on the same data, the way a restart does). It is not removed by `dispose()`. */
  readonly root?: string;
  /** The attestation key of an earlier host on the same data (default: a fresh one). */
  readonly key?: Buffer;
}

export interface ExitInfo {
  readonly code: number | null;
  readonly signal: string | null;
}

const MAX_STDERR_CHARS = 65_536;
/** A generous bound (not an assertion about speed): a host that has not answered by now is stuck. */
const WAIT_BOUND_MS = 30_000;
const nextCid = ((n = 0) => () => `tc${String(++n).padStart(8, "0")}`)();

export class TestSupervisor {
  readonly key: Buffer;
  readonly dataDir: string;
  readonly mux: ChannelMux;
  /** Everything the host sent on the control plane, parsed (an invalid one is kept raw under `invalid`). */
  readonly received: OutboundMessage[] = [];
  readonly invalid: unknown[] = [];
  readonly nativeConfirms: Array<{ challengeId: string; proof: string; windowId: string; summary: string }> = [];
  readonly anchorPuts: ChainHead[] = [];
  readonly exited: Promise<ExitInfo>;
  anchor: ChainHead | null;
  holdAcks: boolean;
  /** Answer for `trust.check`; `undefined` means do not answer. */
  trustAnswer: (m: Extract<OutboundMessage, { type: "trust.check" }>) => boolean | undefined = () => true;
  settings: Record<string, unknown> = {};
  stderr = "";

  readonly #channel: DisposableChannel & Partial<ChannelFlow>;
  readonly #root: string;
  readonly #ownsRoot: boolean;
  readonly #kill: (signal?: NodeJS.Signals) => void;
  readonly #waiters = new Set<{ type: string; resolve: (m: OutboundMessage) => void; reject: (e: Error) => void }>();
  readonly #connections = new Set<Connection>();
  #disposed = false;

  private constructor(
    root: string,
    channel: DisposableChannel,
    kill: (signal?: NodeJS.Signals) => void,
    exited: Promise<ExitInfo>,
    options: TestSupervisorOptions,
    appendStderr: (hook: (text: string) => void) => void,
  ) {
    this.#root = root;
    this.#ownsRoot = options.root === undefined;
    this.key = options.key ?? randomBytes(32);
    this.dataDir = join(root, "data");
    this.#channel = channel;
    this.#kill = kill;
    this.exited = exited;
    this.anchor = options.anchor ?? null;
    this.holdAcks = options.holdAcks ?? false;
    this.mux = new ChannelMux(channel);
    this.mux.onControl((raw) => this.#onControl(raw));
    appendStderr((t) => void (this.stderr = (this.stderr + t).slice(-MAX_STDERR_CHARS)));
  }

  /** The backlog of the control channel (the web host reads it); a worker port writes at once, so its backlog is always 0. */
  get flow(): ChannelFlow {
    const c = this.#channel;
    if (typeof c.pending === "function" && typeof c.onDrain === "function") return { pending: () => (c.pending as () => number)(), onDrain: (h) => (c.onDrain as ChannelFlow["onDrain"])(h) };
    return { pending: () => 0, onDrain: () => () => undefined };
  }

  static async start(options: TestSupervisorOptions = {}): Promise<TestSupervisor> {
    const root = options.root ?? (await mkdtemp(join(tmpdir(), "axis-supervisor-")));
    const entry = options.entry ?? ECHO_HOST_ENTRY;
    let sup: TestSupervisor;
    // Whatever was started is killed again if anything below throws, so a failed start leaves no child behind.
    let killStarted: () => void = () => undefined;
    try {
      if (options.mode === "worker") {
        const worker = new Worker(entry, { stderr: true });
        killStarted = () => void worker.terminate();
        const exited = new Promise<ExitInfo>((resolve) => {
          worker.once("exit", (code) => resolve({ code, signal: null }));
          worker.once("error", () => resolve({ code: null, signal: null }));
        });
        const channel = adaptNodePort(worker, "exit");
        sup = new TestSupervisor(root, channel, () => void worker.terminate(), exited, options, (hook) => worker.stderr.on("data", (d: Buffer) => hook(d.toString("utf8"))));
      } else {
        const child: ChildProcess = fork(entry, [], { stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "json", ...(options.env === undefined ? {} : { env: options.env as NodeJS.ProcessEnv }) });
        killStarted = () => void child.kill("SIGKILL");
        // `error` (spawn failure, failed kill) may arrive without `exit`: `dispose()` must not wait for one forever.
        const exited = new Promise<ExitInfo>((resolve) => {
          child.once("exit", (code, signal) => resolve({ code, signal }));
          child.once("error", () => resolve({ code: null, signal: null }));
        });
        const channel = adaptNodeIpc(child);
        sup = new TestSupervisor(root, channel, (sig) => void child.kill(sig ?? "SIGKILL"), exited, options, (hook) => child.stderr?.on("data", (d: Buffer) => hook(d.toString("utf8"))));
      }
      if (options.skipInit !== true) sup.sendInit(options.config);
    } catch (e) {
      killStarted();
      if (options.root === undefined) await rm(root, { recursive: true, force: true });
      throw e;
    }
    return sup;
  }

  /** The default init payload, with `over` merged on top. */
  initConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      dataDir: this.dataDir,
      worktreeRoot: join(this.#root, "worktrees"),
      platform: process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
      devDiagnostics: true,
      attestationKey: this.key.toString("base64url"),
      ...over,
    };
  }

  sendInit(over?: Record<string, unknown>): void {
    this.mux.sendControl({ type: "init", config: this.initConfig(over) });
  }

  /** Mint an attestation with the real key. `issuedAt` defaults to now. */
  attest(identity: Partial<Identity> = {}, issuedAt: number = Date.now()): Attestation {
    const full: Identity = {
      connectionId: randomBytes(16).toString("base64url"),
      windowId: "win-1",
      actorId: "person-1",
      actor: "user",
      trusted: true,
      clientKind: "desktop",
      ...identity,
    };
    return signAttestation(this.key, full, issuedAt);
  }

  /** Open a virtual connection to the host with this attestation (a fresh valid one by default). */
  connect(attestation: Attestation = this.attest()): Connection {
    const cid = nextCid();
    const conn = this.mux.open(cid);
    if (conn === undefined) throw new Error("mux refused the connection");
    this.#connections.add(conn);
    conn.onClose(() => void this.#connections.delete(conn));
    this.mux.sendControl({ type: "connect", cid, attestation });
    return conn;
  }

  /**
   * The first control message of this type at or after position `from` of `received` (default the start), waiting
   * for it when it has not arrived yet. Pass `received.length` to wait only for a new one.
   */
  waitFor<T extends OutboundMessage["type"]>(type: T, from = 0): Promise<Extract<OutboundMessage, { type: T }>> {
    const have = this.received.slice(from).find((m) => m.type === type);
    if (have !== undefined) return Promise.resolve(have as Extract<OutboundMessage, { type: T }>);
    // A host that exits, or says nothing within the bound, rejects the wait: a failing step reports instead of hanging.
    return new Promise((resolve, reject) => {
      const waiter = {
        type,
        resolve: (m: OutboundMessage) => (clearTimeout(timer), resolve(m as Extract<OutboundMessage, { type: T }>)),
        reject: (e: Error) => (clearTimeout(timer), reject(e)),
      };
      const timer = setTimeout(() => (this.#waiters.delete(waiter), reject(new Error(`no ${type} message from the host within ${WAIT_BOUND_MS} ms`))), WAIT_BOUND_MS);
      timer.unref();
      this.#waiters.add(waiter);
      void this.exited.then(() => {
        if (this.#waiters.delete(waiter)) waiter.reject(new Error(`the host exited before sending ${type}`));
      });
    });
  }

  /** Answer a recorded `native.confirm` (the host then calls `confirmNative`). */
  answerNative(challengeId: string, confirmed: boolean): void {
    const c = this.nativeConfirms.find((n) => n.challengeId === challengeId);
    if (c === undefined) throw new Error("no such native.confirm");
    this.mux.sendControl({ type: "native.result", challengeId, proof: c.proof, confirmed, windowId: c.windowId });
  }

  shutdown(): void {
    this.mux.sendControl({ type: "shutdown" });
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    this.#kill(signal);
  }

  /** Stop the host, release every listener and remove the temporary directory. Idempotent. */
  async dispose(): Promise<ExitInfo> {
    if (!this.#disposed) {
      this.#disposed = true;
      this.#kill("SIGKILL");
    }
    const info = await this.exited;
    for (const c of [...this.#connections]) c.close();
    this.mux.dispose();
    this.#channel.dispose();
    for (const w of [...this.#waiters]) w.reject(new Error("the supervisor was disposed"));
    this.#waiters.clear();
    // A CLI the killed host left behind may still be writing for a moment: retry the removal.
    if (this.#ownsRoot) await rm(this.#root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    return info;
  }

  #onControl(raw: unknown): void {
    const parsed = outboundMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.invalid.push(raw);
      return;
    }
    const m = parsed.data;
    this.received.push(m);
    switch (m.type) {
      case "anchor.get":
        this.mux.sendControl({ type: "anchor.result", requestId: m.requestId, anchor: this.anchor });
        break;
      case "anchor.put":
        this.anchorPuts.push({ seq: m.seq, hash: m.hash });
        if (!this.holdAcks) this.ack(m.seq, m.hash);
        break;
      case "native.confirm":
        this.nativeConfirms.push({ challengeId: m.challengeId, proof: m.proof, windowId: m.windowId, summary: m.summary });
        break;
      case "trust.check": {
        const answer = this.trustAnswer(m);
        if (answer !== undefined) this.mux.sendControl({ type: "trust.result", requestId: m.requestId, trusted: answer });
        break;
      }
      case "settings.get":
        this.mux.sendControl({ type: "settings.result", requestId: m.requestId, key: m.key, value: (this.settings[m.key] ?? null) as never });
        break;
      default:
        break;
    }
    for (const w of [...this.#waiters]) {
      if (w.type === m.type) {
        this.#waiters.delete(w);
        w.resolve(m);
      }
    }
  }

  /** Make the anchor durable and tell the host (also what a held ack release does). */
  ack(seq: number, hash?: string): void {
    const head = this.anchorPuts.find((p) => p.seq === seq);
    this.anchor = head ?? (hash === undefined ? this.anchor : { seq, hash });
    this.mux.sendControl({ type: "anchor.ack", seq });
  }
}
