// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutboundMessage } from "../src/control/messages.js";
import type { AnchorHead, AnchorRead, AnchorStore } from "../src/main/anchor-store.js";
import { createMainAnswers, type MainAnswerEvent, type MainAnswersOptions } from "../src/main/answers.js";
import type { SettingInspect } from "../src/main/settings-scope.js";

const H = (c: string): string => c.repeat(64);
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

class Store implements AnchorStore {
  reads = 0;
  readonly writes: AnchorHead[] = [];
  next: AnchorRead | Error;
  writeGate: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  gated = false;
  constructor(initial: AnchorRead | Error) {
    this.next = initial;
  }
  read(): Promise<AnchorRead> {
    this.reads++;
    return this.next instanceof Error ? Promise.reject(this.next) : Promise.resolve(this.next);
  }
  write(head: AnchorHead): Promise<void> {
    this.writes.push(head);
    if (!this.gated) return Promise.resolve();
    return new Promise((resolve, reject) => this.writeGate.push({ resolve, reject }));
  }
}

function rig(store: Store, over: Partial<MainAnswersOptions> = {}) {
  const replies: Array<Record<string, unknown>> = [];
  const events: MainAnswerEvent[] = [];
  const shown: Array<{ codeWindowId: number; summary: string; answer: (v: boolean) => void; fail: () => void }> = [];
  let now = 0;
  const settings: Record<string, SettingInspect> = {};
  const answers = createMainAnswers({
    anchors: store,
    dialog: { confirm: (r) => new Promise<boolean>((resolve, reject) => void shown.push({ ...r, answer: resolve, fail: () => reject(new Error("x")) })) },
    windows: { codeWindowOf: (w) => (w === "w1" ? 1 : w === "w2" ? 2 : undefined) },
    trust: { projectPath: (p) => (p === "p-1" ? "/home/u/src/repo" : undefined), trustModel: () => JSON.stringify({ uriTrustInfo: [{ uri: { scheme: "file", authority: "", path: "/home/u/src" }, trusted: true }] }) },
    settings: { inspect: (k) => settings[k] ?? {} },
    platform: "linux",
    now: () => now,
    onEvent: (e) => void events.push(e),
    ...over,
  });
  const ask = (m: OutboundMessage): void => answers.onRequest(m, (r) => void replies.push(r as Record<string, unknown>));
  return { answers, replies, events, shown, ask, settings, tick: (ms: number) => void (now += ms) };
}

// ---- anchor.get ---------------------------------------------------------------------------------------------------

test("anchor.get: a stored record is answered, a definite absence is null, and the store is read once by prepare", async () => {
  const s = new Store({ kind: "anchor", head: { seq: 4, hash: H("a") } });
  const r = rig(s);
  await r.answers.prepare();
  await r.answers.prepare();
  r.ask({ type: "anchor.get", requestId: "r1" });
  r.ask({ type: "anchor.get", requestId: "r2" });
  await flush();
  assert.equal(s.reads, 1);
  assert.deepEqual(r.replies, [
    { type: "anchor.result", requestId: "r1", anchor: { seq: 4, hash: H("a") } },
    { type: "anchor.result", requestId: "r2", anchor: { seq: 4, hash: H("a") } },
  ]);
  const a = rig(new Store({ kind: "absent" }));
  a.ask({ type: "anchor.get", requestId: "r1" });
  await flush();
  assert.deepEqual(a.replies, [{ type: "anchor.result", requestId: "r1", anchor: null }]);
});

test("anchor.get: an unreadable store (every unavailable reason, or a read that throws) is silence, never null", async () => {
  for (const initial of [
    { kind: "unavailable", reason: "insecure_backend" } as const,
    { kind: "unavailable", reason: "read_failed" } as const,
    { kind: "unavailable", reason: "decrypt_failed" } as const,
    { kind: "unavailable", reason: "corrupt" } as const,
    new Error("boom"),
  ]) {
    const r = rig(new Store(initial));
    await r.answers.prepare();
    r.ask({ type: "anchor.get", requestId: "r1" });
    await flush();
    assert.deepEqual(r.replies, [], JSON.stringify(initial));
    assert.equal(r.events[0]?.event, "anchor_unavailable");
  }
});

// ---- anchor.put ---------------------------------------------------------------------------------------------------

test("anchor.put: acked only after the write resolved, and the next get answers the new anchor", async () => {
  const s = new Store({ kind: "absent" });
  s.gated = true;
  const r = rig(s);
  await r.answers.prepare();
  r.ask({ type: "anchor.put", seq: 3, hash: H("b") });
  await flush();
  assert.deepEqual(s.writes, [{ seq: 3, hash: H("b") }]);
  assert.deepEqual(r.replies, [], "no ack before the write is durable");
  s.writeGate.shift()!.resolve();
  await r.answers.idle();
  assert.deepEqual(r.replies, [{ type: "anchor.ack", seq: 3 }]);
  r.ask({ type: "anchor.get", requestId: "g" });
  await flush();
  assert.deepEqual(r.replies[1], { type: "anchor.result", requestId: "g", anchor: { seq: 3, hash: H("b") } });
  assert.equal(s.reads, 1, "answered from what was written, not re-read");
});

test("anchor.put: puts during a write are merged into the newest; a put below the waiting one is refused", async () => {
  const s = new Store({ kind: "anchor", head: { seq: 1, hash: H("a") } });
  s.gated = true;
  const r = rig(s);
  await r.answers.prepare();
  r.ask({ type: "anchor.put", seq: 2, hash: H("b") });
  await flush();
  r.ask({ type: "anchor.put", seq: 3, hash: H("c") });
  r.ask({ type: "anchor.put", seq: 5, hash: H("d") });
  r.ask({ type: "anchor.put", seq: 4, hash: H("e") });
  s.writeGate.shift()!.resolve();
  await flush();
  s.writeGate.shift()!.resolve();
  await r.answers.idle();
  assert.deepEqual(s.writes.map((w) => w.seq), [2, 5]);
  assert.deepEqual(r.replies, [{ type: "anchor.ack", seq: 2 }, { type: "anchor.ack", seq: 5 }]);
  assert.deepEqual(r.events, [{ event: "anchor_put_refused", reason: "regression" }]);
});

test("anchor.put: a regression or a changed hash at the same seq is refused, the same anchor is acked without a write", async () => {
  const s = new Store({ kind: "anchor", head: { seq: 7, hash: H("a") } });
  const r = rig(s);
  await r.answers.prepare();
  r.ask({ type: "anchor.put", seq: 6, hash: H("b") });
  await r.answers.idle();
  r.ask({ type: "anchor.put", seq: 7, hash: H("c") });
  await r.answers.idle();
  r.ask({ type: "anchor.put", seq: 7, hash: H("a") });
  await r.answers.idle();
  assert.deepEqual(s.writes, []);
  assert.deepEqual(r.replies, [{ type: "anchor.ack", seq: 7 }]);
  assert.deepEqual(r.events.map((e) => e.event), ["anchor_put_refused", "anchor_put_refused"]);
});

test("anchor.put: nothing is written over a store main could not read", async () => {
  const s = new Store({ kind: "unavailable", reason: "decrypt_failed" });
  const r = rig(s);
  await r.answers.prepare();
  r.ask({ type: "anchor.put", seq: 9, hash: H("a") });
  await r.answers.idle();
  assert.deepEqual(s.writes, []);
  assert.deepEqual(r.replies, []);
  assert.deepEqual(r.events.at(-1), { event: "anchor_put_refused", reason: "store_unreadable" });
});

test("anchor.put: a failed write is not acked, and the store is re-read before it is trusted again", async () => {
  const s = new Store({ kind: "absent" });
  s.gated = true;
  const r = rig(s);
  await r.answers.prepare();
  r.ask({ type: "anchor.put", seq: 2, hash: H("b") });
  await flush();
  s.writeGate.shift()!.reject(new Error("disk"));
  await r.answers.idle();
  assert.deepEqual(r.replies, []);
  // The write may have happened: the re-read says what is on disk now.
  s.next = { kind: "anchor", head: { seq: 2, hash: H("b") } };
  r.ask({ type: "anchor.get", requestId: "g" });
  await flush();
  assert.equal(s.reads, 2);
  assert.deepEqual(r.replies, [{ type: "anchor.result", requestId: "g", anchor: { seq: 2, hash: H("b") } }]);
});

// ---- native.confirm -----------------------------------------------------------------------------------------------

const confirm = (challengeId: string, windowId = "w1") => ({ type: "native.confirm", challengeId, proof: `proof-${challengeId}-xxxxxxxx`, windowId, summary: "Push axis/x to origin" }) as OutboundMessage;

test("native.confirm: the dialog on the named window decides, with the request's own proof; one dialog at a time", async () => {
  const r = rig(new Store({ kind: "absent" }));
  r.ask(confirm("c".repeat(22)));
  r.ask(confirm("d".repeat(22), "w2"));
  await flush();
  assert.equal(r.shown.length, 1, "the second waits for the first");
  assert.deepEqual({ w: r.shown[0]!.codeWindowId, s: r.shown[0]!.summary }, { w: 1, s: "Push axis/x to origin" });
  r.shown[0]!.answer(true);
  await flush();
  assert.equal(r.shown.length, 2);
  assert.equal(r.shown[1]!.codeWindowId, 2);
  r.shown[1]!.answer(false);
  await flush();
  assert.deepEqual(r.replies, [
    { type: "native.result", challengeId: "c".repeat(22), proof: `proof-${"c".repeat(22)}-xxxxxxxx`, confirmed: true, windowId: "w1" },
    { type: "native.result", challengeId: "d".repeat(22), proof: `proof-${"d".repeat(22)}-xxxxxxxx`, confirmed: false, windowId: "w2" },
  ]);
});

test("native.confirm: an unknown window, a failing dialog, a non-boolean answer, an expired entry and a full queue are all false", async () => {
  const r = rig(new Store({ kind: "absent" }), { nativeMaxWaiting: 2 });
  r.ask(confirm("a".repeat(22), "w9"));
  await flush();
  assert.equal(r.shown.length, 0, "no dialog for a window main does not know");
  assert.equal(r.replies.at(-1)!["confirmed"], false);
  r.ask(confirm("b".repeat(22)));
  r.ask(confirm("c".repeat(22)));
  r.ask(confirm("e".repeat(22)));
  await flush();
  assert.equal(r.replies.at(-1)!["challengeId"], "e".repeat(22));
  assert.equal(r.replies.at(-1)!["confirmed"], false, "over the bound");
  r.tick(60_001);
  r.shown[0]!.fail();
  await flush();
  assert.deepEqual(r.replies.slice(-2).map((x) => [x["challengeId"], x["confirmed"]]), [["b".repeat(22), false], ["c".repeat(22), false]]);
  assert.equal(r.shown.length, 1, "the expired one never got a dialog");
  r.ask(confirm("f".repeat(22)));
  await flush();
  r.shown[1]!.answer("yes" as unknown as boolean);
  await flush();
  assert.equal(r.replies.at(-1)!["confirmed"], false, "only true confirms");
  assert.deepEqual(r.events.filter((e) => e.event === "native_refused").map((e) => (e as { reason: string }).reason), ["no_window", "queue_full", "dialog_failed", "expired"]);
});

test("native.confirm: a duplicate while waiting is ignored, and after dispose nothing is answered", async () => {
  const r = rig(new Store({ kind: "absent" }));
  r.ask(confirm("a".repeat(22)));
  r.ask(confirm("a".repeat(22)));
  await flush();
  assert.equal(r.shown.length, 1);
  r.answers.dispose();
  r.shown[0]!.answer(true);
  await flush();
  assert.deepEqual(r.replies, []);
  r.ask(confirm("b".repeat(22)));
  r.ask({ type: "anchor.get", requestId: "x" });
  await flush();
  assert.deepEqual(r.replies, []);
});

// ---- trust.check --------------------------------------------------------------------------------------------------

const check = (over: Record<string, string> = {}) => ({ type: "trust.check", requestId: "t1", windowId: "w1", workspaceId: "ws-1", projectId: "p-1", ...over }) as OutboundMessage;

test("trust.check: true only for a live window, a known project and a repository inside a trusted folder", async () => {
  const r = rig(new Store({ kind: "absent" }));
  r.ask(check());
  r.ask(check({ windowId: "w9" }));
  r.ask(check({ projectId: "p-2" }));
  assert.deepEqual(r.replies.map((x) => x["trusted"]), [true, false, false]);
  assert.deepEqual(r.replies[0], { type: "trust.result", requestId: "t1", trusted: true });
  const model = (m: string | undefined) => rig(new Store({ kind: "absent" }), { trust: { projectPath: () => "/home/u/src/repo", trustModel: () => m } });
  for (const [m, want] of [
    [undefined, false],
    ["not json", false],
    [JSON.stringify({ uriTrustInfo: [{ uri: "file:///home/u/src", trusted: true }] }), true],
    [JSON.stringify({ uriTrustInfo: [{ uri: "file:///home/u/src", trusted: false }] }), false],
    [JSON.stringify({ uriTrustInfo: [{ uri: "file:///home/u/sr", trusted: true }] }), false],
    [JSON.stringify({ uriTrustInfo: [{ uri: "file:///home/u/src/repo/sub", trusted: true }] }), false],
    [JSON.stringify({ uriTrustInfo: [{ uri: "vscode-remote://ssh/home/u/src", trusted: true }] }), false],
    [JSON.stringify({ uriTrustInfo: [{ uri: { scheme: "file", authority: "server", path: "/home/u/src" }, trusted: true }] }), false],
    [JSON.stringify({ uriTrustInfo: [{ uri: { scheme: "file", path: "/HOME/u/src" }, trusted: true }] }), false],
    [JSON.stringify({ uriTrustInfo: [{ uri: { scheme: "file", path: "/" }, trusted: true }] }), true],
  ] as const) {
    const x = model(m);
    x.ask(check());
    assert.equal(x.replies[0]!["trusted"], want, String(m));
  }
  const thrower = rig(new Store({ kind: "absent" }), { trust: { projectPath: () => { throw new Error("x"); }, trustModel: () => undefined } });
  thrower.ask(check());
  assert.equal(thrower.replies[0]!["trusted"], false);
  const dotted = rig(new Store({ kind: "absent" }), { trust: { projectPath: () => "/home/u/src/../../etc", trustModel: () => JSON.stringify({ uriTrustInfo: [{ uri: "file:///home/u/src", trusted: true }] }) } });
  dotted.ask(check());
  assert.equal(dotted.replies[0]!["trusted"], false, "a path with .. segments is never trusted");
});

test("trust.check: Windows and macOS compare without case, Linux with", async () => {
  const model = JSON.stringify({ uriTrustInfo: [{ uri: { scheme: "file", authority: "", path: "/c:/Users/U/Src" }, trusted: true }] });
  const win = rig(new Store({ kind: "absent" }), { platform: "win32", trust: { projectPath: () => "C:\\users\\u\\src\\Repo", trustModel: () => model } });
  win.ask(check());
  assert.equal(win.replies[0]!["trusted"], true);
  const mac = rig(new Store({ kind: "absent" }), { platform: "darwin", trust: { projectPath: () => "/Users/U/Src/repo", trustModel: () => JSON.stringify({ uriTrustInfo: [{ uri: "file:///users/u/src", trusted: true }] }) } });
  mac.ask(check());
  assert.equal(mac.replies[0]!["trusted"], true);
  const linux = rig(new Store({ kind: "absent" }), { trust: { projectPath: () => "/Users/U/Src/repo", trustModel: () => JSON.stringify({ uriTrustInfo: [{ uri: "file:///users/u/src", trusted: true }] }) } });
  linux.ask(check());
  assert.equal(linux.replies[0]!["trusted"], false);
});

// ---- settings.get -------------------------------------------------------------------------------------------------

test("settings.get: policy, then application, then user; never workspace, folder, memory or default (CFG-1)", () => {
  const r = rig(new Store({ kind: "absent" }));
  const get = (inspect: SettingInspect): unknown => {
    r.settings["axis.git.runHooks"] = inspect;
    r.ask({ type: "settings.get", requestId: "s1", key: "axis.git.runHooks" });
    return r.replies.at(-1)?.["value"];
  };
  assert.equal(get({ policyValue: false, applicationValue: true, userValue: true }), false);
  assert.equal(get({ applicationValue: false, userValue: true, workspaceValue: true }), false);
  assert.equal(get({ userValue: false, workspaceValue: true, workspaceFolderValue: true }), false);
  assert.equal(get({ workspaceValue: false, workspaceFolderValue: false, memoryValue: false, defaultValue: false }), null);
  assert.equal(get({}), null);
  assert.deepEqual(r.replies.at(-1), { type: "settings.result", requestId: "s1", key: "axis.git.runHooks", value: null });
});

test("settings.get: a value the host could not read, or a port that throws, is silence", () => {
  const deep: unknown[] = [];
  let cur = deep;
  for (let i = 0; i < 40; i++) {
    const next: unknown[] = [];
    cur.push(next);
    cur = next;
  }
  for (const userValue of [() => 1, deep, Number.NaN, 1n]) {
    const r = rig(new Store({ kind: "absent" }));
    r.settings["axis.cliAgents"] = { userValue };
    r.ask({ type: "settings.get", requestId: "s1", key: "axis.cliAgents" });
    assert.deepEqual(r.replies, [], String(userValue));
    assert.deepEqual(r.events, [{ event: "settings_unanswered" }]);
  }
  const t = rig(new Store({ kind: "absent" }), { settings: { inspect: () => { throw new Error("x"); } } });
  t.ask({ type: "settings.get", requestId: "s1", key: "axis.cliAgents" });
  assert.deepEqual(t.replies, []);
});
