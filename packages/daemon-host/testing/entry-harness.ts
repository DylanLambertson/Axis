// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronPortLike } from "@axis/daemon";
import type { ParentPortLike } from "../src/index.js";
import type { EntryProcess } from "../src/entry.js";

/**
 * TEST ONLY: the Electron side of the utility process entry, in memory. `FakeParentPort` is `process.parentPort` (the parent
 * posts with `deliver`, the entry's `postMessage` lands in `posted`) and `FakeProcess` is the `process` the entry may end. Nothing
 * here is Electron, a socket or a real signal.
 */
export type PortEvent = { data: unknown; ports?: ReadonlyArray<ElectronPortLike> };

export class FakeParentPort implements ParentPortLike {
  readonly posted: Array<Record<string, unknown>> = [];
  #listener: ((e: PortEvent) => void) | undefined;
  /** What to answer to a message the entry posts (the parent's job: anchor storage). */
  reply: (m: Record<string, unknown>, deliver: (data: unknown) => void) => void = () => undefined;

  on(_event: "message", listener: (e: PortEvent) => void): unknown {
    this.#listener = listener;
    return this;
  }
  off(_event: "message", listener: (e: PortEvent) => void): unknown {
    if (this.#listener === listener) this.#listener = undefined;
    return this;
  }
  postMessage(message: unknown): void {
    const m = message as Record<string, unknown>;
    this.posted.push(m);
    queueMicrotask(() => this.reply(m, (data) => this.deliver(data)));
  }
  deliver(data: unknown, ports: ReadonlyArray<ElectronPortLike> = []): void {
    this.#listener?.({ data, ports });
  }
  attached(): boolean {
    return this.#listener !== undefined;
  }
  typesPosted(): string[] {
    return this.posted.map((m) => String(m["type"]));
  }
}

export class FakeProcess extends EventEmitter implements EntryProcess {
  exitCode: number | string | null | undefined;
  readonly exits: number[] = [];
  exit(code?: number): void {
    this.exits.push(code ?? 0);
  }
}

export interface Sandbox {
  readonly root: string;
  readonly dataDir: string;
  readonly worktreeRoot: string;
  cleanup(): void;
}

export function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "axis-entry-"));
  return { root, dataDir: join(root, "data"), worktreeRoot: join(root, "worktrees"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export const platformName = (): "darwin" | "linux" | "win32" => (process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux");

/** An init payload; the key is random per call and returned so a test can assert it never reaches a log line. */
export function initPayload(box: Sandbox, over: Record<string, unknown> = {}): { message: { type: "init"; config: Record<string, unknown> }; key: Buffer } {
  const key = randomBytes(32);
  return {
    key,
    message: { type: "init", config: { dataDir: box.dataDir, worktreeRoot: box.worktreeRoot, platform: platformName(), attestationKey: key.toString("base64url"), ...over } },
  };
}

/** Manual timers: nothing runs until `fire()`, so no test depends on a real clock. */
export class FakeTimers {
  readonly cleared: number[] = [];
  readonly #pending = new Map<number, () => void>();
  #next = 1;
  set = (fn: () => void, _ms: number): number => {
    const id = this.#next++;
    this.#pending.set(id, fn);
    return id;
  };
  clear = (handle: unknown): void => {
    this.cleared.push(handle as number);
    this.#pending.delete(handle as number);
  };
  pending(): number {
    return this.#pending.size;
  }
  /** Run every timer that has not been cleared (the ones a real clock would still fire). */
  fire(): void {
    for (const [id, fn] of [...this.#pending]) {
      this.#pending.delete(id);
      fn();
    }
  }
}
