// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// OS-3h: main's acknowledged pty control hand-over (src/main/pty-handover-acked.ts), with fake children and a virtual clock.
// Mutants each test kills: A1 a hand-over counted as done before both acknowledged; A2 an acknowledgement for another generation
// (stale, future, or never sent) accepted; A3 no retry after a missing acknowledgement, or more than three; A4 no close
// instruction to the receivers, or no teardown when a close goes unanswered; A5 no handover_failed after the last generation; A6
// a post that throws leaking the other side's port, or not counted; A7 a child's exit leaving its timers or round running; A8 the
// confirmation not sent to both.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AckedHandover, DEFAULT_HANDOVER_ACK_MS, DEFAULT_HANDOVER_CLOSE_MS, type AckedHandoverChild, type HandoverSide } from "../src/main/pty-handover-acked.js";

class Child implements AckedHandoverChild {
  readonly got: Array<{ message: Record<string, unknown>; ports: number }> = [];
  throwOnPort = false;
  postMessage(message: unknown, transfer?: readonly unknown[]): void {
    if (this.throwOnPort && transfer !== undefined) throw new Error("closed");
    this.got.push({ message: message as Record<string, unknown>, ports: transfer?.length ?? 0 });
  }
  of(type: string): number[] {
    return this.got.filter((g) => g.message["type"] === type).map((g) => g.message["generation"] as number);
  }
}

function rig() {
  let now = 0;
  let id = 0;
  const q: Array<{ at: number; fn: () => void; id: number }> = [];
  const opened: number[] = [];
  const closedPorts: number[] = [];
  let port = 0;
  const events: string[] = [];
  const teardowns: HandoverSide[] = [];
  let failed = 0;
  const h = new AckedHandover<number>({
    createChannel: () => {
      const a = ++port;
      const b = ++port;
      opened.push(a, b);
      return { port1: a, port2: b };
    },
    closePort: (p) => void closedPorts.push(p),
    timers: { set: (fn, ms) => (q.push({ at: now + ms, fn, id: ++id }), id), clear: (t) => void q.splice(q.findIndex((x) => x.id === t) >>> 0, q.some((x) => x.id === t) ? 1 : 0) },
    teardown: (side) => void teardowns.push(side),
    onFailed: () => void failed++,
    onEvent: (e, f) => void events.push(`${e}${f.generation === undefined ? "" : ` ${f.generation}`}${f.side === undefined ? "" : ` ${f.side}`}`),
  });
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
  return { h, advance, events, teardowns, failed: () => failed, closedPorts, pending: () => q.length };
}

test("both acknowledged: confirmed to both, done", () => {
  const r = rig();
  const p = new Child();
  const d = new Child();
  r.h.pty(p, true);
  r.h.daemon(d, true);
  assert.deepEqual(p.of("pty-control"), [1]);
  assert.deepEqual(d.of("pty-control"), [1]);
  r.h.adopted("pty", 1);
  assert.equal(r.events.includes("handed_over 1"), false, "A1: one acknowledgement is not done");
  r.h.adopted("daemon", 1);
  assert.ok(r.events.includes("handed_over 1"), "A1");
  assert.deepEqual([p.of("pty-control-confirmed"), d.of("pty-control-confirmed")], [[1], [1]], "A8");
  r.advance(DEFAULT_HANDOVER_ACK_MS * 3);
  assert.deepEqual(p.of("pty-control"), [1], "no retry after success");
});

test("an acknowledgement for any other generation is ignored, including one main never sent", () => {
  const r = rig();
  const p = new Child();
  const d = new Child();
  r.h.pty(p, true);
  r.h.daemon(d, true);
  for (const g of [0, 2, 99]) {
    r.h.adopted("pty", g);
    r.h.adopted("daemon", g);
  }
  assert.equal(r.events.some((e) => e.startsWith("handed_over")), false, "A2");
  assert.deepEqual(p.of("pty-control-confirmed"), [], "A2: nothing confirmed");
});

test("a missing acknowledgement: closed at both receivers, then the next generation; three at most, then handover_failed", () => {
  const r = rig();
  const p = new Child();
  const d = new Child();
  r.h.pty(p, true);
  r.h.daemon(d, true);
  for (let g = 1; g <= 3; g++) {
    r.h.adopted("daemon", g); // the pty process never answers
    r.advance(DEFAULT_HANDOVER_ACK_MS);
    assert.deepEqual(p.of("pty-control-close").at(-1), g, `A4: close G${g} to the pty process`);
    assert.deepEqual(d.of("pty-control-close").at(-1), g, `A4: and to the daemon`);
    r.h.closed("pty", g);
    r.h.closed("daemon", g);
  }
  assert.deepEqual(p.of("pty-control"), [1, 2, 3], "A3: exactly three generations");
  assert.ok(r.events.includes("handover_failed 3"), "A5");
  assert.equal(r.failed(), 1, "A5");
  assert.deepEqual(r.teardowns, [], "every close was answered: no teardown");
});

test("a close that goes unanswered tears that child down", () => {
  const r = rig();
  const p = new Child();
  const d = new Child();
  r.h.pty(p, true);
  r.h.daemon(d, true);
  r.advance(DEFAULT_HANDOVER_ACK_MS);
  r.h.closed("daemon", 1); // only the daemon answers the close
  r.advance(DEFAULT_HANDOVER_CLOSE_MS);
  assert.deepEqual(r.teardowns, ["pty"], "A4");
});

test("a post that throws closes the unposted port and the other side's, and counts as a failed generation", () => {
  const r = rig();
  const p = new Child();
  const d = new Child();
  d.throwOnPort = true;
  r.h.pty(p, true);
  r.h.daemon(d, true);
  assert.ok(r.closedPorts.includes(2), "A6: the daemon's port (2) was never posted: closed, not leaked");
  assert.deepEqual(p.of("pty-control-close")[0], 1, "A6: the port the pty process holds is retired there");
  assert.deepEqual(p.of("pty-control"), [1, 2, 3], "A6: counted, retried, three at most");
  assert.ok(r.events.includes("handover_failed 3"));
  const p2 = new Child();
  p2.throwOnPort = true;
  const r2 = rig();
  r2.h.pty(p2, true);
  r2.h.daemon(new Child(), true);
  assert.ok(r2.closedPorts.includes(1) && r2.closedPorts.includes(2), "A6: a throw at the pty side closes both ports");
});

test("a child's exit ends the round and cancels its timers; the next start begins a new round", () => {
  const r = rig();
  const p = new Child();
  const d = new Child();
  r.h.pty(p, true);
  r.h.daemon(d, true);
  r.h.daemon(d, false);
  assert.equal(r.h.inFlight(), undefined, "A7");
  r.h.closed("pty", 1);
  r.advance(DEFAULT_HANDOVER_ACK_MS * 4);
  assert.deepEqual(p.of("pty-control"), [1], "A7: no retry while a side is down");
  assert.equal(r.failed(), 0);
  const d2 = new Child();
  r.h.daemon(d2, true);
  assert.deepEqual(d2.of("pty-control"), [2], "a new round with the next generation");
  r.h.adopted("pty", 1);
  r.h.adopted("daemon", 1);
  assert.equal(r.events.some((e) => e === "handed_over 1"), false, "A2: the old round's generation is stale");
  r.h.adopted("pty", 2);
  r.h.adopted("daemon", 2);
  assert.ok(r.events.includes("handed_over 2"));
});
