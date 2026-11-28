// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// OS-3h (docs/design/own-shell-main-seam.md §3a): a newer control channel wins. Mutants each test kills: L1 a replacement refused
// while the old channel is still registered (the design review's reproduction: neither end is then left with a channel); L2 the
// old channel kept open or its terminals left running after a replacement (a shell no daemon owns).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPtyProcessPort, createPtyService } from "../src/index.js";
import { channelPair, counterRandom, FakeChild, FakeProcs, settle } from "../testing/helpers.js";
import { SPEC } from "../testing/rig.js";

test("a replacement delivered before the old channel's close is adopted; the old channel and its terminals end", async () => {
  const procs = new FakeProcs();
  const children = [new FakeChild(201), new FakeChild(202)];
  for (const c of children) procs.live.add(c.pid);
  let next = 0;
  const svc = createPtyService({ spawn: () => children[next++]!, ops: procs, randomBytes: counterRandom() });
  const first = channelPair();
  svc.serveControl(first.b);
  const port1 = createPtyProcessPort({ channel: first.a, ops: procs });
  const h1 = await port1.spawn(SPEC);
  assert.ok(h1.terminalId);
  let firstClosed = false;
  first.a.onClose(() => void (firstClosed = true));

  // The replacement arrives while the old channel is still registered (its close event has not happened).
  const second = channelPair();
  svc.serveControl(second.b);
  await settle();
  assert.equal(firstClosed, true, "L2: the old channel was closed by the service");
  assert.ok(procs.calls.some(([pid]) => pid === -201), "L2: the old channel's terminal was ended");

  const port2 = createPtyProcessPort({ channel: second.a, ops: procs });
  const h2 = await port2.spawn(SPEC);
  assert.ok(h2.terminalId, "L1: the replacement serves");
  svc.dispose();
});
