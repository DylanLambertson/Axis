// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-X1a (docs/design/pty-exec-node.md §5a): the daemon's port to the Axis pty process, over the control port main transfers in a
// `pty-control` message. The one file of the host that loads `@axis/pty-process/client` (test/packages/imports.test.mjs); nothing
// it reaches can start a program.
import { adaptMessagePort, createPtyProcessPort, PtyExecError, PtyForgeError, PtySpawnError, type Channel, type MessagePortLike, type PtyProcessPort } from "@axis/pty-process/client";
import type { PtyExecPort, PtyForgePort, PtyPort, PtyPushPort, PtyRelayPort, PtyTerminalPort } from "../ports/pty.js";

/** What the daemon entry needs from a transferred port: an Electron `MessagePortMain` has all of it. */
export type ControlPortLike = MessagePortLike;

export interface PtyControlSlot {
  /** The host's pty port. Before a control port arrives, and after one closes, every call fails closed (`channel_closed`). */
  /** Also the endpoint relay (PV-M6): one handler, kept across reconnects; answers go to the current port. */
  /**
   * Also DC-3a's terminal port: `spawn` forwards `onLate`; `grantTerminal` and `revoke` go to the current port. A terminal id of a replaced
   * port reaches a pty process that ended that terminal when its control channel closed, so it is ignored there.
   */
  readonly port: PtyPort & PtyTerminalPort & PtyExecPort & PtyPushPort & PtyForgePort & PtyRelayPort;
  /** Takes a new control port. The previous one is disposed first: every pending spawn, exec, push and forge-list on it settles `channel_closed`. */
  attach(port: ControlPortLike): void;
  /** Drops the current port (OS-3h: main retired its generation): pending calls settle `channel_closed`. Idempotent. */
  detach(): void;
  /** True once a control port was attached (even if it has since closed). */
  attached(): boolean;
  dispose(): void;
}

export interface PtyControlOptions {
  /** Every spawn and push settles within this many milliseconds (the host port's default otherwise). */
  readonly spawnTimeoutMs?: number;
}

/**
 * One slot for the pty port. A run is never moved to a new port: what was in flight on the old one fails, and new requests go to the
 * new one. The daemon does not exit when the port closes; it answers unavailable until main sends a new one.
 */
export function createPtyControlSlot(options: PtyControlOptions = {}): PtyControlSlot {
  let current: PtyProcessPort | undefined;
  let channel: Channel | undefined;
  /** Disposes the port (pending calls settle `channel_closed`, its known groups are killed) and closes its channel. */
  const drop = (): void => {
    const p = current;
    const c = channel;
    current = undefined;
    channel = undefined;
    p?.dispose();
    try {
      c?.close();
    } catch {
      /* already closed */
    }
  };
  let ever = false;
  let disposed = false;
  // Nothing was sent, so no process can appear: definitive.
  const spawnClosed = (): Promise<never> => Promise.reject(new PtySpawnError("channel_closed", true));
  let relayHandler: Parameters<PtyRelayPort["onRelay"]>[0] | undefined;
  return {
    port: {
      spawn: (spec, onLate?: Parameters<PtyTerminalPort["spawn"]>[1]) => (current === undefined ? spawnClosed() : current.spawn(spec, onLate)),
      grantTerminal: (terminalId, conn) => void current?.grantTerminal(terminalId, conn),
      revoke: (terminalId) => current?.revoke(terminalId) ?? false,
      lateSpawnReports: true,
      push: (call) => (current === undefined ? spawnClosed() : current.push(call)),
      exec: (call) => (current === undefined ? Promise.reject(new PtyExecError("channel_closed")) : current.exec(call)),
      forgeList: (request) => (current === undefined ? Promise.reject(new PtyForgeError("channel_closed")) : current.forgeList(request)),
      relay: (msg) => current?.relay(msg) ?? false,
      onRelay(handler) {
        relayHandler = handler;
        return { dispose: () => void (relayHandler === handler && (relayHandler = undefined)) };
      },
    },
    attach(port) {
      drop();
      if (disposed) {
        try {
          port.close();
        } catch {
          /* already closed */
        }
        return;
      }
      ever = true;
      channel = adaptMessagePort(port, { shape: "electron" });
      current = createPtyProcessPort({ channel, onRelay: (m) => relayHandler?.(m), ...(options.spawnTimeoutMs === undefined ? {} : { spawnTimeoutMs: options.spawnTimeoutMs }) });
    },
    detach: () => drop(),
    attached: () => ever,
    dispose() {
      disposed = true;
      drop();
    },
  };
}
