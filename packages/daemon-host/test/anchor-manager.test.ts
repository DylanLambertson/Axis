// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChainHead } from "@axis/audit";
import { DaemonError } from "@axis/daemon";
import { AnchorManager, Disposables, type AnchorManagerOptions } from "../src/index.js";

const hash = (seq: number): string => seq.toString(16).padStart(64, "0");
const headOf = (seq: number): ChainHead => ({ seq, hash: hash(seq) });

/** A fake audit log whose head the test moves, and a fake supervisor link that records every put. */
function rig(over: Partial<AnchorManagerOptions> = {}) {
  let t = 1_000;
  const state = { seq: 0, checkpointThrows: false, headThrows: false, putThrows: false };
  const puts: ChainHead[] = [];
  const appended: Array<{ action: string; payload: unknown }> = [];
  const disposables = new Disposables();
  const manager = new AnchorManager({
    clock: { monotonic: () => t },
    audit: {
      head: () => {
        if (state.headThrows) throw new Error("boom");
        return state.seq === 0 ? null : headOf(state.seq);
      },
      checkpoint: () => {
        if (state.checkpointThrows) throw new Error("boom");
        return state.seq === 0 ? null : headOf(state.seq);
      },
      append: (e) => void appended.push({ action: e.action, payload: e.payload }),
    },
    put: (h) => {
      if (state.putThrows) throw new Error("closed");
      puts.push(h);
    },
    baseline: null,
    writable: true,
    disposables,
    maxLagEvents: 3,
    maxAgeMs: 1000,
    coalesceMs: 500,
    ...over,
  });
  const write = (n = 1): void => {
    state.seq += n;
    manager.noteWrite();
  };
  return { manager, state, puts, appended, disposables, write, advance: (ms: number) => void (t += ms) };
}

function refusal(fn: () => void): DaemonError | undefined {
  try {
    fn();
  } catch (e) {
    return e as DaemonError;
  }
  return undefined;
}

test("lag boundary: exactly the limit is served, one more events stalls tier 3 and above", () => {
  const r = rig();
  r.write(3);
  assert.equal(r.manager.status().lag, 3);
  assert.equal(r.manager.status().stalled, false);
  assert.equal(refusal(() => r.manager.check(4)), undefined);
  r.write(1);
  assert.equal(r.manager.status().lag, 4);
  assert.equal(r.manager.status().stalled, true);
  const e = refusal(() => r.manager.check(3));
  assert.ok(e instanceof DaemonError);
  assert.equal(e.code, "E_UNAVAILABLE");
  assert.equal(e.message, "The audit anchor is not being acknowledged.");
  assert.deepEqual(e.details, { reason: "anchor_stalled" });
});

test("age boundary: exactly the limit is served, one millisecond more stalls", () => {
  const r = rig({ maxLagEvents: 1000 });
  r.write(1); // put at t=1000
  r.advance(1000);
  assert.equal(r.manager.status().oldestUnackedAgeMs, 1000);
  assert.equal(r.manager.status().stalled, false);
  assert.equal(refusal(() => r.manager.check(3)), undefined);
  r.advance(1);
  assert.equal(r.manager.status().stalled, true);
  assert.equal(refusal(() => r.manager.check(3))?.code, "E_UNAVAILABLE");
});

test("a stalled host still serves tier 0 to 2 and refuses 3, 4 and 5; it resumes when the ack arrives", () => {
  const r = rig();
  r.write(1);
  r.advance(1001);
  for (const tier of [0, 1, 2]) assert.equal(refusal(() => r.manager.check(tier)), undefined, `tier ${tier}`);
  for (const tier of [3, 4, 5]) assert.equal(refusal(() => r.manager.check(tier))?.code, "E_UNAVAILABLE", `tier ${tier}`);
  assert.equal(r.manager.ack(1), true);
  assert.equal(r.manager.status().stalled, false);
  assert.equal(r.manager.status().oldestUnackedAgeMs, null);
  for (const tier of [3, 4, 5]) assert.equal(refusal(() => r.manager.check(tier)), undefined);
});

test("each transition is audited once, not once per request", () => {
  const r = rig();
  r.write(4);
  for (let i = 0; i < 10; i++) r.manager.check(2);
  for (let i = 0; i < 10; i++) refusal(() => r.manager.check(3));
  assert.deepEqual(r.appended.map((a) => a.action), ["anchor.stalled"]);
  assert.deepEqual(r.appended[0]?.payload, { reason: "anchor_stalled" });
  r.manager.ack(4);
  r.manager.status();
  r.manager.status();
  assert.deepEqual(r.appended.map((a) => a.action), ["anchor.stalled", "anchor.resumed"]);
});

test("the stall cannot be lifted by an ack that is stale, repeated, out of order or for something never put", () => {
  const r = rig({ maxLagEvents: 1000 });
  r.write(1);
  r.advance(600);
  r.write(1);
  r.advance(600);
  r.write(1);
  assert.deepEqual(r.puts.map((p) => p.seq), [1, 2, 3]);
  assert.equal(r.manager.ack(2), true);
  assert.equal(r.manager.ackedSeq, 2);
  for (const bad of [1, 2, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 4, 99, Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(r.manager.ack(bad), false, String(bad));
    assert.equal(r.manager.ackedSeq, 2, `ack ${String(bad)} moved the position`);
  }
  assert.deepEqual(r.manager.status().anchor, headOf(2));
  assert.equal(r.manager.ack(3), true);
  assert.equal(r.manager.ack(3), false);
  assert.equal(r.manager.ackedSeq, 3);
});

test("an ack for a seq between two puts covers only the puts up to it", () => {
  const r = rig({ maxLagEvents: 1000 });
  r.write(1);
  r.advance(600);
  r.write(2); // head 3
  assert.deepEqual(r.puts.map((p) => p.seq), [1, 3]);
  assert.equal(r.manager.ack(2), true);
  assert.equal(r.manager.ackedSeq, 1);
  assert.deepEqual(r.manager.status().anchor, headOf(1));
  assert.equal(r.manager.status().lag, 2);
});

test("a late ack for the startup anchor never moves back, and acks for the baseline seq are ignored", () => {
  const r = rig({ baseline: headOf(5) });
  assert.equal(r.manager.ackedSeq, 5);
  assert.equal(r.manager.ack(5), false);
  assert.equal(r.manager.ack(3), false);
  assert.deepEqual(r.manager.status().anchor, headOf(5));
});

test("puts are coalesced to one per interval, in order, and nothing is dropped", () => {
  const r = rig({ maxLagEvents: 1000 });
  r.write(1);
  r.write(1);
  r.write(1);
  assert.deepEqual(r.puts.map((p) => p.seq), [1], "writes inside the interval wait");
  r.advance(500);
  r.manager.tick();
  assert.deepEqual(r.puts.map((p) => p.seq), [1, 3]);
  r.write(2);
  r.advance(500);
  r.manager.tick();
  r.manager.tick();
  assert.deepEqual(r.puts.map((p) => p.seq), [1, 3, 5], "an idle tick sends nothing new");
});

test("a put that fails is retried by the tick and the age keeps growing until it goes out", () => {
  const r = rig({ maxLagEvents: 1000 });
  r.state.putThrows = true;
  r.write(1);
  assert.equal(r.puts.length, 0);
  r.advance(1001);
  assert.equal(r.manager.status().stalled, true, "an unsent head ages like an unacknowledged one");
  r.state.putThrows = false;
  r.manager.tick();
  assert.deepEqual(r.puts.map((p) => p.seq), [1]);
  r.manager.ack(1);
  assert.equal(r.manager.status().stalled, false);
});

test("memory is bounded without a single ack: the waiting list is capped and the oldest entry keeps its time", () => {
  const r = rig({ maxLagEvents: 1_000_000, maxAgeMs: 3_600_000 });
  r.write(1);
  for (let i = 0; i < 500; i++) {
    r.advance(500);
    r.write(1);
  }
  assert.equal(r.puts.length, 501, "every head was sent, in order");
  assert.deepEqual(r.puts.map((p) => p.seq), Array.from({ length: 501 }, (_, i) => i + 1));
  assert.ok(r.manager.waiting <= 64, `waiting ${r.manager.waiting}`);
  assert.equal(r.manager.status().oldestUnackedAgeMs, 500 * 500, "age is measured from the first put");
  assert.equal(r.manager.ack(501), true);
  assert.equal(r.manager.waiting, 0);
});

test("a checkpoint that fails verification stalls tier 3 and above for good and anchors nothing", () => {
  const r = rig({ maxLagEvents: 1000 });
  r.write(1);
  r.state.checkpointThrows = true;
  r.advance(500);
  r.write(1);
  assert.equal(r.puts.length, 1);
  assert.equal(r.manager.status().stalled, true);
  assert.equal(refusal(() => r.manager.check(3))?.code, "E_UNAVAILABLE");
  assert.equal(refusal(() => r.manager.check(2)), undefined);
  r.manager.ack(1);
  assert.equal(r.manager.status().stalled, true, "an ack does not clear a broken chain");
  assert.deepEqual(r.appended, [], "a broken chain is not audited: the log is what failed");
});

test("an audit log that cannot be read stalls (fail closed)", () => {
  const r = rig();
  r.state.headThrows = true;
  assert.equal(refusal(() => r.manager.check(4))?.code, "E_UNAVAILABLE");
  assert.equal(refusal(() => r.manager.check(1)), undefined);
  r.state.headThrows = false;
  assert.equal(refusal(() => r.manager.check(4)), undefined);
});

test("a failing transition audit does not change the decision", () => {
  const r = rig({
    audit: { head: () => headOf(9), checkpoint: () => headOf(9), append: () => { throw new Error("full"); } },
  });
  assert.equal(refusal(() => r.manager.check(3))?.code, "E_UNAVAILABLE");
});

test("the wall clock is never read: a jump of a day changes nothing", () => {
  const r = rig({ maxLagEvents: 1000 });
  r.write(1);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 86_400_000;
    assert.equal(r.manager.status().stalled, false);
    assert.equal(r.manager.status().oldestUnackedAgeMs, 0);
    Date.now = () => realNow() - 86_400_000;
    assert.equal(r.manager.status().stalled, false);
  } finally {
    Date.now = realNow;
  }
});

test("the timer is unref'd, registered with the lifecycle registry and gone after dispose; nothing runs afterwards", async () => {
  const realSet = globalThis.setInterval;
  const handles: NodeJS.Timeout[] = [];
  globalThis.setInterval = ((...a: Parameters<typeof setInterval>) => {
    const h = realSet(...a);
    handles.push(h);
    return h;
  }) as typeof setInterval;
  let r: ReturnType<typeof rig>;
  try {
    r = rig();
  } finally {
    globalThis.setInterval = realSet;
  }
  assert.equal(handles.length, 1);
  assert.equal(handles[0]?.hasRef(), false, "an unref'd timer cannot keep the process alive");
  assert.equal(r.disposables.size, 2);
  r.write(1);
  assert.equal(r.puts.length, 1);
  await r.disposables.dispose();
  assert.equal(r.disposables.size, 0);
  r.advance(600);
  r.write(1);
  r.manager.tick();
  assert.equal(r.puts.length, 1, "a stopped manager sends nothing");
  assert.equal(r.manager.ack(1), false, "and a late ack changes nothing");
  assert.equal(r.manager.ackedSeq, 0);
});

test("degraded (not writable): no timer, no put, never stalled, status still reported", () => {
  const r = rig({ writable: false, baseline: headOf(2) });
  assert.equal(r.disposables.size, 0);
  r.state.seq = 10;
  r.manager.noteWrite();
  r.manager.tick();
  r.manager.flush();
  assert.equal(r.puts.length, 0);
  r.advance(10_000_000);
  assert.equal(refusal(() => r.manager.check(5)), undefined);
  const s = r.manager.status();
  assert.equal(s.stalled, false);
  assert.deepEqual(s.anchor, headOf(2));
  assert.equal(s.lag, 8);
  assert.equal(s.oldestUnackedAgeMs, null);
});

test("an empty log has no head, no lag and no age", () => {
  const r = rig();
  assert.deepEqual(r.manager.status(), { head: null, anchor: null, lag: 0, oldestUnackedAgeMs: null, stalled: false });
});

test("the age is a whole number of milliseconds even when the monotonic clock is fractional", () => {
  const r = rig({ clock: { monotonic: () => 1000.75 } });
  r.write(1);
  assert.ok(Number.isInteger(r.manager.status().oldestUnackedAgeMs));
});

test("a supervisor that acknowledges from inside put (a synchronous link) is not ignored", () => {
  let acked = false;
  const sync = rig({
    maxLagEvents: 1000,
    put: (h) => {
      acked = sync.manager.ack(h.seq);
    },
  });
  sync.write(1);
  assert.equal(acked, true, "the ack found the put");
  assert.equal(sync.manager.ackedSeq, 1);
  sync.advance(600_000);
  assert.equal(sync.manager.status().stalled, false);
  assert.equal(sync.manager.waiting, 0);
});

test("a put that throws leaves nothing waiting and the next flush sends it", () => {
  const r = rig({ maxLagEvents: 1000 });
  r.state.putThrows = true;
  r.write(1);
  assert.equal(r.manager.waiting, 0);
  assert.equal(r.manager.put, null);
  r.state.putThrows = false;
  r.manager.tick();
  assert.deepEqual(r.puts.map((p) => p.seq), [1]);
  assert.equal(r.manager.waiting, 1);
});

test("a log cut below an acknowledged position is a broken chain: tier 3 and above are refused for good", () => {
  const r = rig({ maxLagEvents: 1000 });
  r.write(3);
  r.manager.ack(3);
  assert.equal(r.manager.status().stalled, false);
  r.state.seq = 1; // the tail was deleted
  assert.equal(refusal(() => r.manager.check(3))?.code, "E_UNAVAILABLE");
  r.state.seq = 3;
  assert.equal(refusal(() => r.manager.check(3))?.code, "E_UNAVAILABLE", "it does not heal when the rows come back");
  assert.equal(refusal(() => r.manager.check(2)), undefined);
  const empty = rig({ maxLagEvents: 1000 });
  empty.write(2);
  empty.manager.ack(2);
  empty.state.seq = 0;
  assert.equal(refusal(() => empty.manager.check(4))?.code, "E_UNAVAILABLE");
});

test("an ack from inside put followed by a throwing send keeps the acknowledged head as the newest put", () => {
  let ackedInside = false;
  const r = rig({
    maxLagEvents: 1000,
    put: (h) => {
      ackedInside = r.manager.ack(h.seq);
      throw new Error("closed");
    },
  });
  r.write(1);
  assert.equal(ackedInside, true);
  assert.equal(r.manager.ackedSeq, 1);
  assert.deepEqual(r.manager.put, headOf(1), "put is never reported below the acknowledged position");
  assert.equal(r.manager.status().oldestUnackedAgeMs, null, "nothing is waiting or dirty for an acknowledged head");
});

test("a send that fails keeps the head dirty from the failed attempt even when no write was noted before", () => {
  const r = rig({ maxLagEvents: 1000 });
  r.state.seq = 2; // written by another writer; the first flush is the one that fails
  r.state.putThrows = true;
  r.manager.flush();
  assert.equal(r.manager.status().oldestUnackedAgeMs, 0, "dirty since the failed attempt");
  r.advance(1001);
  assert.equal(r.manager.status().stalled, true);
  r.state.putThrows = false;
  r.manager.tick();
  assert.deepEqual(r.puts.map((p) => p.seq), [2]);
});

test("halt (shutdown step 3): nothing is put by itself afterwards, only an explicit flush sends", async () => {
  const r = rig();
  r.write();
  assert.equal(r.puts.length, 1);
  r.manager.halt();
  r.advance(10_000);
  r.write(2); // a write notification after the halt
  r.manager.tick();
  assert.equal(r.puts.length, 1, "no put by itself after the halt");
  r.manager.flush();
  assert.deepEqual(r.puts.map((p) => p.seq), [1, 3], "the final flush still sends the newest head");
  await r.disposables.dispose();
});

test("halt: a stall that ends with the final acknowledgement appends no row after the final anchor", async () => {
  const r = rig();
  r.write(5); // lag 5 > 3: stalled, recorded once
  assert.deepEqual(r.appended.map((a) => a.action), ["anchor.stalled"]);
  r.manager.halt();
  r.manager.flush();
  const last = r.puts[r.puts.length - 1] as ChainHead;
  assert.equal(r.manager.ack(last.seq), true);
  assert.equal(r.manager.status().stalled, false, "the stall ended");
  assert.deepEqual(r.appended.map((a) => a.action), ["anchor.stalled"], "but nothing was appended after the final anchor");
  assert.equal(r.state.seq, last.seq, "the final anchor is the last row");
  await r.disposables.dispose();
});
