// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditEventInput } from "@axis/audit";
import { MAX_CARD_TAINT_SOURCES, TAINT_SOURCES, approvalPreviewSchema, approvalTaintSchema, taintSourceSchema } from "@axis/protocol";
import { TAINT_PAYLOAD_ALLOWLIST, createRunTaint, runNativeDetail, type RunTaint, type TaintStore } from "../src/index.js";

// Ticket PV-M0 (IAC-T, inter-agent-communication.md section 6.6): the sticky per-run flag, the closed source list and the
// card. The producers come with later tickets; here every source is received through the test seam.

const receipt = (over: Record<string, unknown> = {}) => ({ source: "message", senderKind: "agent", sender: "Reviewer agent", hop: 1, ref: "msg_01", ...over });

interface MemoryStore extends TaintStore {
  marked: number;
}
/** The journal's role: what a run recorded; `read` or `mark` can be made to fail. */
function memoryStore(o: { tainted?: boolean; read?: () => boolean; mark?: () => void } = {}): MemoryStore {
  let flag = o.tainted === true;
  const store: MemoryStore = {
    marked: 0,
    tainted: () => (o.read === undefined ? flag : o.read()),
    markTainted: () => {
      o.mark?.();
      store.marked += 1;
      flag = true;
    },
  };
  return store;
}

function make(over: { append?: (e: AuditEventInput) => unknown; keep?: number; store?: MemoryStore } = {}): { taint: RunTaint; rows: AuditEventInput[]; clock: { t: number }; store: MemoryStore } {
  const rows: AuditEventInput[] = [];
  const clock = { t: 1_800_000_000_000 };
  const store = over.store ?? memoryStore();
  const taint = createRunTaint({
    runId: "run-1",
    store,
    audit: { append: (e) => (rows.push(e), over.append?.(e), {} as never) },
    now: () => clock.t,
    ...(over.keep === undefined ? {} : { keep: over.keep }),
  });
  return { taint, rows, clock, store };
}

test("PV-M0: the closed source list is the eight sources of section 6.6, in order, and nothing else", () => {
  assert.deepEqual([...TAINT_SOURCES], ["message", "read_messages", "excerpt", "page", "task_start", "plugin_output", "integration_data", "task_read"]);
  for (const bad of ["", "user", "MESSAGE", "messages", "test", "__proto__", 1, null]) assert.equal(taintSourceSchema.safeParse(bad).success, false, String(bad));
});

for (const source of TAINT_SOURCES) {
  test(`PV-M0: source ${source} taints the run, is listed on the card with sender, type, time and hop, and is audited`, () => {
    const { taint, rows, clock, store } = make();
    assert.equal(taint.tainted(), false);
    assert.equal(taint.card(), undefined);
    taint.receive(receipt({ source, senderKind: "plugin", sender: "Lint plugin", hop: 3, ref: `id:${source}` }));
    assert.equal(taint.tainted(), true);
    assert.deepEqual(taint.card(), { sources: [{ source, senderKind: "plugin", sender: "Lint plugin", at: clock.t, hop: 3, ref: `id:${source}` }], total: 1, earlier: false });
    assert.equal(store.marked, 1, "recorded in the journal");
    assert.ok(approvalTaintSchema.safeParse(taint.card()).success);
    assert.deepEqual(rows, [{ actor: "daemon", action: "message.taint", target: "run:run-1", outcome: "success", payload: { runId: "run-1", source, sourceId: `id:${source}`, senderKind: "plugin", hop: 3 } }]);
    assert.deepEqual(Object.keys(rows[0]?.payload as object).sort(), [...(TAINT_PAYLOAD_ALLOWLIST["message.taint"] ?? [])].sort(), "every audited key is allow-listed");
  });
}

test("PV-M0: an unknown source or a malformed receipt is refused, and the run is tainted all the same (fail closed)", () => {
  const bad = [
    receipt({ source: "bogus" }), receipt({ source: "user" }), receipt({ source: undefined }), receipt({ senderKind: "user" }),
    receipt({ hop: 9 }), receipt({ hop: -1 }), receipt({ hop: 1.5 }), receipt({ sender: "" }), receipt({ sender: "a\nb" }),
    receipt({ sender: "evil\u202etxt" }), receipt({ ref: "../x" }), receipt({ ref: "" }), receipt({ at: 5 }), { ...receipt(), extra: 1 }, null, "message",
  ];
  for (const input of bad) {
    const { taint, rows, store } = make();
    assert.throws(() => taint.receive(input), TypeError, JSON.stringify(input));
    assert.equal(taint.tainted(), true, `tainted after ${JSON.stringify(input)}`);
    assert.equal(store.marked, 1, "recorded in the journal before the receipt was checked");
    assert.deepEqual(taint.decide({ tool: "write_file", tier: "write" }), { approve: true, reasons: ["taint"] });
    assert.deepEqual(taint.card(), { sources: [], total: 1, earlier: false }, "nothing unlisted reaches the card, but the count does (review N2)");
    assert.deepEqual(rows, [], "nothing unlisted reaches the audit log");
  }
});

test("PV-M0: a receipt whose audit row cannot be written throws, and the run stays tainted", () => {
  const { taint } = make({ append: () => { throw new Error("disk full"); } });
  assert.throws(() => taint.receive(receipt()), /disk full/);
  assert.equal(taint.tainted(), true);
});

test("review S2: a run the journal records as tainted starts tainted, with a card that says so, and no receipt is needed", () => {
  const { taint, store } = make({ store: memoryStore({ tainted: true }) });
  assert.equal(taint.tainted(), true);
  assert.deepEqual(taint.decide({ tool: "write_file", tier: "write" }), { approve: true, reasons: ["taint"] });
  assert.deepEqual(taint.card(), { sources: [], total: 0, earlier: true });
  assert.ok(approvalTaintSchema.safeParse(taint.card()).success);
  assert.equal(runNativeDetail({ tool: "write_file", tier: "write", preview: { tier: "write", protected: false, content: null, taint: taint.card() } }), "write_file (write), after untrusted input (earlier)");
  assert.equal(store.marked, 0);
});

test("review S2: a journal that cannot be read starts the run tainted; a taint that cannot be recorded throws and stays set", () => {
  const unread = make({ store: memoryStore({ read: () => { throw new Error("db closed"); } }) });
  assert.equal(unread.taint.tainted(), true);
  assert.equal(unread.taint.card()?.earlier, true);
  const unwritable = make({ store: memoryStore({ mark: () => { throw new Error("E_NOT_FOUND"); } }) });
  assert.throws(() => unwritable.taint.receive(receipt()), /E_NOT_FOUND/);
  assert.equal(unwritable.taint.tainted(), true);
  assert.deepEqual(unwritable.rows, [], "nothing is audited for a taint that was not recorded");
});

test("PV-M0: the decision hook raises every call above read while tainted, and nothing ever clears the flag", () => {
  const { taint } = make();
  for (const tier of ["read", "write", "network", "destructive", "privileged"]) assert.deepEqual(taint.decide({ tool: "t", tier }), { approve: false, reasons: [] }, `untainted ${tier}`);
  taint.receive(receipt());
  assert.deepEqual(taint.decide({ tool: "read_file", tier: "read" }), { approve: false, reasons: [] }, "a pure read is not side-effecting (section 6.5)");
  for (let turn = 0; turn < 50; turn++) {
    for (const tier of ["write", "network", "destructive", "privileged", "unknown"]) assert.deepEqual(taint.decide({ tool: "t", tier }), { approve: true, reasons: ["taint"] }, `${tier} at ${turn}`);
  }
  assert.equal(taint.tainted(), true);
  assert.equal(Object.keys(taint).some((k) => /clear|reset|untaint/i.test(k)), false, "no method clears the flag");
});

test("PV-M0: the card keeps the most recent sources, bounded, counts all of them, and is a copy", () => {
  const { taint, clock } = make();
  for (let i = 0; i < MAX_CARD_TAINT_SOURCES + 5; i++) {
    clock.t += 1;
    taint.receive(receipt({ ref: `m${i}` }));
  }
  const card = taint.card();
  assert.equal(card?.total, MAX_CARD_TAINT_SOURCES + 5);
  assert.equal(card?.sources.length, MAX_CARD_TAINT_SOURCES);
  assert.deepEqual([card?.sources[0]?.ref, card?.sources.at(-1)?.ref], ["m5", `m${MAX_CARD_TAINT_SOURCES + 4}`]);
  (card?.sources[0] as { sender: string }).sender = "changed";
  assert.equal(taint.card()?.sources[0]?.sender, "Reviewer agent");
  assert.throws(() => make({ keep: 0 }), RangeError);
  assert.throws(() => make({ keep: MAX_CARD_TAINT_SOURCES + 1 }), RangeError);
});

test("PV-M0: the approval preview carries the card only as the closed schema; the native dialog shows a daemon-derived count", () => {
  const { taint } = make();
  taint.receive(receipt());
  const preview = { tier: "write" as const, protected: false, content: null, taint: taint.card() };
  assert.ok(approvalPreviewSchema.safeParse(preview).success);
  assert.ok(approvalPreviewSchema.safeParse({ tier: "write", protected: false, content: null }).success, "an untainted preview has no card");
  assert.equal(approvalPreviewSchema.safeParse({ ...preview, taint: { sources: [], total: 0, earlier: false } }).success, false, "a card names why the run is tainted");
  assert.equal(approvalPreviewSchema.safeParse({ ...preview, taint: { sources: preview.taint?.sources, total: 0, earlier: false } }).success, false, "the total counts every listed source");
  assert.equal(runNativeDetail({ tool: "write_file", tier: "write", preview }), "write_file (write), after untrusted input (1)");
  assert.equal(runNativeDetail({ tool: "write_file", tier: "write", preview: { tier: "write", protected: false, content: null } }), "write_file (write)");
});
