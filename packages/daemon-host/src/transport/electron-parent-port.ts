// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import type { ElectronPortLike } from "@axis/daemon";
import type { SupervisorChannel, Unsubscribe } from "../ports/index.js";

/**
 * The Electron control channel as a structural type: `process.parentPort` of a `utilityProcess` satisfies it, and
 * nothing here imports `electron`. Only main can write to it (ADR 0003 D1.4).
 */
export interface ParentPortLike {
  on(event: "message", listener: (event: { data: unknown; ports?: ReadonlyArray<ElectronPortLike> }) => void): unknown;
  off(event: "message", listener: (event: { data: unknown; ports?: ReadonlyArray<ElectronPortLike> }) => void): unknown;
  postMessage(message: unknown): void;
}

export interface ElectronControl {
  /** Messages that arrived without a port. */
  readonly channel: SupervisorChannel;
  /**
   * Messages that arrived with exactly one transferred port (a `connect`). There is one handler at most, so two
   * parties can never both wrap the same port (`E_CONFLICT` for a second); if it throws, the port is closed. The
   * handler must validate `data` itself (the connect router's `fromPortMessage` does).
   */
  onPort(handler: (data: unknown, port: ElectronPortLike) => void): Unsubscribe;
  /** Counts of what was refused, for tests and the shutdown report. */
  readonly stats: () => { readonly portsClosed: number; readonly multiPortDropped: number; readonly unclaimedPorts: number };
  /** Remove the listener and close the channel for its users. Idempotent. */
  dispose(): void;
}

function closeAll(ports: ReadonlyArray<ElectronPortLike>): void {
  for (const p of ports) {
    try {
      p.close();
    } catch {
      // Already closed.
    }
  }
}

/**
 * Adapt the parent port. A message with no port is a control message. A message with exactly one port is handed to
 * the `onPort` handler (the port is closed if nobody claims it). A message with more than one port is dropped and
 * every port closed: a legitimate `connect` carries one, so extra ports are never delivered anywhere. Construct it
 * as early as possible: a message that arrives before handlers attach is lost, like any event.
 */
export function adaptParentPort(parentPort: ParentPortLike): ElectronControl {
  const messageHandlers: Array<(m: unknown) => void> = [];
  const closeHandlers: Array<() => void> = [];
  const portHandlers: Array<(data: unknown, port: ElectronPortLike) => void> = [];
  let disposed = false;
  let portsClosed = 0;
  let multiPortDropped = 0;
  let unclaimedPorts = 0;

  const listener = (event: { data: unknown; ports?: ReadonlyArray<ElectronPortLike> }): void => {
    if (disposed) return;
    const ports = Array.isArray(event.ports) ? (event.ports as ReadonlyArray<ElectronPortLike>) : [];
    if (ports.length === 0) {
      for (const h of [...messageHandlers]) safe(() => h(event.data));
      return;
    }
    if (ports.length > 1) {
      multiPortDropped++;
      portsClosed += ports.length;
      closeAll(ports);
      return;
    }
    const port = ports[0] as ElectronPortLike;
    if (portHandlers.length === 0) {
      unclaimedPorts++;
      portsClosed++;
      closeAll(ports);
      return;
    }
    try {
      (portHandlers[0] as (data: unknown, port: ElectronPortLike) => void)(event.data, port);
    } catch {
      portsClosed++;
      closeAll(ports);
    }
  };
  parentPort.on("message", listener);

  const remove = <T>(list: T[], item: T): Unsubscribe => () => {
    const i = list.indexOf(item);
    if (i >= 0) list.splice(i, 1);
  };

  const channel: SupervisorChannel = {
    send(message: unknown): void {
      if (disposed) throw new AxisError("E_UNAVAILABLE", "The channel is closed", { reason: "channel_closed" });
      try {
        parentPort.postMessage(message);
      } catch {
        throw new AxisError("E_UNAVAILABLE", "The channel is closed", { reason: "channel_closed" });
      }
    },
    onMessage(handler): Unsubscribe {
      messageHandlers.push(handler);
      return remove(messageHandlers, handler);
    },
    onClose(handler): Unsubscribe {
      closeHandlers.push(handler);
      return remove(closeHandlers, handler);
    },
  };

  return {
    channel,
    onPort(handler): Unsubscribe {
      if (portHandlers.length > 0) throw new AxisError("E_CONFLICT", "A port handler is already set");
      portHandlers.push(handler);
      return remove(portHandlers, handler);
    },
    stats: () => ({ portsClosed, multiPortDropped, unclaimedPorts }),
    dispose(): void {
      if (disposed) return;
      disposed = true;
      parentPort.off("message", listener);
      messageHandlers.length = 0;
      portHandlers.length = 0;
      for (const h of closeHandlers.splice(0)) safe(h);
    },
  };
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // One failing handler must not break the others.
  }
}
