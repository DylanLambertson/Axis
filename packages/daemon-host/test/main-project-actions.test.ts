// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createProjectActions, MAX_COOLDOWNS, type ProjectActionsOptions, type ProjectDialog } from "../src/main/project-actions.js";
import { NativeQueue, type ChoiceRequest } from "../src/main/native-queue.js";

// Main's project actions (docs/design/project-registration-and-trust.md §4).

type Sent = Record<string, unknown>;
const FOLDER = "/home/u/src/repo";
const inspected = (over: Record<string, unknown> = {}) => ({ ok: true, commonDir: `${FOLDER}/.git`, remoteKnown: true, remote: { name: "origin", url: "https://github.com/o/r.git" }, remotes: 1, ...over });

function rig(o: { answers?: (m: Sent) => Record<string, unknown> | undefined; press?: number[] | ((d: ProjectDialog) => number); model?: boolean; folder?: string | undefined; send?: boolean; timeoutMs?: number } = {}) {
  const sent: Sent[] = [];
  const shown: ProjectDialog[] = [];
  let now = 0;
  const presses = Array.isArray(o.press) ? [...o.press] : undefined;
  let actions!: ReturnType<typeof createProjectActions>;
  const opts: ProjectActionsOptions = {
    send: (m) => {
      if (o.send === false) return false;
      sent.push(m as Sent);
      const body = (o.answers ?? (() => undefined))(m as Sent) ?? (m.type === "projects.inspect" ? inspected() : { ok: true, projectId: "p-1" });
      queueMicrotask(() => actions.answer({ type: m.type === "projects.inspect" ? "projects.inspected" : "projects.result", requestId: m.requestId, ...body } as never));
      return true;
    },
    choose: (c: ChoiceRequest) => void c.show(c.codeWindowId, new AbortController().signal).then((index) => c.done({ index }), () => c.done({ refused: "dialog_failed" })),
    show: async (_w, d) => (shown.push(d), typeof o.press === "function" ? o.press(d) : presses?.shift() ?? 0),
    windowFolder: () => ("folder" in o ? o.folder : FOLDER),
    workspaceTrusted: () => o.model ?? true,
    now: () => now,
    ...(o.timeoutMs === undefined ? {} : { requestTimeoutMs: o.timeoutMs }),
  };
  actions = createProjectActions(opts);
  return { actions, sent, shown, tick: (ms: number) => void (now += ms) };
}
const act = (r: ReturnType<typeof rig>, action: string, w = 1) => r.actions.act(w, { nonce: "n1", action }).then((x) => x?.outcome);

test("the payload is strict: a nonce and an action only; a path, a project id or a bad nonce is refused without an answer", async () => {
  const r = rig();
  for (const bad of [{ nonce: "n", action: "add", path: "/etc" }, { nonce: "n", action: "add", projectId: "p" }, { nonce: "bad nonce", action: "add" }, { nonce: "n", action: "own" }, { action: "add" }, null, "add"]) {
    assert.equal(await r.actions.act(1, bad), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(r.sent, [], "nothing reached the host");
});

test("add: main inspects ITS window's folder, shows the dialog, and registers as the user chose", async () => {
  const trusted = rig({ press: [2] });
  assert.equal(await act(trusted, "add"), "added");
  assert.deepEqual(trusted.sent.map((m) => [m.type, m.path, m.trusted]), [["projects.inspect", FOLDER, undefined], ["projects.register", FOLDER, true]]);
  assert.equal(trusted.sent[1]?.commonDir, `${FOLDER}/.git`, "the inspected binding is what main registers");
  const d = trusted.shown[0] as ProjectDialog;
  assert.deepEqual(d.buttons, ["Cancel", "Add read-only", "Add and trust to run"], "Cancel first: the default and cancel id");
  assert.match(d.detail, /Folder: \/home\/u\/src\/repo/);
  assert.match(d.detail, /Remote \(as configured in the repository, not verified\): origin https:\/\/github\.com\/o\/r\.git/);
  const readOnly = rig({ press: [1] });
  assert.equal(await act(readOnly, "add"), "added_read_only");
  assert.equal(readOnly.sent[1]?.trusted, false);
});

test("add: while the workbench does not trust the folder, only Add read-only is offered (mutant: grant offered anyway)", async () => {
  const r = rig({ model: false, press: [2] });
  assert.equal(await act(r, "add"), "cancelled", "an index past the offered buttons grants nothing");
  assert.deepEqual(r.shown[0]?.buttons, ["Cancel", "Add read-only"]);
  assert.match(r.shown[0]?.detail ?? "", /trust the folder in the workbench first/);
  assert.equal(r.sent.some((m) => m.type === "projects.register"), false);
});

test("trust: only a registered, untrusted project whose folder the workbench trusts; the dialog's Trust to run sends the binding", async () => {
  const reg = (trusted: boolean) => (m: Sent) => (m.type === "projects.inspect" ? inspected({ registered: { projectId: "p-1", trusted } }) : undefined);
  const r = rig({ answers: reg(false), press: [1] });
  assert.equal(await act(r, "trust"), "trusted");
  assert.deepEqual(r.sent[1], { type: "projects.trust", projectId: "p-1", path: FOLDER, commonDir: `${FOLDER}/.git`, trusted: true, requestId: r.sent[1]?.requestId });
  assert.deepEqual(r.shown[0]?.buttons, ["Cancel", "Trust to run"]);
  assert.equal(await act(rig({ answers: reg(false), model: false, press: [1] }), "trust"), "refused", "the model does not trust the folder now");
  assert.equal(await act(rig({ press: [1] }), "trust"), "refused", "not registered");
  const already = rig({ answers: reg(true) });
  assert.equal(await act(already, "trust"), "trusted");
  assert.equal(already.shown.length, 0, "no dialog for nothing");
});

test("untrust needs no dialog and only lowers privilege", async () => {
  const r = rig({ answers: (m) => (m.type === "projects.inspect" ? inspected({ registered: { projectId: "p-1", trusted: true } }) : undefined) });
  assert.equal(await act(r, "untrust"), "untrusted");
  assert.equal(r.shown.length, 0);
  assert.deepEqual([r.sent[1]?.type, r.sent[1]?.trusted, "commonDir" in (r.sent[1] ?? {})], ["projects.trust", false, false]);
});

test("Cancel and expiry start a 60 s cooldown for that action and folder (mutant: no cooldown); it lifts after 60 s", async () => {
  const r = rig({ press: [0, 2] });
  assert.equal(await act(r, "add"), "cancelled");
  assert.equal(await act(r, "add"), "busy");
  assert.equal(r.shown.length, 1, "no second prompt");
  r.tick(60_001);
  assert.equal(await act(r, "add"), "added");
  // Expiry (the queue's lifetime ran out) counts the same.
  let a!: ReturnType<typeof createProjectActions>;
  let shows = 0;
  a = createProjectActions({
    send: (m) => (queueMicrotask(() => a.answer({ type: "projects.inspected", requestId: m.requestId, ...inspected() } as never)), true),
    choose: (c) => (shows++, c.done({ refused: "expired" })),
    show: async () => 0,
    windowFolder: () => FOLDER,
    workspaceTrusted: () => true,
    now: () => 0,
  });
  assert.equal((await a.act(1, { nonce: "n", action: "add" }))?.outcome, "expired");
  assert.equal((await a.act(2, { nonce: "n", action: "add" }))?.outcome, "busy", "the same folder cools down after an expiry too");
  assert.equal(shows, 1);
  assert.equal(a.answer({ type: "projects.inspected", requestId: "unknown" } as never), false, "an unknown request id answers nothing");
});

test("the cooldown map is bounded: at 64 folders the oldest goes first", async () => {
  let folder = "/f/0";
  let now = 0;
  const a = createProjectActions({
    send: (m) => (queueMicrotask(() => a.answer({ type: m.type === "projects.inspect" ? "projects.inspected" : "projects.result", requestId: m.requestId, ...inspected() } as never)), true),
    choose: (c) => void c.show(c.codeWindowId, new AbortController().signal).then((index) => c.done({ index })),
    show: async () => 0,
    windowFolder: () => folder,
    workspaceTrusted: () => true,
    now: () => now,
  });
  for (let i = 0; i <= MAX_COOLDOWNS; i++) {
    folder = `/f/${i}`;
    now += 10_000; // past the rate limit
    assert.equal((await a.act(i, { nonce: "n", action: "add" }))?.outcome, "cancelled");
  }
  folder = "/f/0";
  assert.equal((await a.act(999, { nonce: "n", action: "add" }))?.outcome, "cancelled", "the oldest was evicted, so it prompts again");
  folder = `/f/${MAX_COOLDOWNS}`;
  assert.equal((await a.act(998, { nonce: "n", action: "add" }))?.outcome, "busy", "the newest is still cooling down");
});

test("per window: one action at a time and at most 6 a minute; nonce reuse is harmless (every grant needs a fresh click)", async () => {
  const r = rig({ press: () => 1 });
  const first = r.actions.act(1, { nonce: "n1", action: "add" });
  assert.equal((await r.actions.act(1, { nonce: "n1", action: "add" }))?.outcome, "busy", "one in flight per window");
  assert.equal((await first)?.outcome, "added_read_only");
  const many = [];
  for (let i = 0; i < 6; i++) many.push((await r.actions.act(2, { nonce: "same", action: "untrust" }))?.outcome);
  assert.equal(many.includes("busy"), false);
  assert.equal((await r.actions.act(2, { nonce: "same", action: "untrust" }))?.outcome, "busy", "the seventh in a minute");
  r.tick(60_001);
  assert.notEqual((await r.actions.act(2, { nonce: "same", action: "untrust" }))?.outcome, "busy");
  assert.equal(r.shown.length, 1, "only the add showed a dialog; reused nonces granted nothing by themselves");
});

test("refusals: no folder, not a repository, a registered folder for add, a host that is down or silent", async () => {
  assert.equal(await act(rig({ folder: undefined }), "add"), "no_folder");
  assert.equal(await act(rig({ answers: (m) => (m.type === "projects.inspect" ? { ok: false, code: "E_INVALID_ARGUMENT", reason: "not_a_repository" } : undefined) }), "add"), "not_a_repository");
  assert.equal(await act(rig({ answers: (m) => (m.type === "projects.inspect" ? { ok: false, code: "E_INVALID_ARGUMENT", reason: "excluded_root" } : undefined) }), "add"), "refused");
  assert.equal(await act(rig({ answers: (m) => (m.type === "projects.inspect" ? inspected({ registered: { projectId: "p", trusted: false } }) : undefined) }), "add"), "refused");
  assert.equal(await act(rig({ send: false }), "add"), "unavailable");
  const silent = createProjectActions({ send: () => true, choose: () => undefined, show: async () => 0, windowFolder: () => FOLDER, workspaceTrusted: () => true, now: () => 0, requestTimeoutMs: 20 });
  assert.equal((await silent.act(1, { nonce: "n", action: "add" }))?.outcome, "unavailable");
  const conflict = rig({ press: [1], answers: (m) => (m.type === "projects.register" ? { ok: false, code: "E_CONFLICT" } : undefined) });
  assert.equal(await act(conflict, "add"), "refused");
});

test("the shared native queue: a project dialog waits behind a confirmation, shares its bounds, and an open one expires", async () => {
  let now = 0;
  const pending: Array<() => void> = [];
  const q = new NativeQueue({
    dialog: { confirm: () => new Promise<boolean>((resolve) => pending.push(() => resolve(true))) },
    codeWindowOf: () => 1,
    now: () => now,
    ttlMs: 1_000,
    maxWaiting: 2,
    timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as never) },
  });
  const replies: unknown[] = [];
  q.push({ challengeId: "c".repeat(43), proof: "p".repeat(32), windowId: "w1", summary: "Push" }, (m) => replies.push(m));
  const results: Array<Record<string, unknown>> = [];
  let shownAt = -1;
  q.pushChoice({ codeWindowId: 1, show: async () => ((shownAt = q.size), 2), done: (r) => results.push(r) });
  q.pushChoice({ codeWindowId: 1, show: async () => 1, done: (r) => results.push(r) });
  assert.deepEqual([...results], [{ refused: "queue_full" }], "the shared bound: a third waiting entry is refused");
  assert.equal(shownAt, -1, "the choice waits while the confirmation is open");
  pending.shift()?.();
  await new Promise((x) => setTimeout(x, 0));
  assert.deepEqual(results.slice(1), [{ index: 2 }]);
  assert.equal((replies[0] as { confirmed: boolean }).confirmed, true);
  // An open choice whose lifetime runs out is closed and answered expired; a late press is never applied.
  let late: (n: number) => void = () => undefined;
  q.pushChoice({ codeWindowId: 1, show: () => new Promise<number>((resolve) => (late = resolve)), done: (r) => results.push(r) });
  now += 1_001;
  await new Promise((x) => setTimeout(x, 1_050));
  late(2);
  await new Promise((x) => setTimeout(x, 0));
  assert.deepEqual(results.at(-1), { refused: "expired" });
  q.dispose();
});
