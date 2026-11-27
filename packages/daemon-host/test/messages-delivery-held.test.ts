// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { encodeMessagingId } from "@axis/protocol";
import { createMessagingBinding, heldNotice, hostMessagingDeps, type MessageCaller } from "../src/index.js";
import { deliveryRig, type DeliveryRig } from "./messages-delivery-rig.js";

// PV-M3 delivery, review of the nits fix: the user-message exemption covers failing checks only (a failure after the
// lease is counted for every sender); a user message held by a failing check is shown to the user once; the log hook
// is wired through a testable seam and cannot end a run by throwing.

const USER: MessageCaller = { kind: "user" };
const a2: MessageCaller = { kind: "agent", agentId: "a2", runId: null, verified: true, receivedHop: 0 };
const failures = (r: DeliveryRig, id: string): number =>
  Number((r.c.db.prepare("SELECT failures FROM message_delivery_failures WHERE message_id = ? AND principal = 'agent:a1'").get(id) as { failures?: number } | undefined)?.failures ?? 0);
const notices = (r: DeliveryRig, threadId: string) => r.m.service.thread(USER, { threadId }).messages.filter((x) => x.sender.kind === "system");
const sink = { receive: () => undefined };
/**
 * True when a notice names one of the recipients. The notice carries a random message id (base64url, so it can contain
 * "a1"), which is removed first; a recipient then counts only as a whole identifier, never inside another word.
 */
const namesRecipient = (text: string, messageId: string, recipients: readonly string[]): boolean => {
  const rest = text.split(messageId).join(" ");
  return recipients.some((id) => new RegExp(`(?<![A-Za-z0-9_-])${id}(?![A-Za-z0-9_-])`).test(rest));
};
/** Store the project's settings row, then corrupt it: every check of the project throws. */
const corruptSettings = (r: DeliveryRig) => {
  r.m.settings.updateSettings(USER, { setting: "retentionDays", projectId: "p", value: 7 });
  r.c.db.prepare("UPDATE messaging_settings SET body = ? WHERE project_id = 'p'").run(JSON.stringify({ corrupt: true }));
};
const sendMine = async (r: DeliveryRig, text = "from the user") => (await r.m.service.send(USER, { recipients: [{ agent: "a1" }], body: { format: "text", text } })).message;

test("a user message that fails after its check (the lease write) is counted and quarantined, so it cannot end every run", async (t) => {
  const r = await deliveryRig(t);
  const mine = await sendMine(r);
  // The lease is refused by the database; the quarantine row (state failed) is not.
  r.c.db.exec("CREATE TEMP TRIGGER refuse_lease BEFORE INSERT ON message_deliveries WHEN NEW.state = 'leased' BEGIN SELECT RAISE(ABORT, 'lease refused'); END;");
  for (let i = 1; i <= 3; i++) {
    assert.throws(() => r.m.delivery.next(r.run("a1"), sink), /Database error/, `attempt ${i} ends its run`);
    assert.equal(failures(r, mine.messageId), i, `attempt ${i} counted`);
  }
  assert.equal(r.c.journal.messages.deliveries.get(mine.messageId, "agent:a1")?.state, "failed");
  r.c.db.exec("DROP TRIGGER refuse_lease");
  assert.equal(r.m.delivery.next(r.run("a1"), sink), undefined, "never offered again: the next run goes on");
  assert.match(notices(r, mine.threadId).at(-1)?.body.text ?? "", /set aside/);
});

test("a user message held by a failing check is shown to the user once, after the limit, and stays queued", async (t) => {
  const r = await deliveryRig(t);
  const mine = await sendMine(r);
  corruptSettings(r);
  const runId = r.run("a1");
  for (let i = 1; i <= 2; i++) assert.equal(r.m.delivery.next(runId, sink), undefined);
  assert.equal(notices(r, mine.threadId).length, 0, "no notice below the limit");
  for (let i = 3; i <= 8; i++) assert.equal(r.m.delivery.next(runId, sink), undefined);
  const told = notices(r, mine.threadId);
  assert.equal(told.length, 1, "one notice, not one per boundary");
  // Exact: every participant of the thread, the agents included, can read the notice, so it carries nothing else.
  assert.equal(told[0]?.body.text, `Axis could not check message ${mine.messageId} for delivery because of an error in Axis. It stays queued and will be delivered once the error is fixed.`);
  assert.equal(told[0]?.inReplyTo, mine.messageId);
  assert.equal(failures(r, mine.messageId), 0, "never counted");
  assert.equal(r.c.journal.messages.deliveries.get(mine.messageId, "agent:a1"), undefined, "never quarantined");
  // A host restart forgets the counts in memory; the notice already in the thread keeps it from being repeated.
  const restarted = createMessagingBinding({
    holdsSecret: () => false,
    journal: r.c.journal,
    audit: r.c.audit,
    random: { bytes: (n) => randomBytes(n) },
    monotonic: () => r.c.r.clock.monotonic(),
    scan: async () => [],
    directory: { project: (id) => id === "p", agent: (id) => r.agents.get(id), group: () => undefined, agents: () => [...r.agents.values()] },
    agentOf: () => "a1",
    runLive: () => true,
  });
  for (let i = 0; i < 4; i++) assert.equal(restarted.delivery.next(runId, sink), undefined);
  assert.equal(notices(r, mine.threadId).length, 1, "not repeated after a restart");
  r.c.db.prepare("DELETE FROM messaging_settings WHERE project_id = 'p'").run();
  assert.deepEqual(r.m.delivery.next(runId, sink)?.messageIds, [mine.messageId], "delivered once the fault is gone");
});

test("a held notice is counted per message: each held user message is shown once", async (t) => {
  const r = await deliveryRig(t);
  const first = await sendMine(r, "one");
  const second = await sendMine(r, "two");
  corruptSettings(r);
  const runId = r.run("a1");
  for (let i = 0; i < 3; i++) r.m.delivery.next(runId, sink);
  assert.equal(notices(r, first.threadId).length, 1);
  assert.equal(notices(r, second.threadId).length, 1);
});

test("a user message held for two recipients gets one notice, naming neither", async (t) => {
  const r = await deliveryRig(t);
  const both = (await r.m.service.send(USER, { recipients: [{ agent: "a1" }, { agent: "a2" }], body: { format: "text", text: "to both" } })).message;
  corruptSettings(r);
  const [run1, run2] = [r.run("a1"), r.run("a2")];
  for (let i = 0; i < 4; i++) {
    assert.equal(r.m.delivery.next(run1, sink), undefined);
    assert.equal(r.m.delivery.next(run2, sink), undefined);
  }
  const told = notices(r, both.threadId);
  assert.equal(told.length, 1, "one notice per message");
  assert.equal(told[0]?.body.text, `Axis could not check message ${both.messageId} for delivery because of an error in Axis. It stays queued and will be delivered once the error is fixed.`);
  assert.equal(namesRecipient(told[0]?.body.text ?? "", both.messageId, ["a1", "a2"]), false, "names neither recipient");
});

test("the recipient check ignores the random message id and still catches a notice that names a recipient", () => {
  // An id that holds a recipient's name, as a random id sometimes does (seen in CI: msg_UELa1kKD9JTf3I4l-430Ow).
  const unlucky = "msg_UELa1kKD9JTf3I4l-430Ow";
  assert.equal(namesRecipient(heldNotice(unlucky), unlucky, ["a1", "a2"]), false);
  assert.equal(namesRecipient(heldNotice(unlucky).replace("for delivery", "for delivery to agent a1"), unlucky, ["a1", "a2"]), true, "a notice naming a recipient fails");
  assert.equal(namesRecipient(heldNotice(unlucky).replace("for delivery", "for delivery to a2"), unlucky, ["a1", "a2"]), true);
  for (let i = 0; i < 2_000; i++) {
    const id = encodeMessagingId("message", randomBytes(16));
    assert.equal(namesRecipient(heldNotice(id), id, ["a1", "a2"]), false, `no false failure for ${id}`);
  }
});

test("a held notice that cannot be posted is tried again at the next failed check, then never again", async (t) => {
  const r = await deliveryRig(t);
  const mine = await sendMine(r);
  corruptSettings(r);
  r.c.db.exec("CREATE TEMP TRIGGER refuse_notice BEFORE INSERT ON agent_messages WHEN NEW.sender_key = 'system' BEGIN SELECT RAISE(ABORT, 'notice refused'); END;");
  const runId = r.run("a1");
  for (let i = 0; i < 3; i++) r.m.delivery.next(runId, sink);
  assert.deepEqual(r.codes, ["notice_failed"], "the first try at the limit failed");
  r.m.delivery.next(runId, sink);
  assert.deepEqual(r.codes, ["notice_failed", "notice_failed"], "tried again at the next failed check");
  r.c.db.exec("DROP TRIGGER refuse_notice");
  r.m.delivery.next(runId, sink);
  assert.equal(notices(r, mine.threadId).length, 1, "posted once the database takes it");
  // Once posted, the message is marked told in memory: it is not even looked up again.
  const store = r.c.journal.messages;
  const replied = store.systemReplied.bind(store);
  let lookups = 0;
  store.systemReplied = (id) => (lookups++, replied(id));
  for (let i = 0; i < 2 * 3; i++) r.m.delivery.next(runId, sink); // twice the limit, so a count restarted from the mark would fire
  assert.equal(lookups, 0, "never tried again after it was posted");
  assert.equal(notices(r, mine.threadId).length, 1);
  assert.equal(r.codes.length, 2);
});

test("a log hook that throws never ends the run, on the check path of any sender", async (t) => {
  const r = await deliveryRig(t, { onInternalError: () => { throw new Error("log down"); } });
  const mine = await sendMine(r);
  const theirs = (await r.m.service.send(a2, { recipients: [{ agent: "a1" }], body: { format: "text", text: "from a2" } })).message;
  corruptSettings(r);
  r.c.db.exec("CREATE TEMP TRIGGER refuse_notice BEFORE INSERT ON agent_messages WHEN NEW.sender_key = 'system' BEGIN SELECT RAISE(ABORT, 'notice refused'); END;");
  const runId = r.run("a1");
  for (let i = 1; i <= 3; i++) assert.equal(r.m.delivery.next(runId, sink), undefined, `boundary ${i} goes on`);
  assert.deepEqual(r.codes, ["notice_failed", "notice_failed"], "the held notice and the quarantine notice both failed and were reported");
  assert.equal(r.c.journal.messages.deliveries.get(theirs.messageId, "agent:a1")?.state, "failed");
  assert.equal(r.c.journal.messages.deliveries.get(mine.messageId, "agent:a1"), undefined);
});

test("the host wiring logs a swallowed delivery failure by code and reads live runs from the journal", () => {
  const logged: unknown[] = [];
  const journal = { messages: {}, agents: {}, getProject: () => undefined, getRun: (id: string) => (id === "live" ? { state: "RUNNING" } : { state: "SUCCEEDED" }), cliEndpoint: { enabled: () => false } } as unknown as Parameters<typeof hostMessagingDeps>[0]["journal"];
  const deps = hostMessagingDeps({ journal, audit: { append: () => undefined }, monotonic: () => 0, scan: async () => [], holdsSecret: () => false, logger: { warn: (...a: unknown[]) => void logged.push(a) } });
  deps.onInternalError?.("notice_failed");
  assert.deepEqual(logged, [["request.failed", { reason: "delivery_notice_failed" }]]);
  assert.equal(deps.runLive?.("live"), true);
  assert.equal(deps.runLive?.("done"), false);
  assert.equal(deps.random.bytes(16).length, 16);
  assert.doesNotThrow(() => hostMessagingDeps({ journal, audit: { append: () => undefined }, monotonic: () => 0, scan: async () => [], holdsSecret: () => false, logger: undefined }).onInternalError?.("notice_failed"));
});
