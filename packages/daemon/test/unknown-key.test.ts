// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type IdempotencyBegin, type IdempotencyStore } from "../src/index.js";
import { KEY1, req, rig } from "./harness.js";

/** A durable store that restarted and found the call's outcome unknown. */
const unknownStore = (reason: "interrupted" | "result-not-stored" | "failed-after-start"): IdempotencyStore => ({
  begin: (): IdempotencyBegin => ({ state: "unknown", reason }),
  complete: () => undefined,
  abandon: () => undefined,
  markUnknown: () => undefined,
});

for (const reason of ["interrupted", "result-not-stored", "failed-after-start"] as const) {
  test(`an unknown key (${reason}) is E_CONFLICT with outcome-unknown and the handler never runs`, async (t) => {
    const r = rig({ idempotency: unknownStore(reason) });
    t.after(() => r.cleanup());
    await r.handshake();
    let runs = 0;
    r.daemon.register("axis.test", 1, { write: () => (runs++, { n: 1 }) });
    r.send(req("u1", "write", { n: 1 }, { idempotencyKey: KEY1 }));
    const res = await r.inbox.response("u1");
    assert.equal(res.error?.code, "E_CONFLICT");
    assert.equal(res.error?.details?.reason, "outcome-unknown");
    assert.equal(res.error?.details?.cause, reason);
    assert.equal(runs, 0);
    assert.ok(r.events.some((e) => e.payload.reason === "idempotency_unknown"));
  });
}
