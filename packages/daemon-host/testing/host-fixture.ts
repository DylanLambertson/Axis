// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redactor } from "@axis/audit";
import type { ChainHead } from "@axis/protocol";
import {
  ChannelMux,
  ControlClient,
  createNodeStorage,
  parseHostConfig,
  type Clock,
  type HostConfig,
  type NodeStorageOptions,
  type StartupPorts,
} from "../src/index.js";
import { memoryChannelPair, type MemoryEnd } from "./memory-channel.js";

/**
 * A headless host on a temporary directory (plan section 1.1, the fast variant): the real storage port, the real
 * `ControlClient` over an in-memory channel, and a supervisor stub that owns the anchor store the way the OS keychain
 * would. No process, no socket, no Electron. `cleanup()` closes the channel and removes the directory.
 */
export interface HostFixture {
  readonly root: string;
  readonly dataDir: string;
  readonly worktreeRoot: string;
  readonly redactor: Redactor;
  readonly config: HostConfig;
  readonly ports: StartupPorts;
  readonly client: ControlClient;
  readonly peer: MemoryEnd;
  /** Everything the host sent. */
  readonly sent: Array<Record<string, unknown>>;
  readonly supervisor: { anchor: ChainHead | null; answerAnchorGet: boolean; ackPuts: boolean; puts: ChainHead[]; answerDelayMs: number };
  cleanup(): void;
}

export interface FixtureOptions {
  readonly config?: Record<string, unknown>;
  readonly storage?: NodeStorageOptions;
  readonly clock?: Clock;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly ports?: Partial<StartupPorts>;
  /** Reuse a directory (a second host on the same data). */
  readonly root?: string;
}

export function hostFixture(options: FixtureOptions = {}): HostFixture {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "axis-host-"));
  const dataDir = join(root, "data");
  const worktreeRoot = join(root, "worktrees");
  mkdirSync(worktreeRoot, { recursive: true });
  const redactor = new Redactor();
  const config = parseHostConfig(
    { dataDir, worktreeRoot, platform: process.platform, attestationKey: randomBytes(32).toString("base64url"), ...options.config },
    redactor,
  );
  const { a, b } = memoryChannelPair();
  const mux = new ChannelMux(a);
  const client = new ControlClient({ mux });
  const sent: Array<Record<string, unknown>> = [];
  const supervisor = { anchor: null as ChainHead | null, answerAnchorGet: true, ackPuts: true, puts: [] as ChainHead[], answerDelayMs: 0 };
  const timers = new Set<NodeJS.Timeout>();
  b.onMessage((raw) => {
    const m = raw as Record<string, unknown>;
    sent.push(m);
    if (m["type"] === "anchor.get" && supervisor.answerAnchorGet) {
      const answer = { type: "anchor.result", requestId: m["requestId"], anchor: supervisor.anchor };
      if (supervisor.answerDelayMs > 0) {
        const t = setTimeout(() => (timers.delete(t), b.send(answer)), supervisor.answerDelayMs);
        t.unref();
        timers.add(t);
      } else b.send(answer);
    } else if (m["type"] === "anchor.put") {
      const head = { seq: m["seq"] as number, hash: m["hash"] as string };
      supervisor.puts.push(head);
      if (supervisor.ackPuts) {
        supervisor.anchor = head;
        b.send({ type: "anchor.ack", seq: head.seq });
      }
    }
  });
  const clock: Clock = options.clock ?? { now: () => Date.now(), monotonic: () => performance.now() };
  const ports: StartupPorts = {
    clock,
    storage: createNodeStorage(options.storage),
    control: client,
    redactor,
    env: options.env ?? process.env,
    cwd: process.cwd(),
    ...options.ports,
  } as StartupPorts;
  return {
    root,
    dataDir,
    worktreeRoot,
    redactor,
    config,
    ports,
    client,
    peer: b,
    sent,
    supervisor,
    cleanup(): void {
      for (const t of timers) clearTimeout(t);
      client.dispose();
      mux.dispose();
      a.close();
      if (options.root === undefined) rmSync(root, { recursive: true, force: true });
    },
  };
}
