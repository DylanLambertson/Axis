// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { messagesMethods } from "@axis/protocol";
import { USER, agent, auditRows, messagesRig, outcome, plugin, sendReq, type MessagesRig } from "./messages-rig.js";

// Messaging settings, Pause and Resume, and the delivery hook (ticket PV-M3 slice 1; inter-agent-communication.md
// sections 4.1, 10 and gate lines 7 and 14).

function setup(t: { after(fn: () => void): void }): MessagesRig {
  const r = messagesRig();
  t.after(() => r.close());
  return r;
}

test("settings: the defaults, the project's agents with theirs, and only the user may read or change them", async (t) => {
  const r = setup(t);
  const st = r.binding.settings;
  const view = st.settings(USER, { projectId: "p1" });
  assert.ok(messagesMethods.settings.response.safeParse({ ...view, cliEndpoint: false }).success, "the service's view, with the switch the handler adds beside it");
  const { agents, ...rest } = view.settings;
  assert.deepEqual(rest, { projectId: "p1", crossGroup: false, crossGroupPairs: [], secretScan: "refuse", retentionDays: 30, paused: { project: false, groups: [], agents: [] } });
  assert.deepEqual(agents.map((a) => [a.agentId, a.kind, a.acceptsFrom, a.cliMessaging]), [["a1", "composer", "group", false], ["a2", "composer", "group", false], ["c1", "cli", "none", false], ["b1", "composer", "group", false]]);
  for (const caller of [agent("a1"), plugin("acme.bot")]) {
    assert.equal(await outcome(() => st.settings(caller, { projectId: "p1" })), "E_NOT_FOUND/not_found");
    assert.equal(await outcome(() => st.updateSettings(caller, { setting: "crossGroup", projectId: "p1", value: true })), "E_NOT_FOUND/not_found");
    assert.equal(await outcome(() => st.pause(caller, { scope: { project: "p1" } })), "E_NOT_FOUND/not_found");
    assert.equal(await outcome(() => st.resume(caller, { scope: { project: "p1" } })), "E_NOT_FOUND/not_found");
  }
  assert.equal(st.settings(USER, { projectId: "p1" }).settings.crossGroup, false, "nothing changed");
  for (const call of [
    () => st.settings(USER, { projectId: "nope" }),
    () => st.updateSettings(USER, { setting: "acceptsFrom", agentId: "ghost", value: "project" }),
    () => st.updateSettings(USER, { setting: "crossGroupPair", projectId: "p1", groups: ["g1", "gx"], value: true }),
    () => st.pause(USER, { scope: { group: "ghost" } }),
    () => st.pause(USER, { scope: { agent: "ghost" } }),
  ]) assert.equal(await outcome(call), "E_NOT_FOUND/not_found");
});

test("updateSettings: one setting per call, one audit row with its before and after; an unchanged value writes nothing", (t) => {
  const r = setup(t);
  const st = r.binding.settings;
  assert.equal(st.updateSettings(USER, { setting: "retentionDays", projectId: "p1", value: 7 }).changed, true);
  assert.equal(st.updateSettings(USER, { setting: "retentionDays", projectId: "p1", value: 7 }).changed, false);
  assert.equal(st.updateSettings(USER, { setting: "muted", agentId: "a1", value: true }).changed, true);
  const pair = st.updateSettings(USER, { setting: "crossGroupPair", projectId: "p1", groups: ["g1", "g2"], value: true });
  assert.deepEqual(pair.settings.crossGroupPairs, [["g1", "g2"]]);
  assert.equal(st.updateSettings(USER, { setting: "crossGroupPair", projectId: "p1", groups: ["g2", "g1"], value: true }).changed, false, "a pair is unordered");
  const rows = auditRows(r).filter((e) => e.action === "message.settings");
  assert.deepEqual(rows.map((e) => e.payload), [
    { projectId: "p1", setting: "retentionDays", before: 30, after: 7 },
    { projectId: "p1", agentId: "a1", setting: "muted", before: false, after: true },
    { projectId: "p1", setting: "crossGroupPair", groups: "g1,g2", before: false, after: true },
  ]);
  assert.ok(rows.every((e) => e.actor === "user"));
});

test("enabling an endpoint is refused (bypass_entry) until launch entries can be checked; disabling is allowed", async (t) => {
  const r = setup(t);
  const st = r.binding.settings;
  assert.equal(await outcome(() => st.updateSettings(USER, { setting: "cliMessaging", agentId: "c1", value: true })), "E_CONFLICT/bypass_entry");
  assert.equal(await outcome(() => st.updateSettings(USER, { setting: "cliMessaging", agentId: "a1", value: true })), "E_CONFLICT/bypass_entry");
  assert.equal(st.updateSettings(USER, { setting: "cliMessaging", agentId: "c1", value: false }).changed, false);
});

test("Pause stops sends from agents and plugins in scope, never the user; Resume restores; both are audited", async (t) => {
  const r = setup(t);
  const s = r.binding.service;
  const st = r.binding.settings;
  const a1 = agent("a1");
  assert.deepEqual(st.pause(USER, { scope: { agent: "a1" } }), { scope: { agent: "a1" }, paused: true, changed: true });
  assert.equal(await outcome(() => s.send(a1, sendReq([{ user: true }]))), "E_CONFLICT/paused");
  assert.equal(await outcome(() => s.send(agent("a2"), sendReq([{ user: true }]))), "ok", "another agent of the group");
  assert.equal(st.pause(USER, { scope: { agent: "a1" } }).changed, false);
  st.resume(USER, { scope: { agent: "a1" } });
  st.pause(USER, { scope: { group: "g1" } });
  assert.equal(await outcome(() => s.send(agent("a2"), sendReq([{ user: true }]))), "E_CONFLICT/paused", "the group");
  assert.equal(await outcome(() => s.send(agent("b1"), sendReq([{ user: true }]))), "ok", "another group");
  st.resume(USER, { scope: { group: "g1" } });
  st.pause(USER, { scope: { project: "p1" } });
  const thread = (await s.send(USER, sendReq([{ agent: "a1" }], "the user is never paused"))).message.threadId;
  assert.equal(await outcome(() => s.send(a1, sendReq([{ user: true }], "x", { threadId: thread }))), "E_CONFLICT/paused", "the project, inside a thread too");
  assert.equal(await outcome(() => s.send(plugin("acme.bot"), sendReq([{ user: true }], "x", { threadId: thread }))), "E_NOT_FOUND/not_found", "a plugin the user did not add");
  assert.deepEqual(st.resume(USER, { scope: { project: "p1" } }), { scope: { project: "p1" }, paused: false, changed: true });
  assert.equal(await outcome(() => s.send(a1, sendReq([{ user: true }], "x", { threadId: thread }))), "ok");
  const rows = auditRows(r).filter((e) => e.action === "message.pause" || e.action === "message.resume");
  assert.deepEqual(rows.map((e) => [e.action, e.payload["scopeKind"], e.payload["changed"]]), [
    ["message.pause", "agent", true], ["message.pause", "agent", false], ["message.resume", "agent", true],
    ["message.pause", "group", true], ["message.resume", "group", true], ["message.pause", "project", true], ["message.resume", "project", true],
  ]);
});

test("the delivery hook re-checks the policy and Pause of the moment (gate line 14), only for an addressed recipient", async (t) => {
  const r = setup(t);
  const s = r.binding.service;
  const st = r.binding.settings;
  st.updateSettings(USER, { setting: "crossGroup", projectId: "p1", value: true });
  st.updateSettings(USER, { setting: "acceptsFrom", agentId: "b1", value: "project" });
  const m = (await s.send(agent("a1"), sendReq([{ agent: "b1" }], "cross"))).message;
  const b1 = { kind: "agent" as const, agentId: "b1" };
  assert.equal(s.deliverable(m.messageId, b1), null);
  assert.equal(s.deliverable(m.messageId, { kind: "agent", agentId: "a2" }), "not_found", "not addressed to a2");
  assert.equal(s.deliverable("msg_AAAAAAAAAAAAAAAAAAAAAA", b1), "not_found");
  st.updateSettings(USER, { setting: "crossGroup", projectId: "p1", value: false });
  assert.equal(s.deliverable(m.messageId, b1), "recipient_refused", "accepted under cross-group, not delivered after it is off");
  st.updateSettings(USER, { setting: "crossGroup", projectId: "p1", value: true });
  st.pause(USER, { scope: { agent: "b1" } });
  assert.equal(s.deliverable(m.messageId, b1), "paused", "a paused recipient gets nothing; the message stays queued");
  st.resume(USER, { scope: { agent: "b1" } });
  st.pause(USER, { scope: { agent: "a1" } });
  assert.equal(s.deliverable(m.messageId, b1), "paused", "nor from a paused sender");
  st.resume(USER, { scope: { agent: "a1" } });
  st.updateSettings(USER, { setting: "acceptsFrom", agentId: "b1", value: "none" });
  assert.equal(s.deliverable(m.messageId, b1), "recipient_refused");
  r.agents.delete("a1");
  assert.equal(s.deliverable(m.messageId, b1), "recipient_refused", "a sender no longer in the project");
  assert.equal(s.read(agent("b1"), {}).messages.length, 1, "slice 1 queues; nothing was dropped");
});
