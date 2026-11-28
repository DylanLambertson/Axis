// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// OS-3h case (c) with a REAL transfer (node:worker_threads): the pty entry runs in a worker, its control port is transferred to
// it. Once transferred, closing main's own reference disconnects nothing; only the receiver's expiry closes the channel. Mutant it
// kills: X1 an unconfirmed generation left open in the receiver (main cannot close it from its side).
import assert from "node:assert/strict";
import { MessageChannel, Worker } from "node:worker_threads";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("a transferred control port survives main closing its reference, and closes at the receiver's expiry", async () => {
  const worker = new Worker(fileURLToPath(new URL("../testing/expiry-worker.js", import.meta.url)));
  try {
    const notes: unknown[] = [];
    let fired = false;
    worker.on("message", (m: { note?: unknown; fired?: boolean }) => (m.note !== undefined ? notes.push(m.note) : (fired = m.fired === true)));
    const { port1, port2 } = new MessageChannel();
    let closed = false;
    port1.on("close", () => void (closed = true));
    worker.postMessage({ data: { type: "pty-control", generation: 1 }, port: port2 }, [port2]);
    for (let i = 0; i < 500 && notes.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    assert.deepEqual(notes, [{ type: "pty-control-adopted", generation: 1 }], "adopted and acknowledged in the worker");
    port2.close(); // main's own reference: transferred, so this closes nothing
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(closed, false, "closing main's reference after the transfer disconnects nothing");
    worker.postMessage({ fire: true });
    for (let i = 0; i < 500 && !closed; i++) await new Promise((r) => setTimeout(r, 2));
    assert.equal(fired, true);
    assert.equal(closed, true, "X1: the receiver's expiry closed the channel");
  } finally {
    await worker.terminate();
  }
});
