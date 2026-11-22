// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { READ_MESSAGES, WITHHELD_BODY, type MessageCaller } from "../src/index.js";
import { deliveryRig, drive, type DeliveryRig } from "./messages-delivery-rig.js";

// messages-contract.md section 11: a body is withheld from a composer run (a read or a delivery) when the host redactor's
// check matches its stored RAW text or its escaped display text. A registered secret holding a control, bidi or zero-width
// character shows only escaped (`\u{hex}`), which the escaped check alone misses. A backslash was never a gap (the redactor
// knows each secret's JSON-escaped form); its case stays as a guard.

const USER: MessageCaller = { kind: "user" };
const a2: MessageCaller = { kind: "agent", agentId: "a2", runId: null, verified: true, receivedHop: 0 };
const post = async (r: DeliveryRig, from: MessageCaller, text: string) => (await r.m.service.send(from, { recipients: [{ agent: "a1" }], body: { format: "text", text } })).message;
const taints = (r: DeliveryRig) => r.c.audit.list({ limit: 2000 }).filter((e) => e.action === "message.taint").map((e) => (e.payload as Record<string, unknown>)["sourceId"]);
const sink = () => ({ receive: () => undefined });

const SPLIT: readonly { label: string; secret: string; shown: string }[] = [
  { label: "a backslash", secret: "pear\\orchard-7", shown: "pear\\\\orchard-7" },
  { label: "a control character (BEL)", secret: "pear\u0007orchard-7", shown: "pear\\u{7}orchard-7" },
  { label: "a bidi override", secret: "pear‮orchard-7", shown: "pear\\u{202e}orchard-7" },
  { label: "a zero-width joiner", secret: "pear‍orchard-7", shown: "pear\\u{200d}orchard-7" },
];

for (const s of SPLIT) {
  test(`a registered secret holding ${s.label} is withheld from read_messages and from a delivery; the message still taints`, async (t) => {
    const r = await deliveryRig(t, { messaging: true, noDelivery: true });
    r.c.redactor.registerSecret(s.secret);
    const m = await post(r, a2, `the key is ${s.secret} ok`);
    assert.ok(m.body.text.includes(s.shown), "the escaped form is what a reader would get");
    const runId = r.run("a1");
    const d = drive(r, runId, [[{ name: READ_MESSAGES, input: {} }], []]);
    await d.end;
    const text = d.results[1]?.[0] ?? "";
    assert.ok(text.includes(`| ${WITHHELD_BODY}`), text.slice(0, 300));
    assert.ok(!text.includes(s.shown) && !text.includes("orchard-7"), "neither form reaches the model");
    assert.deepEqual(taints(r), [m.messageId], "still a taint receipt");
    const block = r.m.delivery.next(r.run("a1"), sink());
    assert.ok(block !== undefined);
    assert.ok(block.text.includes(`| ${WITHHELD_BODY}`) && !block.text.includes("orchard-7"), "the delivery withholds it too");
  });
}

test("a plain registered secret is still withheld (the escaped text is checked too), from a read and a delivery", async (t) => {
  const r = await deliveryRig(t, { messaging: true, noDelivery: true });
  r.c.redactor.registerSecret("plum orchard quietly");
  await post(r, a2, "key: plum orchard quietly");
  const d = drive(r, r.run("a1"), [[{ name: READ_MESSAGES, input: {} }], []]);
  await d.end;
  assert.ok((d.results[1]?.[0] ?? "").includes(`| ${WITHHELD_BODY}`));
  assert.ok(r.m.delivery.next(r.run("a1"), sink())?.text.includes(`| ${WITHHELD_BODY}`));
});

test("a secret that exists only in the escaped form (registered as the literal text `\\u{7}`) is withheld through the escaped check", async (t) => {
  const r = await deliveryRig(t, { messaging: true, noDelivery: true });
  r.c.redactor.registerSecret("pear\\u{7}orchard-7");
  await post(r, a2, "key: pear\u0007orchard-7");
  const d = drive(r, r.run("a1"), [[{ name: READ_MESSAGES, input: {} }], []]);
  await d.end;
  assert.ok((d.results[1]?.[0] ?? "").includes(`| ${WITHHELD_BODY}`));
  assert.ok(r.m.delivery.next(r.run("a1"), sink())?.text.includes(`| ${WITHHELD_BODY}`));
});

test("only message ids leave the service: readWithheld's extra field is a set of ids, and the participation result carries no raw text", async (t) => {
  const r = await deliveryRig(t, { messaging: true, noDelivery: true });
  r.c.redactor.registerSecret("pear\\orchard-7");
  const m = await post(r, a2, "key pear\\orchard-7");
  const clean = await post(r, a2, "nothing here");
  const seen: string[] = [];
  const out = r.m.service.readWithheld({ kind: "agent", agentId: "a1", runId: null, verified: true, receivedHop: 0 }, {}, (text) => (seen.push(text), text.includes("pear\\orchard-7")));
  assert.deepEqual([...out.withheld], [m.messageId]);
  assert.deepEqual(Object.keys(out).sort(), ["messages", "more", "withheld"]);
  assert.ok(seen.includes("key pear\\orchard-7"), "the predicate saw the raw text, inside the service");
  assert.ok(out.messages.every((x) => !x.body.text.includes("pear\\orchard-7")), "the reply itself carries only escaped text");
  assert.ok(out.messages.some((x) => x.messageId === clean.messageId));
});

test("the user's bridge read is unchanged: the user sees their own messages escaped, with nothing withheld", async (t) => {
  const r = await deliveryRig(t, { messaging: true, noDelivery: true });
  r.c.redactor.registerSecret("pear\\orchard-7");
  await r.m.service.send(a2, { recipients: [{ user: true }], body: { format: "text", text: "for you: pear\\orchard-7" } });
  const out = r.m.service.read(USER, {});
  assert.deepEqual(Object.keys(out).sort(), ["messages", "more"]);
  assert.equal(out.messages[0]?.body.text, "for you: pear\\\\orchard-7");
});

test("the delivery audit row says whether the body was withheld (a boolean, never text)", async (t) => {
  const r = await deliveryRig(t, { messaging: true, noDelivery: true });
  r.c.redactor.registerSecret("pear\u0007orchard-7");
  const secret = await post(r, a2, "key pear\u0007orchard-7");
  const plain = await post(r, a2, "nothing here");
  r.m.delivery.next(r.run("a1"), sink())?.ack();
  const rows = r.c.audit.list({ limit: 2000 }).filter((e) => e.action === "message.deliver").map((e) => e.payload as Record<string, unknown>);
  assert.deepEqual(rows.map((p) => [p["messageId"], p["withheld"]]), [[secret.messageId, true], [plain.messageId, false]]);
});

/** A redactor that throws on any text holding `THROW-ME` (the check it backs then throws). */
function throwingCheck(r: DeliveryRig): void {
  const real = r.c.redactor.redactString.bind(r.c.redactor);
  r.c.redactor.redactString = (text: string): string => {
    if (text.includes("THROW-ME")) throw new Error("check failed");
    return real(text);
  };
}

test("review N1: a secret check that throws on a read fails closed: the call fails, nothing of the message is shown, the run goes on", async (t) => {
  const r = await deliveryRig(t, { messaging: true, noDelivery: true });
  await post(r, a2, "THROW-ME visible?");
  throwingCheck(r);
  const d = drive(r, r.run("a1"), [[{ name: READ_MESSAGES, input: {} }], []]);
  assert.deepEqual(await d.end, { state: "REVIEWING", reason: null });
  const out = d.results[1]?.[0] ?? "";
  assert.match(out, /^The call was refused \(/);
  assert.ok(!out.includes("visible?") && !out.includes("THROW-ME"));
});

test("review N1/N2: a secret check that throws on a delivery fails the run closed, releases the leases it took and counts the failure", async (t) => {
  const r = await deliveryRig(t, { messaging: true, noDelivery: true });
  const first = await post(r, a2, "an earlier clean message");
  const bad = await post(r, a2, "THROW-ME visible?");
  throwingCheck(r);
  const runId = r.run("a1");
  assert.throws(() => r.m.delivery.next(runId, sink()), /check failed/);
  assert.equal(r.c.journal.messages.deliveries.get(first.messageId, "agent:a1"), undefined, "the earlier lease was released");
  assert.equal(r.c.journal.messages.deliveries.get(bad.messageId, "agent:a1"), undefined);
  const failures = (r.c.db.prepare("SELECT failures FROM message_delivery_failures WHERE message_id = ? AND principal = 'agent:a1'").get(bad.messageId) as { failures?: number } | undefined)?.failures;
  assert.equal(failures, 1, "the failure is counted against that message");
});
