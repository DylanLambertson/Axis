// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageCaller } from "../src/index.js";
import { deliveryRig, type DeliveryRig } from "./messages-delivery-rig.js";

// PV-M3 slice 2, review 2 NITs 2 and 3: a check that throws on corrupt stored state is counted against its message and
// skipped, and the failure count is committed before the quarantine and its notice, so neither can hold a failing
// message out of quarantine. Review of that fix: a skipped candidate never holds back a later one, a message from the
// user is never quarantined for a failing check, and a notice that cannot be posted is reported as a code.

const USER: MessageCaller = { kind: "user" };
const a2: MessageCaller = { kind: "agent", agentId: "a2", runId: null, verified: true, receivedHop: 0 };
const failures = (r: DeliveryRig, id: string): number =>
  Number((r.c.db.prepare("SELECT failures FROM message_delivery_failures WHERE message_id = ? AND principal = 'agent:a1'").get(id) as { failures?: number } | undefined)?.failures ?? 0);
const poisoned = { receive: () => { throw new Error("audit down"); } };

test("a candidate whose check throws on corrupt stored settings is counted and skipped, never ends the run, and is quarantined at the limit", async (t) => {
  const r = await deliveryRig(t);
  const m = (await r.m.service.send(a2, { recipients: [{ agent: "a1" }], body: { format: "text", text: "hello" } })).message;
  r.m.settings.updateSettings(USER, { setting: "retentionDays", projectId: "p", value: 7 }); // stores the project's settings row
  r.c.db.prepare("UPDATE messaging_settings SET body = ? WHERE project_id = 'p'").run(JSON.stringify({ corrupt: true }));
  const runId = r.run("a1");
  for (let i = 1; i <= 3; i++) {
    assert.equal(r.m.delivery.next(runId, { receive: () => assert.fail("nothing is tainted for a skipped candidate") }), undefined, `attempt ${i}: skipped, not thrown`);
    assert.equal(failures(r, m.messageId), i);
  }
  assert.equal(r.c.journal.messages.deliveries.get(m.messageId, "agent:a1")?.state, "failed");
  assert.equal(r.c.audit.list({ limit: 1000 }).filter((e) => e.action === "message.deliver.failed").length, 1);
  assert.equal(r.c.journal.composer.tainted(runId), false);
});

test("the count is committed before the quarantine and the notice: a notice that cannot be posted still leaves the message quarantined", async (t) => {
  const r = await deliveryRig(t);
  const m = (await r.m.service.send(a2, { recipients: [{ agent: "a1" }], body: { format: "text", text: "poison" } })).message;
  // Every system message (the notice) is refused by the database from here on.
  r.c.db.exec("CREATE TEMP TRIGGER refuse_notice BEFORE INSERT ON agent_messages WHEN NEW.sender_key = 'system' BEGIN SELECT RAISE(ABORT, 'notice refused'); END;");
  for (let i = 1; i <= 3; i++) {
    assert.throws(() => r.m.delivery.next(r.run("a1"), poisoned), /audit down/);
    assert.equal(failures(r, m.messageId), i, `attempt ${i} counted`);
  }
  assert.equal(r.c.journal.messages.deliveries.get(m.messageId, "agent:a1")?.state, "failed", "quarantined although its notice failed");
  assert.equal(r.c.audit.list({ limit: 1000 }).filter((e) => e.action === "message.deliver.failed").length, 1);
  assert.equal(r.m.service.thread(USER, { threadId: m.threadId }).messages.some((x) => x.sender.kind === "system"), false, "no notice was posted");
  assert.deepEqual(r.codes, ["notice_failed"], "the swallowed notice failure is reported once, as a code");
  assert.equal(r.m.delivery.next(r.run("a1"), poisoned), undefined, "a quarantined message is never offered again");
});

test("a deliverable message after a candidate whose check throws is delivered at the same boundary", async (t) => {
  const r = await deliveryRig(t);
  const send = async (text: string) => (await r.m.service.send(a2, { recipients: [{ agent: "a1" }], body: { format: "text", text } })).message;
  const broken = await send("first");
  const fine = await send("second");
  // A sender record corrupted outside Axis: the policy re-check throws on it.
  r.c.db.exec("DROP TRIGGER agent_messages_immutable");
  r.c.db.prepare("UPDATE agent_messages SET sender = 'null' WHERE id = ?").run(broken.messageId);
  const batch = r.m.delivery.next(r.run("a1"), { receive: () => undefined });
  assert.deepEqual(batch?.messageIds, [fine.messageId], "the scan went on past the skipped candidate");
  assert.equal(failures(r, broken.messageId), 1);
  assert.equal(failures(r, fine.messageId), 0);
});

test("a message whose record cannot be read is counted, whoever sent it: its sender is unknown", async (t) => {
  const r = await deliveryRig(t);
  const mine = (await r.m.service.send(USER, { recipients: [{ agent: "a1" }], body: { format: "text", text: "unreadable" } })).message;
  const store = r.c.journal.messages;
  const read = store.message.bind(store);
  store.message = (id) => (id === mine.messageId ? assert.fail("the record cannot be read") : read(id));
  assert.equal(r.m.delivery.next(r.run("a1"), { receive: () => undefined }), undefined);
  assert.equal(failures(r, mine.messageId), 1);
});

test("a project-wide fault never quarantines the user's own message: it stays queued and is delivered once the fault is gone", async (t) => {
  const r = await deliveryRig(t);
  const mine = (await r.m.service.send(USER, { recipients: [{ agent: "a1" }], body: { format: "text", text: "from the user" } })).message;
  const theirs = (await r.m.service.send(a2, { recipients: [{ agent: "a1" }], body: { format: "text", text: "from a2" } })).message;
  r.m.settings.updateSettings(USER, { setting: "retentionDays", projectId: "p", value: 7 });
  r.c.db.prepare("UPDATE messaging_settings SET body = ? WHERE project_id = 'p'").run(JSON.stringify({ corrupt: true }));
  const runId = r.run("a1");
  for (let i = 1; i <= 4; i++) assert.equal(r.m.delivery.next(runId, { receive: () => assert.fail("nothing is delivered") }), undefined);
  assert.equal(failures(r, mine.messageId), 0, "the user's message is never counted");
  assert.equal(r.c.journal.messages.deliveries.get(mine.messageId, "agent:a1"), undefined, "nor quarantined");
  assert.equal(r.c.journal.messages.deliveries.get(theirs.messageId, "agent:a1")?.state, "failed", "another sender's message is");
  const notices = (threadId: string) => r.m.service.thread(USER, { threadId }).messages.filter((x) => x.sender.kind === "system").length;
  assert.equal(notices(mine.threadId), 1, "one held notice for the user's own message (messages-delivery-held.test.ts), not a quarantine notice");
  assert.equal(notices(theirs.threadId), 1);
  r.c.db.prepare("DELETE FROM messaging_settings WHERE project_id = 'p'").run();
  assert.deepEqual(r.m.delivery.next(runId, { receive: () => undefined })?.messageIds, [mine.messageId], "delivered once the fault is gone");
});
