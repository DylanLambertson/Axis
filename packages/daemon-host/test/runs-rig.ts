// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import * as path from "node:path";
import { Redactor } from "@axis/audit";
import {
  createCliRunsHandlers,
  createRunTrustMinter,
  createRunsBinding,
  type CliRunsHandlerDeps,
  type PtyHandle,
  type PtyPort,
  type PtySpawn,
  type RunsBinding,
  type RunsBindingDeps,
} from "../src/index.js";
import { worktreesRig, type Rig, type RigOptions } from "./worktrees-rig.js";

/** A pty handle the test drives: it exits when told to and its process group lives until told otherwise. */
export class FakeHandle implements PtyHandle {
  readonly kills: string[] = [];
  groupUp = true;
  groupThrows = false;
  /** When set, `groupAlive` returns this value as is (a probe that does not answer with a boolean). */
  groupRaw: { value: unknown } | undefined;
  #exit: Array<(e: { exitCode: number | null; signal: string | null }) => void> = [];
  write(): void {}
  resize(): void {}
  kill(signal: "SIGINT" | "SIGTERM" | "SIGKILL"): void {
    this.kills.push(signal);
  }
  groupAlive(): boolean {
    if (this.groupThrows) throw new Error("probe failed");
    if (this.groupRaw !== undefined) return this.groupRaw.value as boolean;
    return this.groupUp;
  }
  onData(): { dispose(): void } {
    return { dispose() {} };
  }
  onExit(l: (e: { exitCode: number | null; signal: string | null }) => void): { dispose(): void } {
    this.#exit.push(l);
    return { dispose: () => void (this.#exit = this.#exit.filter((x) => x !== l)) };
  }
  exit(exitCode: number | null, signal: string | null = null): void {
    for (const l of [...this.#exit]) l({ exitCode, signal });
  }
}

export class FakePty implements PtyPort {
  readonly spawns: PtySpawn[] = [];
  readonly handles: FakeHandle[] = [];
  /** Return a handle without `groupAlive` (a port that cannot say whether the group is gone). */
  noProbe = false;
  readonly noProbeKills: string[] = [];
  spawn(spec: PtySpawn): Promise<PtyHandle> {
    if (this.noProbe) return Promise.resolve({ kill: (s: string) => void this.noProbeKills.push(s) } as unknown as PtyHandle);
    this.spawns.push(spec);
    const h = new FakeHandle();
    this.handles.push(h);
    return Promise.resolve(h);
  }
}

export interface Answers {
  /** What main says to `trust.check`: true, false, or `"silent"` (no answer). */
  trust: boolean | "silent";
  /** The value of `axis.cliAgents` (null: unset). */
  agents: unknown;
}

export interface RunsRig extends Rig {
  readonly pty: FakePty;
  readonly runs: RunsBinding;
  readonly exe: string;
  readonly answers: Answers;
  readonly snapshots: { failBefore: boolean };
  /** Timers armed on the supervisor's clock and not yet fired or cleared. */
  readonly timers: Set<unknown>;
  readonly deps: RunsBindingDeps;
  readonly handlerDeps: CliRunsHandlerDeps;
  readonly asked: Array<Record<string, unknown>>;
  /** The settings and trust questions main was asked, in order. */
}

export async function runsRig(options: RigOptions = {}): Promise<RunsRig> {
  const holder: { runs?: RunsBinding } = {};
  const rig = await worktreesRig({ ...options, hasActiveRun: (id) => holder.runs?.service.hasActiveRun(id) ?? true });
  const pty = new FakePty();
  const exe = path.join(rig.tmp, "bin", "fakecli");
  const answers: Answers = { trust: true, agents: [{ id: "fake", label: "Fake CLI", command: [exe], args: [] }] };
  const snapshots = { failBefore: false };
  const timers = new Set<unknown>();
  const asked: Array<Record<string, unknown>> = [];
  rig.channel.onMessage((m) => {
    const msg = m as Record<string, unknown>;
    if (msg["type"] === "trust.check") {
      asked.push(msg);
      if (answers.trust !== "silent") rig.channel.send({ type: "trust.result", requestId: msg["requestId"], trusted: answers.trust });
    } else if (msg["type"] === "settings.get") {
      asked.push(msg);
      rig.channel.send({ type: "settings.result", requestId: msg["requestId"], key: msg["key"], value: answers.agents });
    }
  });
  const deps: RunsBindingDeps = {
    journal: rig.journal,
    audit: rig.audit,
    pty,
    clock: {
      now: () => rig.clock.now(),
      setTimeout: (fn, ms) => {
        const t = setTimeout(() => (timers.delete(t), fn()), ms);
        t.unref();
        timers.add(t);
        return t;
      },
      clearTimeout: (id) => {
        timers.delete(id);
        clearTimeout(id as NodeJS.Timeout);
      },
    },
    locator: rig.binding.locator,
    snapshotter: {
      before: () => (snapshots.failBefore ? Promise.reject(new Error("snapshot failed")) : Promise.resolve()),
      after: () => Promise.resolve({ drift: false }),
    },
    env: () => ({ PATH: rig.home, HOME: rig.home }),
    redactor: new Redactor(),
    mutex: rig.binding.mutex,
    platform: process.platform,
    fs: { isExecutableFile: (p) => p === exe },
    managedWorktreeRoots: () => [rig.root],
  };
  const runs = createRunsBinding(deps);
  holder.runs = runs;
  const handlerDeps: CliRunsHandlerDeps = {
    service: runs.service,
    journal: rig.journal,
    control: rig.control,
    minter: createRunTrustMinter(rig.clock),
    mutex: rig.binding.mutex,
    needsAttention: rig.binding.needsAttention,
  };
  rig.daemon.register("axis.cli-runs", 1, createCliRunsHandlers(handlerDeps));
  const cleanup = rig.cleanup;
  return Object.assign(rig, {
    pty,
    runs,
    exe,
    answers,
    snapshots,
    timers,
    deps,
    handlerDeps,
    asked,
    cleanup: async (): Promise<void> => {
      runs.dispose();
      await cleanup();
    },
  });
}

export const START = (workspaceId: string, agentId = "fake"): { workspaceId: string; agentId: string } => ({ workspaceId, agentId });

/** Poll until `pred` holds (timers and microtasks run in between). */
export async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting for the condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}
