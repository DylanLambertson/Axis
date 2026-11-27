// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { READ_TASK, UPDATE_TASK, type TasksService } from "../src/index.js";
import { approveAll, denyAll, drive, type DeliveryRig } from "./messages-delivery-rig.js";
import { USER, call, task, tasksRig, worker } from "./tasks-rig.js";

// PV-T1 slice 3 (`docs/design/tasks-slice3.md` §3.1 and §4, RR-93): `update_task` asks the user whenever the revision at
// `baseSeq` is the user's, in every run, tainted or not, through the real broker, approvals and loop. The mutants each
// case kills: NO RAISE (a user base writes unasked), RAISE ON ANY AUTHOR (a worker base asks), and RAISE READ FROM THE
// NEWEST revision instead of `baseSeq` (the two base-not-newest cases decide in opposite directions).

type Rig = Awaited<ReturnType<typeof tasksRig>>;
const update = (taskId: string, baseSeq: number, body: string, title = "Fix it") => call(UPDATE_TASK, { taskId, baseSeq, title, body });
const refusal = (out: string | undefined): string | undefined => /^The call was refused \(([a-z_]+)\)/.exec(out ?? "")?.[1];
const decisions = (p: Rig) =>
  p.c.audit.list({ limit: 2000 }).filter((e) => e.action === "broker.decision" && (e.payload as Record<string, unknown>)["tool"] === UPDATE_TASK)
    .map((e) => { const x = e.payload as Record<string, unknown>; return [x["tier"], x["decision"]]; });
const last = (p: Rig, taskId: string) => {
  const g = p.svc.get({ taskId });
  return [g.task.lastSeq, g.revision.meta.author.kind] as const;
};
/** A task whose revision 1 is a worker's (w2) and, when `then` is given, revision 2 by `then`. */
function workerTask(p: Rig, then?: "user" | "agent") {
  const tk = p.svc.create(worker("w2", 1), { projectId: "p", title: "Fix it", body: "worker text" }).task;
  if (then !== undefined) p.svc.update(then === "user" ? USER : worker("w2", 1), { taskId: tk.taskId, baseSeq: 1, title: "Fix it", body: `${then} text` });
  return tk;
}
/** Answer every challenge until the run ends, calling `before` once just before the first answer. */
async function answerAll(r: DeliveryRig, end: Promise<unknown>, decision: "approve" | "deny", before: () => void): Promise<number> {
  let done = false;
  void end.finally(() => (done = true));
  let n = 0;
  while (!done) {
    const pending = ((await r.c.user.call("axis.approvals", "pending", {})).result?.["challenges"] ?? []) as { challengeId: string; digest: string }[];
    for (const ch of pending) {
      if (n === 0) before();
      await r.c.user.call("axis.approvals", "resolve", { challengeId: ch.challengeId, decision, digest: ch.digest });
      n++;
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  return n;
}

test("an untainted run, update_task over the user's revision: asks, at tier network; denied writes nothing; approved writes", async (t) => {
  const p = await tasksRig(t);
  const tk = task(p.svc);
  const denied = p.run("w1");
  const d1 = drive(p.r, denied, [[update(tk.taskId, 1, "user text\nmore")], []]);
  assert.equal(await denyAll(p.r, d1.end), 1, "the user was asked (kills NO RAISE)");
  assert.equal(refusal(d1.results[1]?.[0]), "approval_declined");
  assert.deepEqual(last(p, tk.taskId), [1, "user"], "nothing written");
  assert.equal(p.c.journal.composer.tainted(denied), false, "the raise asked, not taint");
  const card = d1.notes.find((n) => n.state === "requested");
  assert.equal(card?.preview?.content?.head, `Task: ${tk.taskId} (edits revision 1)\n\n@@ line 2: -0 +1\n+ more`);
  assert.equal(card?.reasons.includes("taint"), false);
  const approved = p.run("w1");
  const d2 = drive(p.r, approved, [[update(tk.taskId, 1, "user text\nmore")], []]);
  assert.equal(await approveAll(p.r, d2.end), 1);
  assert.equal(d2.results[1]?.[0], `wrote task ${tk.taskId}, revision 2`);
  assert.deepEqual(last(p, tk.taskId), [2, "agent"]);
  assert.deepEqual(decisions(p), [["network", "deny"], ["network", "approved"]], "broker.decision records the raised tier");
});

test("an untainted run, update_task over a worker's revision: writes without asking (kills RAISE ON ANY AUTHOR)", async (t) => {
  const p = await tasksRig(t);
  const tk = workerTask(p);
  const d = drive(p.r, p.run("w1"), [[update(tk.taskId, 1, "worker text\nmore")], []]);
  assert.equal(await denyAll(p.r, d.end), 0, "nothing was put to the user");
  assert.equal(d.results[1]?.[0], `wrote task ${tk.taskId}, revision 2`);
  assert.deepEqual(decisions(p), [["write", "allow"]]);
});

test("base, not newest: a worker base under a newer user revision asks nothing and is stale (kills NEWEST and ANY AUTHOR)", async (t) => {
  const p = await tasksRig(t);
  const tk = workerTask(p, "user");
  const d = drive(p.r, p.run("w1"), [[update(tk.taskId, 1, "worker text\nmore")], []]);
  assert.equal(await denyAll(p.r, d.end), 0, "no approval request: the base (revision 1) is a worker's");
  assert.equal(refusal(d.results[1]?.[0]), "stale_version");
  assert.deepEqual(last(p, tk.taskId), [2, "user"], "nothing written, the last seq stays 2");
});

test("base, not newest: a user base under a newer worker revision asks once at tier network, then is stale or declined (kills NEWEST and NO RAISE)", async (t) => {
  const p = await tasksRig(t);
  const tk = task(p.svc);
  p.svc.update(worker("w2", 1), { taskId: tk.taskId, baseSeq: 1, title: "Fix it", body: "worker text" });
  const d1 = drive(p.r, p.run("w1"), [[update(tk.taskId, 1, "user text\nmore")], []]);
  assert.equal(await approveAll(p.r, d1.end), 1, "exactly one card: the base (revision 1) is the user's");
  assert.equal(refusal(d1.results[1]?.[0]), "stale_version", "the store checks staleness when the call runs, after the card");
  assert.deepEqual(last(p, tk.taskId), [2, "agent"], "nothing written, the last seq stays 2");
  const d2 = drive(p.r, p.run("w1"), [[update(tk.taskId, 1, "user text\nmore")], []]);
  assert.equal(await denyAll(p.r, d2.end), 1);
  assert.equal(refusal(d2.results[1]?.[0]), "approval_declined");
  assert.deepEqual(last(p, tk.taskId), [2, "agent"]);
  assert.deepEqual(decisions(p), [["network", "approved"], ["network", "deny"]]);
});

test("a race on the path that does not ask: a user edit landing before the write is stale_version, and the user's edit stays", async (t) => {
  const p = await tasksRig(t);
  const tk = workerTask(p);
  const raced: TasksService = { ...p.svc, update: (caller, req) => {
    if (caller.kind === "agent") p.svc.update(USER, { taskId: req.taskId, baseSeq: 1, title: "Fix it", body: "the user's edit" });
    return p.svc.update(caller, req);
  } };
  p.use(raced);
  const d = drive(p.r, p.run("w1"), [[update(tk.taskId, 1, "worker text\nmore")], []]);
  assert.equal(await denyAll(p.r, d.end), 0);
  assert.equal(refusal(d.results[1]?.[0]), "stale_version");
  assert.deepEqual(last(p, tk.taskId), [2, "user"]);
  assert.equal(p.svc.get({ taskId: tk.taskId }).revision.body, "the user's edit");
});

test("a user edit between the card and the write: approved, then stale_version; the user's edit is never written over", async (t) => {
  const p = await tasksRig(t);
  const tk = task(p.svc);
  const d = drive(p.r, p.run("w1"), [[update(tk.taskId, 1, "user text\nmore")], []]);
  const n = await answerAll(p.r, d.end, "approve", () => void p.svc.update(USER, { taskId: tk.taskId, baseSeq: 1, title: "Fix it", body: "edited meanwhile" }));
  assert.equal(n, 1);
  assert.equal(refusal(d.results[1]?.[0]), "stale_version");
  assert.deepEqual(last(p, tk.taskId), [2, "user"]);
  assert.equal(p.svc.get({ taskId: tk.taskId }).revision.body, "edited meanwhile");
});

test("a user revision that kept a worker's text still asks: the raise follows the revision's author, not the text's trust", async (t) => {
  const p = await tasksRig(t);
  const tk = workerTask(p);
  p.svc.update(USER, { taskId: tk.taskId, baseSeq: 1, title: "Fix it", body: "worker text" });
  assert.equal(p.svc.get({ taskId: tk.taskId }).task.untrusted, true, "the task stays untrusted");
  const d = drive(p.r, p.run("w1"), [[update(tk.taskId, 2, "worker text\nmore")], []]);
  assert.equal(await denyAll(p.r, d.end), 1);
  assert.deepEqual(last(p, tk.taskId), [2, "user"]);
});

test("an untainted run's raised update the card cannot show whole: content-not-reviewable, no card, nothing written", async (t) => {
  const p = await tasksRig(t);
  const tk = task(p.svc);
  const d = drive(p.r, p.run("w1"), [[update(tk.taskId, 1, "z".repeat(3000))], []]);
  assert.equal(await denyAll(p.r, d.end), 0);
  assert.equal(refusal(d.results[1]?.[0]), "content_not_reviewable");
  assert.deepEqual(last(p, tk.taskId), [1, "user"]);
});

test("the refusals by case: no such revision is stale_version, an invisible task not_found, and in a tainted run content-not-reviewable; never a card", async (t) => {
  const p = await tasksRig(t);
  const mine = task(p.svc);
  const other = task(p.svc, "Q", "x", "q");
  const d = drive(p.r, p.run("w1"), [[update(mine.taskId, 9, "x"), update(other.taskId, 1, "x"), update("tnope", 1, "x")], []]);
  assert.equal(await denyAll(p.r, d.end), 0);
  assert.deepEqual(d.results[1]?.map(refusal), ["stale_version", "not_found", "not_found"], "another project's task and an unknown one look the same");
  const untrusted = workerTask(p);
  const tainted = p.run("w1");
  const d2 = drive(p.r, tainted, [[call(READ_TASK, { taskId: untrusted.taskId })], [update(other.taskId, 1, "x"), update("tnope", 1, "x")], []]);
  assert.equal(await denyAll(p.r, d2.end), 0, "no card for a task the run cannot see");
  assert.equal(p.c.journal.composer.tainted(tainted), true);
  assert.deepEqual(d2.results[2]?.map(refusal), ["content_not_reviewable", "content_not_reviewable"]);
  assert.deepEqual([last(p, mine.taskId), last(p, other.taskId)], [[1, "user"], [1, "user"]]);
});
