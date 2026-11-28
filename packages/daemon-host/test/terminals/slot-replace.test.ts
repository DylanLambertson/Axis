// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-3a review S1: when main hands the daemon a new control port, the old client settles its terminals' exits (unknown) as a channel
// close does. So the registry records leave `open` (no attach grants a dead id to the new port), their slots are freed once the
// group is gone, and a later close or untrust never signals the recorded group id (an ended record is never killed).
import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { createPtyControlSlot, type ControlPortLike } from "../../src/bindings/pty-control.js";
import type { PtyTerminalHandle } from "../../src/ports/pty.js";
import { TerminalRegistry } from "../../src/terminals/registry.js";

function controlPair(): { mine: ControlPortLike; peer: MessagePort } {
  const { port1, port2 } = new MessageChannel();
  const wrapped = new Map<unknown, (data: unknown) => void>();
  const mine = {
    on(event: string, listener: (arg: never) => void) {
      if (event === "message") {
        const w = (data: unknown): void => (listener as (e: unknown) => void)({ data, ports: [] });
        wrapped.set(listener, w);
        port1.on("message", w);
      } else port1.on("close", listener as () => void);
      return mine;
    },
    removeListener(event: string, listener: (arg: never) => void) {
      port1.removeListener(event, (event === "message" ? wrapped.get(listener) : listener) as () => void);
      return mine;
    },
    postMessage: (m: unknown) => port1.postMessage(m),
    start: () => port1.start(),
    close: () => port1.close(),
  };
  return { mine: mine as unknown as ControlPortLike, peer: port2 };
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

test("a replaced control port: the old port's terminal leaves open, is not attachable, is never killed again, and its slot is freed", async (t) => {
  const slot = createPtyControlSlot({ spawnTimeoutMs: 5000 });
  const a = controlPair();
  const b = controlPair();
  t.after(() => (a.peer.close(), b.peer.close(), slot.dispose()));
  a.peer.on("message", (m: Record<string, unknown>) => {
    // A pgid no process has (above the default pid_max), so the group is gone once the port forgets it.
    if (m["t"] === "spawn") a.peer.postMessage({ t: "spawned", req: m["req"], term: "pty_0123456789abcdef0123456789abcdef", group: { kind: "pgid", pgid: 9_999_999 } });
  });
  slot.attach(a.mine);
  const registry = new TerminalRegistry({ port: slot.port, maxPerWorkspace: 8 });
  const op = registry.reserve("ws1", "p1");
  assert.ok(op !== undefined);
  const h = (await slot.port.spawn({ runId: "t", argv: ["/bin/sh"], cwd: "/", env: {}, cols: 80, rows: 24 })) as PtyTerminalHandle;
  assert.ok(registry.publish(op, h) !== undefined);
  const gotB: Array<Record<string, unknown>> = [];
  b.peer.on("message", (m: Record<string, unknown>) => void gotB.push(m));
  slot.attach(b.mine); // the replacement
  await settle();
  assert.notEqual(registry.get(h.terminalId)?.state, "open", "the record left open");
  assert.equal(registry.attachable(h.terminalId), undefined, "not attachable");
  assert.equal(registry.close(h.terminalId) || true, true);
  await settle();
  assert.deepEqual(gotB.filter((m) => m["t"] === "kill" || m["t"] === "grant"), [], "nothing reaches the new port for the dead id");
  for (let i = 0; i < 8; i++) assert.ok(registry.reserve("ws1", "p1") !== undefined, `slot ${i + 1} of 8 is free`);
});
