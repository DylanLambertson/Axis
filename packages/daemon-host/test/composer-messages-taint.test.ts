// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { MAX_BODY_CHARS, MAX_HOP, MAX_PREVIEW_HEAD, encodeMessagingId } from "@axis/protocol";
import { READ_MESSAGES, SEND_MESSAGE, messagingReason, raisedHop, sendPreview, type MessageCaller } from "../src/index.js";
import { approveAll, denyAll, deliveryRig, drive, type DeliveryRig } from "./messages-delivery-rig.js";

// PV-M4: IAC-T source 2 (`read_messages`) and the run's received hop (design section 7.3), end to end.

const USER: MessageCaller = { kind: "user" };
const agent = (agentId: string, receivedHop = 0, verified = true): MessageCaller => ({ kind: "agent", agentId, runId: null, verified, receivedHop });
const post = async (r: DeliveryRig, from: MessageCaller, to: string, text: string) => (await r.m.service.send(from, { recipients: [{ agent: to }], body: { format: "text", text } })).message;
const rows = (r: DeliveryRig, action: string) => r.c.audit.list({ limit: 2000 }).filter((e) => e.action === action).map((e) => e.payload as Record<string, unknown>);
const sendTo = (to: string, body: string) => ({ name: SEND_MESSAGE, input: { recipients: [{ agent: to }], body } });
const readMsgs = (input: Record<string, unknown> = {}) => ({ name: READ_MESSAGES, input });
/** The hops of the messages a2 got from a1. */
const hopsTo = (r: DeliveryRig, to: string): number[] => r.m.service.read(agent(to), {}).messages.filter((m) => m.sender.kind === "agent" && m.sender.agentId === "a1").map((m) => m.hop);

test("a read taints the run before its result returns: a send in the SAME reply is decided tainted and carries the read's hop plus one", async (t) => {
  const r = await deliveryRig(t, { messaging: true, noDelivery: true });
  const runId = r.run("a1");
  const m = await post(r, agent("a2", 3), "a1", "please reply");
  const d = drive(r, runId, [[readMsgs(), sendTo("a2", "done")], []]);
  const approved = await Promise.all([approveAll(r, d.end), d.end]);
  assert.equal(approved[0], 1, "the send waited for the user");
  assert.equal(r.c.journal.composer.tainted(runId), true);
  assert.deepEqual(rows(r, "message.taint").map((p) => [p["source"], p["sourceId"], p["senderKind"], p["hop"]]), [["read_messages", m.messageId, "agent", 4]]);
  const decision = rows(r, "broker.decision").find((p) => p["tool"] === SEND_MESSAGE);
  assert.ok(Array.isArray(decision?.["reasons"]) ? (decision["reasons"] as string[]).includes("taint") : String(decision?.["reasons"]).includes("taint"), JSON.stringify(decision));
  const card = d.notes.find((n) => n.state === "requested");
  assert.deepEqual(card?.preview?.taint?.sources.map((x) => [x.source, x.sender, x.ref, x.hop]), [["read_messages", "a2", m.messageId, 4]], "the card lists the read");
  assert.match(card?.preview?.content?.head ?? "", /^To: agent a2\nThread: new\n\ndone$/, "the card shows the recipients, the thread and the whole body");
  assert.deepEqual(hopsTo(r, "a2"), [5], "received hop 4, so the new thread's message is hop 5");
});

// Review 1 B1: the card's head holds MAX_PREVIEW_HEAD escaped units; a body plus its To/Thread lines must fit in it whole.
const CAP = MAX_PREVIEW_HEAD - sendPreview({ recipients: [{ agent: "a2" }], body: "" }).length;
const decisions = (r: DeliveryRig) => rows(r, "broker.decision").filter((p) => p["tool"] === SEND_MESSAGE).map((p) => [p["decision"], p["reason"] ?? null]);

test("a tainted run's send one unit past what the card can show is refused before any card, with its own reason, not as a decline", async (t) => {
  const r = await deliveryRig(t, { messaging: true, noDelivery: true });
  const runId = r.run("a1");
  await post(r, agent("a2"), "a1", "taint me");
  const d = drive(r, runId, [[readMsgs(), sendTo("a2", "x".repeat(CAP + 1))], []]);
  assert.equal(await denyAll(r, d.end), 0, "never put to the user");
  await d.end;
  assert.match(d.results[1]?.[1] ?? "", /^The call was refused \(body_not_reviewable\)\./);
  assert.deepEqual(d.notes, [], "no card was shown");
  assert.deepEqual(decisions(r), [["deny", "body-not-reviewable"]], "audited as its own refusal");
  assert.deepEqual(hopsTo(r, "a2"), [], "nothing sent");
});

test("a tainted run's send exactly at the card's bound is shown whole and sendable", async (t) => {
  const r = await deliveryRig(t, { messaging: true, noDelivery: true });
  const runId = r.run("a1");
  await post(r, agent("a2"), "a1", "taint me");
  const body = "y".repeat(CAP);
  const d = drive(r, runId, [[readMsgs(), sendTo("a2", body)], []]);
  assert.equal(await approveAll(r, d.end), 1);
  const card = d.notes.find((n) => n.state === "requested")?.preview?.content;
  assert.equal(card?.truncated, false);
  assert.equal(card?.head.length, MAX_PREVIEW_HEAD);
  assert.ok(card?.head.endsWith(`\n\n${body}`), "the whole body is on the card");
  assert.deepEqual(r.m.service.read(agent("a2"), {}).messages.map((m) => m.body.text.length), [CAP]);
});

test("a tainted run's send whose text a scan finding would hide on the card is refused the same way", async (t) => {
  const r = await deliveryRig(t, { messaging: true, noDelivery: true });
  r.c.redactor.registerSecret("plum orchard quietly");
  const runId = r.run("a1");
  await post(r, agent("a2"), "a1", "taint me");
  const d = drive(r, runId, [[readMsgs(), sendTo("a2", "short, but holds plum orchard quietly")], []]);
  assert.equal(await denyAll(r, d.end), 0);
  await d.end;
  assert.match(d.results[1]?.[1] ?? "", /^The call was refused \(body_not_reviewable\)\./);
  assert.deepEqual(decisions(r), [["deny", "body-not-reviewable"]]);
});

test("review 2 N2: a tainted run's send whose card could not be built at all is refused the same way, not as a decline", async (t) => {
  // The scanner reports a finding, and the redactor fails on the card's second pass (outside the builder's scan guard), so
  // the builder returns no preview.
  const r = await deliveryRig(t, { messaging: true, noDelivery: true, previewScanner: { scan: async (text) => (text.includes("BREAK-CARD") ? ["test-rule"] : []) } });
  const real = r.c.redactor.redactString.bind(r.c.redactor);
  let cardPasses = 0;
  r.c.redactor.redactString = (text: string): string => {
    if (text.startsWith("To: agent a2\n") && text.includes("BREAK-CARD") && ++cardPasses === 2) throw new Error("redactor failed");
    return real(text);
  };
  const runId = r.run("a1");
  await post(r, agent("a2"), "a1", "taint me");
  const d = drive(r, runId, [[readMsgs(), sendTo("a2", "BREAK-CARD")], []]);
  assert.equal(await denyAll(r, d.end), 0);
  await d.end;
  assert.equal(cardPasses, 2, "the card's second pass failed");
  assert.match(d.results[1]?.[1] ?? "", /^The call was refused \(body_not_reviewable\)\./);
  assert.deepEqual(decisions(r), [["deny", "body-not-reviewable"]]);
});

test("an untainted run is unaffected: a send of the full body bound is sent with no card", async (t) => {
  const r = await deliveryRig(t, { messaging: true, noDelivery: true });
  const runId = r.run("a1");
  const d = drive(r, runId, [[sendTo("a2", "z".repeat(MAX_BODY_CHARS))], []]);
  assert.equal(await denyAll(r, d.end), 0);
  assert.deepEqual(await d.end, { state: "REVIEWING", reason: null });
  assert.deepEqual(r.m.service.read(agent("a2"), {}).messages.map((m) => m.body.text.length), [MAX_BODY_CHARS]);
});

test("a message from the user read by the run does not taint it or raise its hop; a send in the same reply needs no approval", async (t) => {
  const r = await deliveryRig(t, { messaging: true, noDelivery: true });
  const runId = r.run("a1");
  await post(r, USER, "a1", "send a2 a note");
  const d = drive(r, runId, [[readMsgs(), sendTo("a2", "note")], []]);
  // A send that waits for the user fails here by name at once (its challenge is denied), never at the test's timeout.
  assert.equal(await denyAll(r, d.end), 0, "no approval was asked for");
  assert.deepEqual(await d.end, { state: "REVIEWING", reason: null });
  assert.equal(r.c.journal.composer.tainted(runId), false);
  assert.deepEqual(rows(r, "message.taint"), []);
  assert.deepEqual(hopsTo(r, "a2"), [1]);
});

test("a delivered message raises the run's received hop too: a later send carries it plus one", async (t) => {
  const r = await deliveryRig(t, { messaging: true });
  const runId = r.run("a1");
  await post(r, agent("a2", 5), "a1", "delivered at the boundary");
  const d = drive(r, runId, [[readMsgs({ threadId: encodeMessagingId("thread", randomBytes(16)) })], [sendTo("a2", "after the delivery")], []]);
  await Promise.all([approveAll(r, d.end), d.end]);
  assert.ok((d.seen[1] ?? []).some((x) => x.includes("hop 6")), "delivered with hop 6");
  assert.deepEqual(hopsTo(r, "a2"), [7]);
});

test("the hop cap: a run that read a message at hop 8 cannot send (hop_limit), approved or not", async (t) => {
  const r = await deliveryRig(t, { messaging: true, noDelivery: true });
  const runId = r.run("a1");
  const m = await post(r, agent("a2", MAX_HOP - 1), "a1", "relay this");
  assert.equal(m.hop, MAX_HOP);
  const d = drive(r, runId, [[readMsgs()], [sendTo("a2", "relayed")], []]);
  await Promise.all([approveAll(r, d.end), d.end]);
  assert.match(d.results[2]?.[0] ?? "", /^The call was refused \(hop_limit\)\./);
  assert.deepEqual(hopsTo(r, "a2"), []);
  assert.deepEqual(rows(r, "message.send.refused").map((p) => p["reason"]), ["hop_limit"]);
});

test("a CLI agent's or an unverified sender's message taints as cli; a read of nothing taints nothing", async (t) => {
  const r = await deliveryRig(t, { messaging: true, noDelivery: true });
  const runId = r.run("a1");
  const d0 = drive(r, runId, [[readMsgs()], []]);
  await d0.end;
  assert.equal(d0.results[1]?.[0], "No messages to read.");
  assert.equal(r.c.journal.composer.tainted(runId), false);
  const cli = await post(r, agent("c1"), "a1", "from the cli");
  const unverified = await post(r, agent("a2", 0, false), "a1", "via the endpoint");
  const run2 = r.run("a1");
  const d = drive(r, run2, [[readMsgs()], []]);
  await d.end;
  assert.ok(d.results[1]?.[0]?.includes("from a2 (composer agent, unverified)"));
  assert.deepEqual(rows(r, "message.taint").map((p) => [p["sourceId"], p["senderKind"]]), [[cli.messageId, "cli"], [unverified.messageId, "cli"]]);
});

test("quotas reach the model as closed reasons: sends per minute, a sender's queue at a recipient, reads per minute", async (t) => {
  const r = await deliveryRig(t, { messaging: true, noDelivery: true, limits: { sendsPerMinute: 2, queuePerSender: 1, readsPerMinute: 1 } });
  const runId = r.run("a1");
  const d = drive(r, runId, [[sendTo("a2", "one"), sendTo("a2", "two"), sendTo("b1", "cross"), readMsgs(), readMsgs()], []]);
  await d.end;
  const reasons = (d.results[1] ?? []).map((x) => /^The call was refused \((\w+)\)/.exec(x)?.[1] ?? "ok");
  assert.deepEqual(reasons, ["ok", "queue_full", "rate_limited", "ok", "rate_limited"]);
  assert.deepEqual(hopsTo(r, "a2"), [1]);
});

test("a read whose taint cannot be recorded is withheld and ends the run", async (t) => {
  let fail = false;
  const r = await deliveryRig(t, { messaging: true, noDelivery: true, failTaintAudit: () => fail });
  const runId = r.run("a1");
  await post(r, agent("a2"), "a1", "secret plan");
  fail = true;
  const d = drive(r, runId, [[readMsgs()], []]);
  const end = await d.end;
  assert.equal(end.state, "FAILED");
  assert.equal(d.seen.length, 1, "no request carried the result");
  assert.equal(r.c.journal.composer.tainted(runId), true, "tainted all the same");
});

test("units: the received hop only rises and a bad hop raises it to the cap; only a broker refusal carries a messaging reason", () => {
  assert.equal(raisedHop(2, 5), 5);
  assert.equal(raisedHop(5, 2), 5);
  for (const bad of [-1, MAX_HOP + 1, 1.5, "3", undefined, Number.NaN]) assert.equal(raisedHop(0, bad), MAX_HOP, String(bad));
  assert.equal(messagingReason(new Error("queue_full")), undefined);
});
