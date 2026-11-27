// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_PREVIEW_HEAD } from "@axis/protocol";
import { READ_MESSAGES, type MessageCaller } from "../src/index.js";
import { approveAll, denyAll, deliveryRig, drive, write, type DeliveryRig } from "./messages-delivery-rig.js";

// A tainted run's write to a file that is not protected is put to the user only when the card shows ALL of what is written
// (no cut at MAX_PREVIEW_HEAD, no finding hiding it); otherwise it is refused before any card, with its own reason
// (content_not_reviewable), never recorded as the user's decline. The same rule as a send (PV-M4 review 1 B1).

const a2: MessageCaller = { kind: "agent", agentId: "a2", runId: null, verified: true, receivedHop: 0 };
const readMsgs = { name: READ_MESSAGES, input: {} };
const decisions = (r: DeliveryRig) =>
  r.c.audit.list({ limit: 2000 }).filter((e) => e.action === "broker.decision").map((e) => e.payload as Record<string, unknown>).filter((p) => p["tool"] === "write_file").map((p) => [p["decision"], p["reason"] ?? null]);

/** A run of a1 tainted by reading a2's message in its first call. */
async function tainted(t: Parameters<typeof deliveryRig>[0]): Promise<{ r: DeliveryRig; runId: string }> {
  const r = await deliveryRig(t, { messaging: true, noDelivery: true });
  await r.m.service.send(a2, { recipients: [{ agent: "a1" }], body: { format: "text", text: "taint me" } });
  return { r, runId: r.run("a1") };
}

test("a tainted run's write one unit past the card's bound is refused before any card, with its own reason; nothing is written", async (t) => {
  const { r, runId } = await tainted(t);
  const d = drive(r, runId, [[readMsgs, write("src/big.txt", "x".repeat(MAX_PREVIEW_HEAD + 1))], []]);
  assert.equal(await denyAll(r, d.end), 0, "never put to the user");
  await d.end;
  assert.match(d.results[1]?.[1] ?? "", /^The call was refused \(content_not_reviewable\)\./);
  assert.deepEqual(d.notes, [], "no card");
  assert.deepEqual(decisions(r), [["deny", "content-not-reviewable"]], "audited as its own refusal, not a decline");
  assert.equal(existsSync(join(r.c.root, "src/big.txt")), false);
});

test("a tainted run's write exactly at the card's bound is shown whole and written once approved", async (t) => {
  const { r, runId } = await tainted(t);
  const content = "y".repeat(MAX_PREVIEW_HEAD);
  const d = drive(r, runId, [[readMsgs, write("src/fits.txt", content)], []]);
  assert.equal(await approveAll(r, d.end), 1);
  await d.end;
  const card = d.notes.find((n) => n.state === "requested")?.preview?.content;
  assert.deepEqual([card?.truncated, card?.head], [false, content]);
  assert.equal(readFileSync(join(r.c.root, "src/fits.txt"), "utf8"), content);
});

test("a tainted run's short write whose content a scan finding would hide on the card is refused the same way", async (t) => {
  const { r, runId } = await tainted(t);
  r.c.redactor.registerSecret("plum orchard quietly");
  const d = drive(r, runId, [[readMsgs, write("src/key.txt", "token: plum orchard quietly")], []]);
  assert.equal(await denyAll(r, d.end), 0);
  await d.end;
  assert.match(d.results[1]?.[1] ?? "", /^The call was refused \(content_not_reviewable\)\./);
  assert.equal(existsSync(join(r.c.root, "src/key.txt")), false);
});

test("an untainted run is unaffected: a large write to a file that is not protected is not asked and is written", async (t) => {
  const r = await deliveryRig(t, { messaging: true, noDelivery: true });
  const runId = r.run("a1");
  const content = "z".repeat(100_000);
  const d = drive(r, runId, [[write("src/large.txt", content)], []]);
  assert.equal(await denyAll(r, d.end), 0);
  assert.deepEqual(await d.end, { state: "REVIEWING", reason: null });
  assert.equal(readFileSync(join(r.c.root, "src/large.txt"), "utf8").length, 100_000);
});

test("a protected write keeps C2's rule: past the card's bound it is declined unasked (approval_declined), as before", async (t) => {
  const { r, runId } = await tainted(t);
  mkdirSync(join(r.c.root, ".github", "workflows"), { recursive: true });
  const d = drive(r, runId, [[readMsgs, write(".github/workflows/ci.yml", "w".repeat(MAX_PREVIEW_HEAD + 1))], []]);
  assert.equal(await denyAll(r, d.end), 0);
  await d.end;
  assert.match(d.results[1]?.[1] ?? "", /^The call was refused \(approval_declined\)\./);
  assert.equal(existsSync(join(r.c.root, ".github/workflows/ci.yml")), false);
});

for (const path of ["src/broken.txt", ".github/workflows/ci.yml"]) test(`a tainted run's write whose card could not be built at all is refused the same way, not as a decline (${path}; a protected write too, review N1)`, async (t) => {
  // The scanner reports a finding and the redactor fails on the card's second pass, so the builder returns no preview.
  const r = await deliveryRig(t, { messaging: true, noDelivery: true, previewScanner: { scan: async (text) => (text.includes("BREAK-CARD") ? ["test-rule"] : []) } });
  const real = r.c.redactor.redactString.bind(r.c.redactor);
  let passes = 0;
  r.c.redactor.redactString = (text: string): string => {
    if (text === "BREAK-CARD" && ++passes === 2) throw new Error("redactor failed");
    return real(text);
  };
  await r.m.service.send(a2, { recipients: [{ agent: "a1" }], body: { format: "text", text: "taint me" } });
  const runId = r.run("a1");
  mkdirSync(join(r.c.root, ".github", "workflows"), { recursive: true });
  const d = drive(r, runId, [[readMsgs, write(path, "BREAK-CARD")], []]);
  assert.equal(await denyAll(r, d.end), 0);
  await d.end;
  assert.equal(passes, 2, "the card's second pass failed");
  assert.match(d.results[1]?.[1] ?? "", /^The call was refused \(content_not_reviewable\)\./);
  assert.deepEqual(decisions(r), [["deny", "content-not-reviewable"]]);
  assert.equal(existsSync(join(r.c.root, path)), false);
});
