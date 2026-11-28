// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// OS-3h, the pty entry's side of the acknowledged control hand-over (docs/design/own-shell-main-seam.md §3a), over REAL
// transferable MessagePorts. Mutants each test kills: E1 a generation adopted without its acknowledgement; E2 an older or equal
// generation adopted; E3 a bad shape (generation 0, 1.5, a string, an extra key) adopted; E4 an unconfirmed generation left open
// past its expiry, or a confirmed one closed by it; E5 a close instruction not closing the held generation, or not answered;
// E6 the legacy shape acknowledged or given an expiry; E7 a newer generation not retiring the old channel.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PTY_CONTROL_EXPIRY_MS, runPtyEntry, type MessagePortLike, type PtyEntryDeps } from "../src/index.js";
import { pipeSpawn, settle, until } from "../testing/helpers.js";
import { electronShaped, nodePair } from "../testing/ports.js";

type ParentListener = (event: { data: unknown; ports?: readonly MessagePortLike[] }) => void;

function harness(over: Partial<PtyEntryDeps> = {}) {
  let listener: ParentListener | undefined;
  const posted: unknown[] = [];
  const queue: Array<{ fn: () => void; at: number; id: number }> = [];
  let now = 0;
  let id = 0;
  const entry = runPtyEntry({
    parentPort: { on: (_e, l) => void (listener = l), removeListener: () => void (listener = undefined), postMessage: (m) => void posted.push(m) },
    process: { exit: () => undefined, on: () => undefined, removeListener: () => undefined },
    env: {},
    execArgv: [],
    spawn: pipeSpawn([]),
    stderr: () => undefined,
    timers: { set: (fn, ms) => (queue.push({ fn, at: now + ms, id: ++id }), id), clear: (h) => void queue.splice(queue.findIndex((q) => q.id === h) >>> 0, queue.some((q) => q.id === h) ? 1 : 0) },
    ...over,
  });
  return {
    entry,
    posted,
    send: (data: unknown, ports: readonly MessagePortLike[] = []) => listener?.({ data, ports }),
    advance: (ms: number) => {
      now += ms;
      for (const q of [...queue].sort((a, b) => a.at - b.at)) if (q.at <= now && queue.includes(q)) (queue.splice(queue.indexOf(q), 1), q.fn());
    },
  };
}

/** A real channel; `closed()` turns true once the peer of the end we handed over sees the close. */
function control() {
  const pair = nodePair();
  let closed = false;
  pair.a.on("close", () => void (closed = true));
  return { pair, port: electronShaped(pair.b), closed: () => closed };
}

test("a generation is adopted and acknowledged; a confirmed one stays open past the expiry", async () => {
  const h = harness();
  const c = control();
  h.send({ type: "pty-control", generation: 1 }, [c.port]);
  assert.deepEqual(h.posted, [{ type: "pty-control-adopted", generation: 1 }], "E1");
  h.send({ type: "pty-control-confirmed", generation: 1 });
  h.advance(PTY_CONTROL_EXPIRY_MS * 2);
  await settle();
  assert.equal(c.closed(), false, "E4: confirmed, kept");
  h.entry.dispose();
  c.pair.a.close();
});

test("an unconfirmed generation closes itself at its expiry", async () => {
  const h = harness();
  const c = control();
  h.send({ type: "pty-control", generation: 3 }, [c.port]);
  h.advance(PTY_CONTROL_EXPIRY_MS - 1);
  await settle();
  assert.equal(c.closed(), false);
  h.advance(1);
  await until(() => c.closed());
  assert.equal(c.closed(), true, "E4: expired and closed");
  h.entry.dispose();
});

test("an older or equal generation, and every bad shape, is closed unadopted and unanswered", async () => {
  const h = harness();
  const first = control();
  h.send({ type: "pty-control", generation: 5 }, [first.port]);
  h.posted.length = 0;
  const shapes: unknown[] = [
    { type: "pty-control", generation: 5 },
    { type: "pty-control", generation: 4 },
    { type: "pty-control", generation: 0 },
    { type: "pty-control", generation: 1.5 },
    { type: "pty-control", generation: "9" },
    { type: "pty-control", generation: 9, extra: 1 },
  ];
  const refused = shapes.map(() => control());
  shapes.forEach((s, i) => h.send(s, [refused[i]!.port]));
  await until(() => refused.every((r) => r.closed()));
  assert.deepEqual(h.posted, [], "E2/E3: nothing acknowledged");
  assert.equal(first.closed(), false, "E2/E3: the held generation is untouched");
  h.entry.dispose();
});

test("a newer generation retires the old channel, even before the old one's close", async () => {
  const h = harness();
  const g1 = control();
  const g2 = control();
  h.send({ type: "pty-control", generation: 1 }, [g1.port]);
  h.send({ type: "pty-control", generation: 2 }, [g2.port]);
  await until(() => g1.closed());
  assert.equal(g1.closed(), true, "E7: the old channel ended");
  assert.equal(g2.closed(), false, "the newer one serves");
  assert.deepEqual(h.posted, [{ type: "pty-control-adopted", generation: 1 }, { type: "pty-control-adopted", generation: 2 }]);
  h.entry.dispose();
});

test("a close instruction closes the held generation and is always answered", async () => {
  const h = harness();
  const c = control();
  h.send({ type: "pty-control", generation: 7 }, [c.port]);
  h.posted.length = 0;
  h.send({ type: "pty-control-close", generation: 6 });
  assert.deepEqual(h.posted, [{ type: "pty-control-closed", generation: 6 }], "E5: an unknown generation is answered too");
  await settle();
  assert.equal(c.closed(), false, "E5: and changes nothing");
  h.send({ type: "pty-control-close", generation: 7 });
  await until(() => c.closed());
  assert.deepEqual(h.posted.at(-1), { type: "pty-control-closed", generation: 7 }, "E5");
  h.send({ type: "pty-control-close", generation: 7 });
  assert.deepEqual(h.posted.at(-1), { type: "pty-control-closed", generation: 7 }, "E5: idempotent");
  h.entry.dispose();
});

test("the legacy shape without a generation is adopted, never acknowledged, never expired", async () => {
  const h = harness();
  const c = control();
  h.send({ type: "pty-control" }, [c.port]);
  h.advance(PTY_CONTROL_EXPIRY_MS * 3);
  await settle();
  assert.deepEqual(h.posted, [], "E6");
  assert.equal(c.closed(), false, "E6");
  h.entry.dispose();
});
