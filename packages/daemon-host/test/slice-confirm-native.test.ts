// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { MAX_AUDIT_LIST } from "@axis/protocol";
import { confirmNative } from "../testing/slice-helpers.js";
import type { TestClient } from "../testing/test-client.js";
import type { TestSupervisor } from "../testing/test-supervisor.js";

// The slice helper `confirmNative` waits for THIS challenge's recorded confirmation, not for a count among the newest audit rows.

type Row = { seq: number; action: string; payload: Record<string, unknown> };
const refOf = (id: string): string => createHash("sha256").update(id, "utf8").digest("hex").slice(0, 12);
const native = (seq: number, id: string): Row => ({ seq, action: "tier4.challenge", payload: { phase: "native", decision: "confirm", ref: refOf(id) } });
const filler = (seq: number): Row => ({ seq, action: "rpc.execute", payload: {} });

/** An audit log the fake host serves the way `axis.audit/1.status` and `list` do. */
function fakeHost(rows: Row[], onAnswer: (id: string) => void) {
  const client = {
    ok: async (_contract: string, method: string, payload: { afterSeq?: number; limit?: number }) => {
      if (method === "status") return { head: rows.length === 0 ? null : { seq: (rows[rows.length - 1] as Row).seq } };
      const after = payload.afterSeq ?? 0;
      return { events: rows.filter((r) => r.seq > after).slice(0, payload.limit ?? MAX_AUDIT_LIST) };
    },
  } as unknown as TestClient;
  const sup = { answerNative: (id: string) => onAnswer(id) } as unknown as TestSupervisor;
  return { client, sup };
}

test("an older confirmation leaving the newest rows as the new one enters still ends the wait", async () => {
  // The newest MAX_AUDIT_LIST rows hold exactly one confirmation (an older challenge's), at the oldest edge of the window.
  const rows: Row[] = [native(1, "older")];
  for (let seq = 2; seq <= MAX_AUDIT_LIST; seq++) rows.push(filler(seq));
  let answered = "";
  const { client, sup } = fakeHost(rows, (id) => {
    answered = id;
    rows.push(native(rows.length + 1, id)); // the host records the new confirmation: the older one leaves the window
  });
  await confirmNative(sup, client, "newer");
  assert.equal(answered, "newer");
});

test("another challenge's confirmation does not end the wait", async () => {
  const rows: Row[] = [filler(1)];
  const { client, sup } = fakeHost(rows, () => {
    rows.push(native(2, "someone-else"));
  });
  await assert.rejects(confirmNative(sup, client, "mine", 20), /gave up waiting/);
});
