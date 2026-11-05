// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { test } from "node:test";
import type { Connection } from "@axis/daemon";
import { TestSupervisor, type TestSupervisorOptions } from "../testing/test-supervisor.js";
import { processSnapshot, wait } from "./helpers.js";

const MODES = ["process", "worker"] as const;

/** Resolves after `ms`, or when `p` settles first; the timer never outlives the call. */
async function within(ms: number, p: Promise<unknown>): Promise<"done" | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p.then(() => "done" as const), new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Collects what a connection receives and lets a test wait for the next message or for the close. */
function watch(conn: Connection) {
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  conn.onMessage((m) => {
    messages.push(m as Record<string, unknown>);
    for (const w of waiters.splice(0)) w();
  });
  conn.onClose(() => {
    closed = true;
    for (const w of waiters.splice(0)) w();
  });
  const settle = (): Promise<void> => new Promise((r) => waiters.push(r));
  return {
    messages,
    isClosed: () => closed,
    async next(): Promise<Record<string, unknown>> {
      while (messages.length === 0 && !closed) await settle();
      const m = messages.shift();
      if (m === undefined) throw new Error("connection closed");
      return m;
    },
    async closedWithin(ms: number): Promise<boolean> {
      const deadline = Date.now() + ms;
      while (!closed && Date.now() < deadline) await within(Math.max(1, deadline - Date.now()), settle());
      return closed;
    },
  };
}

async function withSupervisor(options: TestSupervisorOptions, body: (s: TestSupervisor) => Promise<void>): Promise<void> {
  const before = processSnapshot();
  const sup = await TestSupervisor.start(options);
  const dataDir = sup.dataDir;
  try {
    await body(sup);
  } finally {
    await sup.dispose();
  }
  await assert.rejects(stat(dataDir), { code: "ENOENT" }, "the temporary directory is removed");
  await wait(5);
  assert.deepEqual(processSnapshot(), before, "no timers or process listeners left in the test process");
}

const ask = async (c: ReturnType<typeof watch>, conn: Connection, m: Record<string, unknown>): Promise<Record<string, unknown>> => {
  conn.send(m);
  return c.next();
};

for (const mode of MODES) {
  test(`[${mode}] ready, then a valid attestation connects and the echo shows the attested actor`, async () => {
    await withSupervisor({ mode }, async (sup) => {
      const ready = await sup.waitFor("ready");
      assert.equal(ready.protocolVersion, 1);
      const conn = sup.connect(sup.attest({ actor: "agent:broker", windowId: "win-7" }));
      const w = watch(conn);
      assert.deepEqual(await ask(w, conn, { op: "echo", v: 5 }), { ok: true, echo: 5, actor: "agent:broker", windowId: "win-7" });
      assert.deepEqual(sup.invalid, []);
      assert.equal(sup.stderr, "");
    });
  });

  test(`[${mode}] refused attestations close the connection: wrong key, stale, replayed`, async () => {
    await withSupervisor({ mode }, async (sup) => {
      await sup.waitFor("ready");
      const other = await TestSupervisor.start({ skipInit: true });
      const forged = other.attest();
      await other.dispose();
      const stale = sup.attest({}, Date.now() - 60_000);
      const good = sup.attest();
      for (const att of [forged, stale]) assert.equal(await watch(sup.connect(att)).closedWithin(3000), true);
      const first = sup.connect(good);
      const w = watch(first);
      assert.equal((await ask(w, first, { op: "echo", v: 1 }))["ok"], true);
      assert.equal(await watch(sup.connect(good)).closedWithin(3000), true, "the same attestation cannot be used twice");
    });
  });

  test(`[${mode}] the connect limiter closes the third connect of a window with no other answer`, async () => {
    await withSupervisor({ mode, config: { limits: { connectBurst: 2, connectsPerMinute: 1 } } }, async (sup) => {
      await sup.waitFor("ready");
      const conns = [sup.connect(), sup.connect(), sup.connect()];
      const watchers = conns.map(watch);
      assert.equal(await watchers[2]?.closedWithin(3000), true);
      assert.equal(watchers[2]?.messages.length, 0, "no hello-rejected style answer");
      assert.equal(watchers[0]?.isClosed(), false);
      assert.equal((await ask(watchers[0] as never, conns[0] as Connection, { op: "echo", v: 1 }))["ok"], true);
    });
  });

  test(`[${mode}] trust.check, native.confirm, anchors and settings go through the supervisor`, async () => {
    await withSupervisor({ mode, anchor: { seq: 4, hash: "c".repeat(64) } }, async (sup) => {
      await sup.waitFor("ready");
      const conn = sup.connect();
      const w = watch(conn);

      sup.trustAnswer = () => true;
      assert.deepEqual(await ask(w, conn, { op: "trust" }), { ok: true, trusted: true });
      sup.trustAnswer = () => false;
      assert.deepEqual(await ask(w, conn, { op: "trust" }), { ok: false, code: "E_POLICY_DENIED" });

      assert.deepEqual(await ask(w, conn, { op: "anchor-get" }), { ok: true, anchor: { seq: 4, hash: "c".repeat(64) } });
      const hash = "d".repeat(64);
      conn.send({ op: "anchor-put", seq: 5, hash });
      assert.deepEqual(await w.next(), { ok: true, sent: true });
      assert.deepEqual(sup.anchor, { seq: 5, hash });
      assert.deepEqual(await ask(w, conn, { op: "acks" }), { ok: true, acks: [5] });

      sup.settings["axis.git.runHooks"] = true;
      assert.deepEqual(await ask(w, conn, { op: "settings", key: "axis.git.runHooks" }), { ok: true, value: true });

      const challengeId = "N".repeat(43);
      conn.send({ op: "native", challengeId, proof: "z".repeat(32) });
      await sup.waitFor("native.confirm");
      assert.equal(sup.nativeConfirms.length, 1);
      sup.answerNative(challengeId, true);
      assert.deepEqual(await w.next(), { ok: true, confirmed: true, proof: "z".repeat(32), windowId: "win-1" });
    });
  });

  test(`[${mode}] shutdown: the host releases everything and exits by draining with code 0`, async () => {
    await withSupervisor({ mode }, async (sup) => {
      await sup.waitFor("ready");
      const conn = sup.connect();
      const w = watch(conn);
      assert.equal((await ask(w, conn, { op: "echo", v: 1 }))["ok"], true);
      sup.shutdown();
      assert.equal(await within(10_000, sup.exited), "done", "the host exited by draining");
      assert.equal((await sup.exited).code, 0);
      assert.equal(sup.stderr, "");
    });
  });
}

test("a killed host closes the supervisor's connections and the channel", async () => {
  await withSupervisor({}, async (sup) => {
    await sup.waitFor("ready");
    const w = watch(sup.connect());
    let channelClosed = false;
    sup.mux.onChannelClose(() => (channelClosed = true));
    sup.kill("SIGKILL");
    assert.equal(await w.closedWithin(5000), true);
    assert.equal(channelClosed, true);
    assert.equal((await sup.exited).signal, "SIGKILL");
  });
});

test("the host ignores a second init and a message that is not a valid control message", async () => {
  await withSupervisor({}, async (sup) => {
    await sup.waitFor("ready");
    const from = sup.received.length;
    sup.sendInit({ dataDir: "/elsewhere" });
    sup.mux.sendControl({ type: "mystery" });
    const conn = sup.connect();
    const w = watch(conn);
    assert.equal((await ask(w, conn, { op: "echo", v: 1 }))["ok"], true);
    assert.equal(sup.received.slice(from).filter((m) => m.type === "ready").length, 0);
  });
});

test("a host that cannot start does not hang dispose and leaves nothing behind", async () => {
  const before = processSnapshot();
  const sup = await TestSupervisor.start({ entry: "/nonexistent/axis-host.js" });
  const dataDir = sup.dataDir;
  assert.equal(await within(10_000, sup.dispose()), "done");
  await assert.rejects(stat(dataDir), { code: "ENOENT" });
  await wait(5);
  assert.deepEqual(processSnapshot(), before);
});
