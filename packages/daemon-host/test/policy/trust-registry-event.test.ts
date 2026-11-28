// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-3c (terminal-trust-revocation.md section 2): the trust registry's revocation event. It fires synchronously inside `set`, after
// the record, for every recorded revoke (window or subject level), and as `all` when a revoke latches saturation (before the throw).
// Grants never fire. A `set` during a dispatch is refused and records nothing. Listeners are snapshotted at dispatch: one added
// during it first hears the next event, one disposed before its turn is skipped. A throwing listener is caught on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryTrustRegistry, MAX_TRUST_ENTRIES } from "../../src/policy/trust-registry.js";
import type { TrustRevocation } from "../../src/ports/trust.js";

test("fires after the record, at the level recorded: a window, or a subject (workspace or project id)", () => {
  const reg = new InMemoryTrustRegistry();
  const seen: Array<[TrustRevocation, boolean]> = [];
  reg.onRevoked((e) => seen.push([e, e.kind === "window" ? reg.isRevoked({ windowId: e.windowId }) : e.kind === "subject" ? reg.isRevoked({ windowId: "any", workspaceId: e.id }) : true]));
  reg.set({ windowId: "w1" }, false);
  reg.set({ windowId: "w2", workspaceId: "ws1" }, false);
  reg.set({ windowId: "w2", workspaceId: "ws1" }, false); // repeated: fires again
  assert.deepEqual(seen, [[{ kind: "window", windowId: "w1" }, true], [{ kind: "subject", id: "ws1" }, true], [{ kind: "subject", id: "ws1" }, true]]);
});

test("grants never fire", () => {
  const reg = new InMemoryTrustRegistry();
  let n = 0;
  reg.onRevoked(() => n++);
  reg.set({ windowId: "w1" }, true);
  reg.set({ windowId: "w1", workspaceId: "ws1" }, true);
  assert.equal(n, 0);
});

test("a revoke that latches saturation notifies all, then throws as before", () => {
  const reg = new InMemoryTrustRegistry();
  for (let i = 0; i < MAX_TRUST_ENTRIES; i++) reg.set({ windowId: `w${i}` }, true);
  const seen: TrustRevocation[] = [];
  reg.onRevoked((e) => seen.push(e));
  assert.throws(() => reg.set({ windowId: "new" }, false), RangeError);
  assert.deepEqual(seen, [{ kind: "all" }]);
  assert.equal(reg.saturated, true);
  assert.equal(reg.isRevoked({ windowId: "w0" }), true);
});

test("a full table refusing a GRANT notifies nothing", () => {
  const reg = new InMemoryTrustRegistry();
  for (let i = 0; i < MAX_TRUST_ENTRIES; i++) reg.set({ windowId: `w${i}` }, true);
  let n = 0;
  reg.onRevoked(() => n++);
  assert.throws(() => reg.set({ windowId: "new" }, true), RangeError);
  assert.equal(n, 0);
});

test("review nit 1: a nested REVOKE is queued and recorded right after the dispatch (never dropped); a nested GRANT is refused", () => {
  const reg = new InMemoryTrustRegistry();
  const refused: string[] = [];
  const heard: string[] = [];
  let depth = 0; // nested sets on the first call only, so a registry that recursed could not loop forever
  reg.onRevoked((e) => {
    heard.push(e.kind === "window" ? e.windowId : e.kind);
    if (depth++ > 0) return;
    try {
      reg.set({ windowId: "w1" }, true); // a grant would overtake the revoke being delivered: refused
    } catch (err) {
      refused.push((err as Error).name);
    }
    reg.set({ windowId: "other" }, false); // a revoke lowers authority: queued, not dropped
    assert.equal(reg.isRevoked({ windowId: "other" }), false, "not yet recorded inside the dispatch");
  });
  let later = 0;
  reg.onRevoked(() => void (later++, assert.equal(reg.isRevoked({ windowId: "w1" }), true, "the grant did not overtake")));
  reg.set({ windowId: "w1" }, false);
  assert.deepEqual(refused, ["RangeError"]);
  assert.equal(reg.isRevoked({ windowId: "w1" }), true);
  assert.equal(reg.isRevoked({ windowId: "other" }), true, "the nested revoke was recorded after the dispatch");
  assert.deepEqual(heard, ["w1", "other"], "and dispatched in its own turn, after the first completed");
  assert.equal(later, 2);
});

test("review nit 1: the queue is bounded; overflowing it latches the registry saturated (fail closed) and notifies all", () => {
  const reg = new InMemoryTrustRegistry();
  const heard: string[] = [];
  let first = true;
  reg.onRevoked((e) => {
    heard.push(e.kind);
    if (!first) return;
    first = false;
    for (let i = 0; i < 100; i++) reg.set({ windowId: `n${i}` }, false);
  });
  reg.set({ windowId: "w1" }, false);
  assert.equal(reg.saturated, true);
  assert.ok(heard.includes("all"));
  assert.equal(reg.isRevoked({ windowId: "anything" }), true);
});

test("listeners are a snapshot: one added during a dispatch hears the next event; one disposed before its turn is skipped", () => {
  const reg = new InMemoryTrustRegistry();
  const heard: string[] = [];
  let late: { dispose(): void } | undefined;
  let second: { dispose(): void } | undefined = undefined;
  reg.onRevoked((e) => {
    heard.push(`a:${e.kind}`);
    late ??= reg.onRevoked((x) => void heard.push(`late:${x.kind}`));
    second?.dispose();
  });
  second = reg.onRevoked(() => void heard.push("b"));
  reg.set({ windowId: "w1" }, false);
  assert.deepEqual(heard, ["a:window"], "b was disposed before its turn; late was added during the dispatch");
  reg.set({ windowId: "w2", workspaceId: "s" }, false);
  assert.deepEqual(heard, ["a:window", "a:subject", "late:subject"]);
  late?.dispose();
  late?.dispose(); // idempotent
});

test("a throwing listener is caught on its own: the record stands, the others run, set does not throw", () => {
  const errors: number[] = [];
  const reg = new InMemoryTrustRegistry({ onListenerError: () => void errors.push(1) });
  let after = 0;
  reg.onRevoked(() => {
    throw new Error("boom");
  });
  reg.onRevoked(() => void after++);
  reg.set({ windowId: "w1" }, false);
  assert.equal(after, 1);
  assert.equal(errors.length, 1);
  assert.equal(reg.isRevoked({ windowId: "w1" }), true);
});
