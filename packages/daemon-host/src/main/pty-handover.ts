// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-X1b (docs/design/pty-exec-node.md §6.3 and §6.4): the control channel between the pty process and the daemon. Whenever either
// process (re)starts and both are up, main makes ONE new channel and posts `{ type: "pty-control" }` with port A to the pty process
// and port B to the daemon: exactly that one key, exactly one port each. A port is never sent twice and never kept: once posted it
// belongs to the receiver, and a port that could not be posted is closed. Main sends `pty-control` on no other channel.
//
// What the two ends do with it is theirs (X1a): the daemon entry holds a port that arrives before its `init` and replaces its port
// after ready; the pty service serves one control channel at a time and closes a second while the first is open. So after a daemon
// exit, the new channel works once the pty process has seen the old one close, which the OS does when the daemon's process ends;
// the daemon's restart backoff (at least `baseDelayMs`) comes first. Electron-free: the seam passes `createChannel` and `closePort`.

/** One end's process handle: what the seam's `UtilityProcess` adapter offers. */
export interface HandoverChild {
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
}

export type HandoverEvent = "handed_over" | "post_failed";

export interface ControlHandoverOptions<P> {
  /** A new `MessageChannelMain`'s two ports. */
  readonly createChannel: () => { readonly port1: P; readonly port2: P };
  readonly closePort: (port: P) => void;
  readonly onEvent?: (event: HandoverEvent, fields: { readonly side?: "pty" | "daemon"; readonly count?: number }) => void;
}

export const PTY_CONTROL_MESSAGE = Object.freeze({ type: "pty-control" } as const);

export class ControlHandover<P> {
  readonly #o: ControlHandoverOptions<P>;
  #pty: HandoverChild | undefined;
  #daemon: HandoverChild | undefined;
  #count = 0;
  #disposed = false;

  constructor(options: ControlHandoverOptions<P>) {
    this.#o = options;
  }

  /** The pty process was (re)spawned (`alive`) or exited (not `alive`). */
  pty(child: HandoverChild, alive: boolean): void {
    this.#pty = this.#update(this.#pty, child, alive);
    if (alive) this.#handOver();
  }

  /** The daemon was (re)spawned (`alive`) or exited (not `alive`). */
  daemon(child: HandoverChild, alive: boolean): void {
    this.#daemon = this.#update(this.#daemon, child, alive);
    if (alive) this.#handOver();
  }

  /** How many channels were handed over (both ports posted). */
  count(): number {
    return this.#count;
  }

  /** No hand-over after this; nothing is held, so there is nothing to close. */
  dispose(): void {
    this.#disposed = true;
    this.#pty = this.#daemon = undefined;
  }

  #update(current: HandoverChild | undefined, child: HandoverChild, alive: boolean): HandoverChild | undefined {
    if (alive) return child;
    // Only the child that exited leaves: a late exit of an older child never removes its successor.
    return current === child ? undefined : current;
  }

  #handOver(): void {
    const pty = this.#pty;
    const daemon = this.#daemon;
    if (this.#disposed || pty === undefined || daemon === undefined) return;
    const { port1, port2 } = this.#o.createChannel();
    let ptySent = false;
    try {
      pty.postMessage({ ...PTY_CONTROL_MESSAGE }, [port1]);
      ptySent = true;
      daemon.postMessage({ ...PTY_CONTROL_MESSAGE }, [port2]);
    } catch {
      // A port not posted is closed here; a posted one is the receiver's, and its peer closing ends it there (fail closed).
      if (!ptySent) this.#close(port1);
      this.#close(port2);
      this.#emit("post_failed", { side: ptySent ? "daemon" : "pty" });
      return;
    }
    this.#count++;
    this.#emit("handed_over", { count: this.#count });
  }

  #close(port: P): void {
    try {
      this.#o.closePort(port);
    } catch {
      // already closed
    }
  }

  #emit(event: HandoverEvent, fields: { side?: "pty" | "daemon"; count?: number }): void {
    try {
      this.#o.onEvent?.(event, fields);
    } catch {
      // an observer changes nothing
    }
  }
}
