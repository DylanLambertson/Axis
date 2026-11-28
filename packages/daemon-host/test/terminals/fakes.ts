// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// TEST ONLY: fake terminal handles and a fake terminal port for the DC-3a registry and service tests.
import type { PtyExit, PtyLateSpawn, PtySpawn, PtyTerminalHandle, PtyTerminalPort } from "../../src/ports/pty.js";

let next = 0;
export const tid = (): string => `pty_${(++next).toString(16).padStart(32, "0")}`;

/** A handle whose group lives until `gone()`; `kill` can be made to throw or to leave the group alive. */
export class FakeHandle implements PtyTerminalHandle {
  readonly kills: string[] = [];
  alive = true;
  /** The kill throws (a refused signal). */
  killThrows = false;
  /** The kill does not end the group (a child that survives). */
  survives = false;
  /** groupAlive throws (an unknown state). */
  probeThrows = false;
  private readonly exits = new Set<(e: PtyExit) => void>();
  constructor(readonly terminalId: string = tid()) {}
  write(): void {}
  resize(): void {}
  kill(signal: string): void {
    this.kills.push(signal);
    if (this.killThrows) throw new Error("EPERM");
    if (!this.survives) this.alive = false;
  }
  groupAlive(): boolean {
    if (this.probeThrows) throw new Error("unknown");
    return this.alive;
  }
  onData() {
    return { dispose: () => undefined };
  }
  onExit(l: (e: PtyExit) => void) {
    this.exits.add(l);
    return { dispose: () => void this.exits.delete(l) };
  }
  /** The leader exits; the group lives on unless `groupGone`. */
  exit(groupGone = false): void {
    if (groupGone) this.alive = false;
    for (const l of [...this.exits]) l({ exitCode: 0, signal: null });
  }
}

export interface PendingSpawn {
  readonly spec: PtySpawn;
  readonly onLate: (l: PtyLateSpawn) => void;  // a no-op when the caller passed none
  resolve(h: PtyTerminalHandle): void;
  reject(e: unknown): void;
}

/** A terminal port whose spawns wait until the test settles them; grants and revokes are recorded. */
export class FakeTerminalPort implements PtyTerminalPort {
  readonly lateSpawnReports = true as const;
  readonly spawns: PendingSpawn[] = [];
  readonly grants: Array<[string, string]> = [];
  readonly revokes: string[] = [];
  spawn(spec: PtySpawn, onLate?: (l: PtyLateSpawn) => void): Promise<PtyTerminalHandle> {
    return new Promise((resolve, reject) => void this.spawns.push({ spec, onLate: onLate ?? (() => undefined), resolve, reject }));
  }
  grantTerminal(terminalId: string, conn: string): void {
    this.grants.push([terminalId, conn]);
  }
  revoke(terminalId: string): boolean {
    this.revokes.push(terminalId);
    return true;
  }
}

/** A spawn rejection as the pty client gives it. */
export const spawnError = (code: string, definitive: boolean): Error => Object.assign(new Error(`pty spawn failed: ${code}`), { code, definitive });
