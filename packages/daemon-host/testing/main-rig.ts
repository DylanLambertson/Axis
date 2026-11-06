// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { fork, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ClientPort } from "@axis/protocol";
import type { PortPair } from "../src/main/connect-broker.js";
import type { DaemonChild } from "../src/supervisor.js";

/**
 * TEST ONLY: main's side of `entry-child.ts`. `TunnelChild` is the `DaemonChild` the real `DaemonSupervisor` drives (Electron's
 * `UtilityProcess` in the product); `channel()` is the broker's `createChannel` (Electron's `MessageChannelMain`): its daemon end is
 * a token that `postMessage(message, [token])` turns into a port in the child, its renderer end is a `ClientPort` for
 * `AxisPortClient`. Every post on a channel is recorded, so a test can replay the exact `connect` main sent.
 */

export const ENTRY_CHILD = fileURLToPath(new URL("./entry-child.js", import.meta.url));

export const hmacSha256 = (key: Uint8Array, text: string): Uint8Array => new Uint8Array(createHmac("sha256", key).update(text, "utf8").digest());

export class TunnelEnd {
  pid: number | undefined;
}

class RendererEnd implements ClientPort {
  readonly #msg = new Set<(d: unknown) => void>();
  readonly #close = new Set<() => void>();
  readonly #queued: unknown[] = [];
  #child: TunnelChild | undefined;
  #pid: number | undefined;
  closed = false;
  attach(child: TunnelChild, pid: number): void {
    this.#child = child;
    this.#pid = pid;
    for (const m of this.#queued.splice(0)) child.raw({ kind: "frame", pid, data: m });
  }
  postMessage(m: unknown): void {
    if (this.closed) throw new Error("closed");
    if (this.#child === undefined || this.#pid === undefined) this.#queued.push(m);
    else this.#child.raw({ kind: "frame", pid: this.#pid, data: m });
  }
  onMessage(h: (d: unknown) => void): () => void {
    this.#msg.add(h);
    return () => void this.#msg.delete(h);
  }
  onClose(h: () => void): () => void {
    this.#close.add(h);
    return () => void this.#close.delete(h);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.#child !== undefined && this.#pid !== undefined) this.#child.raw({ kind: "close", pid: this.#pid });
    for (const h of [...this.#close]) h();
  }
  deliver(m: unknown): void {
    for (const h of [...this.#msg]) h(m);
  }
}

const ends = new WeakMap<TunnelEnd, RendererEnd>();

/** A fresh pair for the broker (`MessageChannelMain`). */
export function channel(): PortPair<TunnelEnd | ClientPort> {
  const daemonEnd = new TunnelEnd();
  const rendererEnd = new RendererEnd();
  ends.set(daemonEnd, rendererEnd);
  return { daemonEnd, rendererEnd };
}

export function closePort(p: TunnelEnd | ClientPort): void {
  if (p instanceof RendererEnd) p.close();
}

export class TunnelChild implements DaemonChild {
  readonly proc: ChildProcess;
  readonly posted: Array<{ message: unknown; withPort: boolean }> = [];
  stderr = "";
  readonly #renderers = new Map<number, RendererEnd>();
  #nextPid = 1;

  constructor(env: Record<string, string>) {
    this.proc = fork(ENTRY_CHILD, [], { execArgv: [], env, stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "json" });
    this.proc.stderr?.on("data", (d: Buffer) => void (this.stderr = (this.stderr + d.toString("utf8")).slice(-65_536)));
    this.proc.on("message", (raw: unknown) => {
      const m = raw as { kind: string; pid?: number; data?: unknown };
      if (m.kind === "frame") this.#renderers.get(m.pid as number)?.deliver(m.data);
      else if (m.kind === "closed") {
        const r = this.#renderers.get(m.pid as number);
        this.#renderers.delete(m.pid as number);
        r?.close();
      }
    });
  }

  raw(m: unknown): void {
    if (this.proc.connected) this.proc.send(m as never);
  }

  postMessage(message: unknown, transfer?: readonly unknown[]): void {
    this.posted.push({ message, withPort: transfer !== undefined });
    if (transfer === undefined) return this.raw({ kind: "ctl", data: message });
    if (transfer.length !== 1 || !(transfer[0] instanceof TunnelEnd)) throw new Error("one tunnel end expected");
    const end = transfer[0];
    const pid = this.#nextPid++;
    end.pid = pid;
    const renderer = ends.get(end);
    this.raw({ kind: "port", pid, data: message });
    if (renderer !== undefined) {
      this.#renderers.set(pid, renderer);
      renderer.attach(this, pid);
    }
  }

  /** Post `message` with a new port whose renderer end is returned (a party other than the broker: a forged or replayed connect). */
  postWithNewPort(message: unknown): ClientPort {
    const pair = channel();
    this.postMessage(message, [pair.daemonEnd]);
    return pair.rendererEnd as ClientPort;
  }

  kill(): void {
    this.proc.kill("SIGKILL");
  }
  onMessage(handler: (message: unknown) => void): () => void {
    const l = (raw: unknown): void => {
      const m = raw as { kind: string; data?: unknown };
      if (m.kind === "ctl") handler(m.data);
    };
    this.proc.on("message", l);
    return () => void this.proc.off("message", l);
  }
  onExit(handler: (code: number | null) => void): () => void {
    const l = (code: number | null): void => handler(code);
    this.proc.on("exit", l);
    return () => void this.proc.off("exit", l);
  }
}

export const randomKey = (): Buffer => randomBytes(32);
