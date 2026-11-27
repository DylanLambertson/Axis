// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// TEST ONLY: a pty port for the headless slice that can host CLI messaging endpoints (PV-M7 slice 2). It is the production control
// slot (`createPtyControlSlot`, the daemon's side) over a MessageChannel to a REAL in-process pty service (`createPtyService`) with
// the endpoint listener configured under a runtime directory the test owns. Children are plain processes in their own group (no
// terminal); everything else (the spawn and relay protocol, the listener, its sockets and their framing) is the real code.
import { spawn as nodeSpawn } from "node:child_process";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { adaptMessagePort, createPtyService, type PtyChild, type PtyExit, type SpawnFn, type SpawnRequest } from "@axis/pty-process";
import type { ControlPortLike } from "../src/bindings/pty-control.js";
import { createPtyControlSlot } from "../src/bindings/pty-control.js";
import type { PtyPort, PtyRelayPort } from "../src/ports/pty.js";

/** A plain child process in its own process group, shaped as the pty service's child. */
const plainSpawn: SpawnFn = (req: SpawnRequest): PtyChild => {
  const cp = nodeSpawn(req.argv[0] as string, req.argv.slice(1), { cwd: req.cwd, env: { ...req.env }, detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  if (cp.pid === undefined) throw new Error("spawn failed");
  const exits = new Set<(e: PtyExit) => void>();
  cp.stdin.on("error", () => undefined);
  cp.on("error", () => undefined);
  cp.once("exit", (exitCode, signal) => exits.forEach((l) => l({ exitCode, signal })));
  return {
    pid: cp.pid,
    group: { kind: "pgid", pgid: cp.pid },
    write: (d) => void cp.stdin.write(d),
    pendingWrite: () => cp.stdin.writableLength,
    pendingEntries: () => (cp.stdin.writableLength > 0 ? 1 : 0),
    resize: () => undefined,
    kill: (s) => void cp.kill(s),
    onData: () => ({ dispose: () => undefined }),
    onExit: (l) => (exits.add(l), { dispose: () => void exits.delete(l) }),
  };
};

/** The daemon's end of the channel, shaped like Electron's `MessagePortMain` (what the control slot attaches). */
function electronEnd(port: MessageChannel["port1"]): ControlPortLike {
  const wrapped = new Map<unknown, (data: unknown) => void>();
  const end = {
    on(event: string, listener: (arg: never) => void) {
      if (event === "message") {
        const w = (data: unknown): void => (listener as (e: unknown) => void)({ data, ports: [] });
        wrapped.set(listener, w);
        port.on("message", w);
      } else port.on("close", listener as () => void);
      return end;
    },
    removeListener(event: string, listener: (arg: never) => void) {
      port.removeListener(event, (event === "message" ? wrapped.get(listener) : listener) as () => void);
      return end;
    },
    postMessage: (m: unknown) => port.postMessage(m),
    start: () => port.start(),
    close: () => port.close(),
  };
  return end as unknown as ControlPortLike;
}

/**
 * The slot's port, attached to an in-process pty service hosting endpoints under `<runtime>/axis`. Only spawning and the relay are
 * exposed: the slice keeps its local `pty` git runner (a port with `exec` must not be given one as well).
 */
export function endpointSlicePty(runtime: string): PtyPort & PtyRelayPort {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("endpointSlicePty: Unix only");
  const { port1, port2 } = new MessageChannel();
  const service = createPtyService({ spawn: plainSpawn, messagesEndpoints: { dir: join(runtime, "axis"), platform: process.platform, uid } });
  service.serveControl(adaptMessagePort(port2 as never, { shape: "node" }));
  const slot = createPtyControlSlot();
  slot.attach(electronEnd(port1));
  process.once("exit", () => {
    slot.dispose();
    service.dispose();
  });
  const port = slot.port;
  return { spawn: (spec) => port.spawn(spec), onRelay: (h) => port.onRelay(h), relay: (m) => port.relay(m) };
}
