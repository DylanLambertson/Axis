// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A content hook may refuse a tier >= 3 call before a challenge is issued or an approval spent; ordinary refusals keep their reason.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ErrorCode } from "@axis/protocol";
import { DaemonError, type ApprovalContentHook } from "../src/index.js";
import { approveAndRun, fakeGate, sha } from "./gate.js";
import { CONTRACT, KEY1, req, rig, type Rig } from "./harness.js";

async function ready(t: TestContext, options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = rig(options);
  t.after(() => r.cleanup());
  await r.handshake();
  return r;
}

const CLOSED: ErrorCode[] = ["E_NOT_FOUND", "E_CONFLICT", "E_UNAVAILABLE", "E_INVALID_ARGUMENT"];
const MESSAGE = "A run is active in /home/alice/acme-merger/ws-1.";
const FIXED: Record<string, string> = {
  E_NOT_FOUND: "Not found",
  E_CONFLICT: "Request conflicts with current state",
  E_UNAVAILABLE: "Temporarily unavailable",
  E_INVALID_ARGUMENT: "Invalid request",
};

/** A hook that throws what `box.error` holds (when set), from the hook itself or from inside the lock. */
function hookOf(box: { error?: unknown }, where: "hook" | "lock"): ApprovalContentHook {
  return () => {
    if (where === "hook" && box.error) throw box.error;
    return {
      target: "workspace:ws-1",
      withLock: (fn) => {
        if (where === "lock" && box.error) throw box.error;
        return fn(sha("v1"));
      },
    };
  };
}
const reasonOf = (r: Rig): unknown => r.events.at(-1)?.payload["reason"];

for (const where of ["hook", "lock"] as const) {
  for (const code of CLOSED) {
    test(`a content hook's ${code} (thrown from the ${where}) is answered as that error, audited content_hook_refused, with the key freed`, async (t) => {
      const { gate, calls } = fakeGate();
      const box: { error?: unknown } = { error: new DaemonError(code, MESSAGE, { reason: "active_run", fields: ["/home/alice/x"] }) };
      const r = await ready(t, { gate });
      r.daemon.register(CONTRACT, 1, { danger: () => ({ done: true }) }, { content: { danger: hookOf(box, where) } });
      r.send(req("a1", "danger", { id: "ws-1" }, { idempotencyKey: KEY1 }));
      const res = await r.inbox.response("a1");
      assert.equal(res.error?.code, code);
      assert.equal(res.error?.message, FIXED[code]);
      assert.deepEqual(res.error?.details, { reason: "active_run" }, "only the closed reason token is kept");
      assert.ok(!JSON.stringify(r.events).includes("alice"), "no hook text in the audit");
      assert.equal(r.events.at(-1)?.payload["detail"], "active_run");
      assert.equal(calls.issue.length, 0, "no challenge issued");
      assert.equal(reasonOf(r), "content_hook_refused");
      assert.equal(r.events.at(-1)?.outcome, "denied");
      assert.equal(r.internal.length, 0, "an ordinary refusal is not reported as a bug");
      // The key is freed, not unknown: once the hook stops refusing, the same key gets a challenge.
      box.error = undefined;
      r.send(req("a2", "danger", { id: "ws-1" }, { idempotencyKey: KEY1 }));
      assert.equal((await r.inbox.response("a2")).error?.code, "E_APPROVAL_REQUIRED");
      assert.equal(calls.issue.length, 1);
    });
  }
}

test("any other code from a content hook, and a plain Error, stay an opaque E_INTERNAL with content_hook_error", async (t) => {
  const others: unknown[] = [new DaemonError("E_BACKPRESSURE", MESSAGE), new DaemonError("E_INTERNAL", MESSAGE), new DaemonError("E_POLICY_DENIED", MESSAGE), new Error(MESSAGE)];
  for (const error of others) {
    for (const where of ["hook", "lock"] as const) {
      const { gate, calls } = fakeGate();
      const r = await ready(t, { gate });
      r.daemon.register(CONTRACT, 1, { danger: () => ({ done: true }) }, { content: { danger: hookOf({ error }, where) } });
      r.send(req("o1", "danger", { id: "ws-1" }, { idempotencyKey: KEY1 }));
      const res = await r.inbox.response("o1");
      assert.equal(res.error?.code, "E_INTERNAL");
      assert.equal(res.error?.message, "Internal error");
      assert.equal(calls.issue.length, 0);
      assert.equal(reasonOf(r), "content_hook_error", "audited as an integration error, in the lock cases too");
      assert.equal(r.events.at(-1)?.outcome, "error");
    }
  }
});

test("other codes and plain errors from a hook at execute time are E_INTERNAL with a content_hook_error row, nothing spent", async (t) => {
  for (const error of [new DaemonError("E_BACKPRESSURE", MESSAGE), new DaemonError("E_POLICY_DENIED", MESSAGE), new Error(MESSAGE)]) {
    for (const where of ["hook", "lock"] as const) {
      const { gate, calls } = fakeGate();
      const box: { error?: unknown } = {};
      const r = await ready(t, { gate });
      r.daemon.register(CONTRACT, 1, { danger: () => ({ done: true }) }, { content: { danger: hookOf(box, where) } });
      const id = await approveAndRun(r, "x", { id: "ws-1" }, () => void (box.error = error));
      const res = await r.inbox.response(id);
      assert.equal(res.error?.code, "E_INTERNAL");
      assert.equal(res.error?.message, "Internal error");
      assert.equal(calls.execute.length, 0);
      assert.equal(reasonOf(r), "content_hook_error");
    }
  }
});

test("a hook's reason is dropped unless it is a closed token, and a path or secret in the message never reaches the wire or the audit", async (t) => {
  for (const reason of ["Has Space", "/home/alice", "x".repeat(33), "9start", "Not_A_Token", 7 as never]) {
    const { gate } = fakeGate();
    const error = new DaemonError("E_NOT_FOUND", "Workspace /home/alice/acme-merger/ws-1 not found, see the admin", { reason });
    const r = await ready(t, { gate });
    r.daemon.register(CONTRACT, 1, { danger: () => ({ done: true }) }, { content: { danger: hookOf({ error }, "hook") } });
    r.send(req("t1", "danger", { id: "ws-1" }, { idempotencyKey: KEY1 }));
    const res = await r.inbox.response("t1");
    assert.equal(res.error?.code, "E_NOT_FOUND");
    assert.equal(res.error?.message, "Not found");
    assert.equal(res.error?.details, undefined);
    assert.equal(r.events.at(-1)?.payload["detail"], undefined);
    assert.ok(!JSON.stringify([res, r.events]).match(/alice|admin/));
  }
});

for (const where of ["hook", "lock"] as const) {
  test(`a refusal from the ${where} at execute time spends nothing, withdraws nothing and frees the key; the same approval works on retry`, async (t) => {
    const { gate, calls } = fakeGate();
    const box: { error?: unknown } = {};
    const r = await ready(t, { gate });
    let runs = 0;
    r.daemon.register(CONTRACT, 1, { danger: () => (runs++, { done: true }) }, { content: { danger: hookOf(box, where) } });
    const id = await approveAndRun(r, "e", { id: "ws-1" }, () => void (box.error = new DaemonError("E_CONFLICT", MESSAGE, { reason: "active_run" })));
    const res = await r.inbox.response(id);
    assert.equal(res.error?.code, "E_CONFLICT");
    assert.equal(res.error?.message, FIXED["E_CONFLICT"]);
    assert.equal(calls.execute.length, 0, "the gate was never asked to spend");
    assert.equal(calls.withdraw.length, 0);
    assert.equal(runs, 0);
    assert.equal(reasonOf(r), "content_hook_refused");
    box.error = undefined;
    r.send(req("e-3", "danger", { id: "ws-1", approval: { challengeId: "1".padStart(43, "A") } }, { idempotencyKey: KEY1 }));
    assert.equal((await r.inbox.response("e-3")).ok, true, "the approval was unspent, and the key was free");
    assert.equal(runs, 1);
  });
}

for (const code of ["E_NOT_FOUND", "E_UNAVAILABLE", "E_INVALID_ARGUMENT"] as const) {
  test(`a hook's ${code} at execute time is answered with the fixed text, spends nothing and is audited content_hook_refused`, async (t) => {
    const { gate, calls } = fakeGate();
    const box: { error?: unknown } = {};
    const r = await ready(t, { gate });
    r.daemon.register(CONTRACT, 1, { danger: () => ({ done: true }) }, { content: { danger: hookOf(box, "lock") } });
    const id = await approveAndRun(r, "n", { id: "ws-1" }, () => void (box.error = new DaemonError(code, MESSAGE)));
    const res = await r.inbox.response(id);
    assert.equal(res.error?.code, code);
    assert.equal(res.error?.message, FIXED[code]);
    assert.equal(calls.execute.length, 0);
    assert.equal(reasonOf(r), "content_hook_refused");
  });
}

test("a DaemonError thrown by the gate at execute is not a hook refusal: it stays E_INTERNAL", async (t) => {
  const { gate } = fakeGate();
  const throwing = { ...gate, execute: (): never => { throw new DaemonError("E_CONFLICT", MESSAGE); } } as typeof gate;
  const r = await ready(t, { gate: throwing });
  r.daemon.register(CONTRACT, 1, { danger: () => ({ done: true }) }, { content: { danger: hookOf({}, "hook") } });
  const id = await approveAndRun(r, "g", { id: "ws-1" });
  assert.equal((await r.inbox.response(id)).error?.code, "E_INTERNAL");
  assert.notEqual(reasonOf(r), "content_hook_refused");
});
