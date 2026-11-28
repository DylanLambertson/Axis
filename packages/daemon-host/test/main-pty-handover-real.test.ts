// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// OS-3h case (b), over REAL transferable ports (node:worker_threads MessageChannel): the pty receiver adopts every generation but
// withholds both its acknowledgement and its close confirmation. After the final failure no endpoint may stay usable and nothing
// may stay queued: the daemon's pending call settles channel_closed, and a message sent on the daemon's end reaches nobody.
// Mutant it kills: R1 a failed hand-over that only drops main's references (a transferred port stays connected).
import assert from "node:assert/strict";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { test } from "node:test";
import { createPtyControlSlot, type ControlPortLike } from "../src/bindings/pty-control.js";
import { AckedHandover, DEFAULT_HANDOVER_ACK_MS, DEFAULT_HANDOVER_CLOSE_MS } from "../src/main/pty-handover-acked.js";

/** A valid exec call with a long timeout: only the channel's close can settle it during the test. */
const CALL = { argv: ["status"], cwd: "/w", env: {}, timeoutMs: 3_600_000, maxOutput: 1024, repo: { gitDir: "/w/.git", workTree: "/w" } };

function electronShaped(port: MessagePort): ControlPortLike {
  const wrapped = new Map<unknown, (data: unknown) => void>();
  return {
    on(event: "message" | "close", listener: (arg: never) => void) {
      if (event === "message") {
        const w = (data: unknown): void => (listener as (e: unknown) => void)({ data, ports: [] });
        wrapped.set(listener, w);
        return port.on("message", w);
      }
      return port.on("close", listener as () => void);
    },
    removeListener(event: "message" | "close", listener: (arg: never) => void) {
      return port.removeListener(event, (event === "message" ? wrapped.get(listener) : listener) as () => void);
    },
    postMessage: (m: unknown) => port.postMessage(m),
    close: () => port.close(),
    start: () => port.start(),
  } as ControlPortLike;
}

test("a receiver that adopts but never acknowledges or confirms a close is torn down; nothing stays usable or queued", async () => {
  let now = 0;
  let id = 0;
  const q: Array<{ at: number; fn: () => void; id: number }> = [];
  const advance = (ms: number) => {
    now += ms;
    for (;;) {
      q.sort((a, b) => a.at - b.at);
      const t = q[0];
      if (t === undefined || t.at > now) return;
      q.shift();
      t.fn();
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 10));

  // The pty side: keeps every port it is given, answers nothing. Its teardown (its process ending) closes them all.
  const ptyHeld: MessagePort[] = [];
  const ptyGot: string[] = [];
  let ptyAlive = true;
  const delivered: unknown[] = [];
  const ptyChild = {
    postMessage: (m: unknown, transfer?: readonly unknown[]) => {
      ptyGot.push((m as { type: string }).type);
      for (const p of transfer ?? []) {
        const port = p as MessagePort;
        port.on("message", (data) => void delivered.push(data));
        ptyHeld.push(port);
      }
    },
  };
  // The daemon side: a real control slot that adopts, acknowledges, and drops a generation on a close instruction.
  const slot = createPtyControlSlot();
  let handover: AckedHandover<MessagePort>;
  const daemonChild = {
    postMessage: (m: unknown, transfer?: readonly unknown[]) => {
      const msg = m as { type: string; generation: number };
      if (msg.type === "pty-control" && transfer?.length === 1) {
        slot.attach(electronShaped(transfer[0] as MessagePort));
        queueMicrotask(() => handover.adopted("daemon", msg.generation));
      } else if (msg.type === "pty-control-close") {
        slot.detach();
        queueMicrotask(() => handover.closed("daemon", msg.generation));
      }
    },
  };
  let failed = false;
  handover = new AckedHandover<MessagePort>({
    createChannel: () => new MessageChannel(),
    closePort: (p) => p.close(),
    timers: { set: (fn, ms) => (q.push({ at: now + ms, fn, id: ++id }), id), clear: (t) => void q.splice(q.findIndex((x) => x.id === t) >>> 0, q.some((x) => x.id === t) ? 1 : 0) },
    teardown: (side) => {
      if (side !== "pty") return;
      ptyAlive = false;
      for (const p of ptyHeld) p.close(); // the process ends: every endpoint it held goes with it
    },
    onFailed: () => void (failed = true),
  });
  handover.pty(ptyChild, true);
  handover.daemon(daemonChild, true);
  await settle();

  // A call the daemon makes on the adopted channel; the pty side never answers it.
  const pending = slot.port.exec(CALL).then(
    () => "answered",
    (e: { code?: string; message?: string }) => e.code ?? `rejected: ${e.message}`,
  );
  for (let g = 0; g < 3; g++) {
    advance(DEFAULT_HANDOVER_ACK_MS);
    await settle();
    advance(DEFAULT_HANDOVER_CLOSE_MS);
    await settle();
  }
  assert.equal(failed, true, "the hand-over failed after three generations");
  assert.equal(ptyAlive, false, "R1: the withholding receiver was torn down");
  assert.equal(await pending, "channel_closed", "R1: the daemon's pending call settled, nothing stays queued");
  assert.equal(slot.attached(), true, "the slot was attached once");
  const before = delivered.length;
  await assert.rejects(slot.port.exec(CALL), "no channel: fails closed at once");
  await settle();
  assert.equal(delivered.length, before, "R1: nothing reaches the old receiver");
  assert.ok(ptyGot.includes("pty-control-close"), "close instructions were sent");
  handover.dispose();
  slot.dispose();
});
