// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// OS-3h case (b), over real MessageChannel ports in ONE thread (no transfer: the worker version below transfers): the pty receiver adopts every generation but
// withholds both its acknowledgement and its close confirmation. After the final failure no endpoint may stay usable and nothing
// may stay queued: the daemon's pending call settles channel_closed, and a message sent on the daemon's end reaches nobody.
// Mutant it kills: R1 a failed hand-over that only drops main's references (a transferred port stays connected).
import assert from "node:assert/strict";
import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
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

test("one thread: a receiver that adopts but never acknowledges or confirms a close is torn down; nothing stays usable or queued", async () => {
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

test("REAL transfer: a worker that adopts but never answers is torn down; main's own references never could disconnect it", async () => {
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
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const worker = new Worker(fileURLToPath(new URL("../testing/withhold-worker.js", import.meta.url)));
  const count = async (): Promise<number> => {
    const got = new Promise<number>((res) => worker.once("message", (m: { received: number }) => res(m.received)));
    worker.postMessage({ count: true });
    return got;
  };
  let terminated = false;
  const transferred: MessagePort[] = [];
  const ptyChild = {
    postMessage: (m: unknown, transfer?: readonly unknown[]) => {
      const port = transfer?.[0] as MessagePort | undefined;
      if (port === undefined) worker.postMessage({ data: m });
      else {
        transferred.push(port);
        worker.postMessage({ data: m, port }, [port]);
      }
    },
  };
  const slot = createPtyControlSlot();
  let handover: AckedHandover<MessagePort>;
  let daemonEnd: MessagePort | undefined;
  const daemonChild = {
    postMessage: (m: unknown, transfer?: readonly unknown[]) => {
      const msg = m as { type: string; generation: number };
      if (msg.type === "pty-control" && transfer?.length === 1) {
        daemonEnd = transfer[0] as MessagePort;
        slot.attach(electronShaped(daemonEnd));
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
      if (side === "pty") void worker.terminate().then(() => void (terminated = true));
    },
    onFailed: () => void (failed = true),
  });
  try {
    handover.pty(ptyChild, true);
    handover.daemon(daemonChild, true);
    await settle();
    // Main "closes" its reference to the port it transferred: that end now belongs to the worker, so nothing is disconnected.
    for (const p of transferred) p.close();
    const pending = slot.port.exec(CALL).then(
      () => "answered",
      (e: { code?: string }) => e.code ?? "rejected",
    );
    daemonEnd?.postMessage({ probe: 1 }); // straight down the channel, past the slot's own protocol
    // The probe and the count travel on different ports, so nothing orders them: ask until the probe is seen (bounded).
    let seen = 0;
    for (let i = 0; i < 100 && seen === 0; i++) {
      await settle();
      seen = await count();
    }
    assert.ok(seen >= 1, "the worker still receives on the transferred port after main closed its reference");
    for (let g = 0; g < 3; g++) {
      advance(DEFAULT_HANDOVER_ACK_MS);
      await settle();
      advance(DEFAULT_HANDOVER_CLOSE_MS);
      await settle();
    }
    assert.equal(failed, true, "handover_failed");
    for (let i = 0; i < 200 && !terminated; i++) await settle();
    assert.equal(terminated, true, "the withholding worker was torn down: every endpoint it held ended with it");
    assert.equal(await pending, "channel_closed", "the daemon's pending call settled; nothing stays queued");
    await assert.rejects(slot.port.exec(CALL), "nothing stays usable");
  } finally {
    handover.dispose();
    slot.dispose();
    await worker.terminate();
  }
});
