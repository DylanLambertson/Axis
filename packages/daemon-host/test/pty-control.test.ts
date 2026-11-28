// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-X1a (docs/design/pty-exec-node.md §5a): the daemon's pty port over the control port main transfers in `{ type: "pty-control" }`.
// The slot over a hand-driven pty process peer, then the entry: held before init, the start bound, wrong shapes, a replacement, a
// port from a source other than the parent port.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { after, test } from "node:test";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import type { ElectronPortLike } from "@axis/daemon";
import { createPtyControlSlot, type ControlPortLike } from "../src/bindings/pty-control.js";
import { runDaemonEntry, type DaemonEntryDeps } from "../src/entry.js";
import { EXIT, signAttestation } from "../src/index.js";
import type { PtySpawn } from "../src/ports/pty.js";
import { FakeParentPort, FakeProcess, FakeTimers, initPayload, platformName, sandbox } from "../testing/entry-harness.js";
import { gitSkipReason } from "../testing/git-fixture.js";

/** The daemon's end of a MessageChannel shaped like Electron's `MessagePortMain`; `peer` is the pty process's end. */
function controlPair(): { mine: ControlPortLike & ElectronPortLike; peer: MessagePort; closed: () => boolean } {
  const { port1, port2 } = new MessageChannel();
  const wrapped = new Map<unknown, (data: unknown) => void>();
  let closed = false;
  port1.on("close", () => void (closed = true));
  const mine = {
    on(event: string, listener: (arg: never) => void) {
      if (event === "message") {
        const w = (data: unknown): void => (listener as (e: unknown) => void)({ data, ports: [] });
        wrapped.set(listener, w);
        port1.on("message", w);
      } else port1.on("close", listener as () => void);
      return mine;
    },
    removeListener(event: string, listener: (arg: never) => void) {
      port1.removeListener(event, (event === "message" ? wrapped.get(listener) : listener) as () => void);
      return mine;
    },
    postMessage: (m: unknown) => port1.postMessage(m),
    start: () => port1.start(),
    close: () => port1.close(),
  };
  return { mine: mine as unknown as ControlPortLike & ElectronPortLike, peer: port2, closed: () => closed };
}

/** A pty process that records requests and answers each with `answer`, or holds it. */
const openPeers = new Set<MessagePort>();
function peer(p: MessagePort, answer?: (m: Record<string, unknown>) => unknown): Array<Record<string, unknown>> {
  openPeers.add(p);
  const got: Array<Record<string, unknown>> = [];
  p.on("message", (m: Record<string, unknown>) => {
    got.push(m);
    const a = answer?.(m);
    if (a !== undefined) p.postMessage(a);
  });
  return got;
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
/** Waits for `cond` to hold, polling; a bound that runs out is an assertion naming `what`, never a hang. Prefer this to `settle` wherever the awaited state can be observed. */
async function until(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) if (cond()) return;
  assert.fail(`${what}: not reached within ${ms} ms`);
}
/** `p`, or a rejection after `ms`: a wait that a regression would make endless fails as an assertion instead. */
async function within<T>(p: Promise<T>, what: string, ms = 3_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_r, reject) => (timer = setTimeout(() => reject(new assert.AssertionError({ message: `${what}: still pending after ${ms} ms` })), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}
after(() => {
  for (const p of openPeers) p.close();
});
const SPEC: PtySpawn = { runId: "r1", argv: ["/bin/true"], cwd: "/", env: {}, cols: 80, rows: 24 };
const codeIs = (code: string) => (e: unknown): boolean => (e as { code?: unknown }).code === code;

test("before a control port every call fails closed; a port routes calls to its pty process", async () => {
  const slot = createPtyControlSlot();
  try {
    await assert.rejects(slot.port.spawn(SPEC), codeIs("channel_closed"));
    await assert.rejects(slot.port.exec({ argv: ["/g"], cwd: "/", env: {}, timeoutMs: 10, maxOutput: 1, repo: { gitDir: "/g", workTree: "/" } }), codeIs("channel_closed"));
    await assert.rejects(slot.port.forgeList({ t: "forge-list", req: "f1", host: "github.com", owner: "acme", repo: "app" }), codeIs("channel_closed"));
    assert.equal(slot.attached(), false);
    const a = controlPair();
    const got = peer(a.peer, (m) => ({ t: "spawn-failed", req: m["req"], code: "capacity" }));
    slot.attach(a.mine);
    assert.equal(slot.attached(), true);
    await assert.rejects(within(slot.port.spawn(SPEC), "a spawn on the new port"), codeIs("capacity"));
    assert.equal(got[0]?.["t"], "spawn");
    a.peer.close();
  } finally {
    slot.dispose();
  }
});

test("a second control port replaces the first: in flight on the old one fails closed and its port is closed, new calls go to the new one", async () => {
  const slot = createPtyControlSlot();
  try {
    const a = controlPair();
    const oldGot = peer(a.peer); // holds every request
    slot.attach(a.mine);
    const inFlight = slot.port.spawn(SPEC);
    await until(() => oldGot.length === 1, "the in-flight request reaching the old pty process");
    assert.equal(oldGot.length, 1);
    const b = controlPair();
    const newGot = peer(b.peer, (m) => ({ t: "spawn-failed", req: m["req"], code: "capacity" }));
    slot.attach(b.mine);
    await assert.rejects(within(inFlight, "the in-flight spawn on the replaced port"), codeIs("channel_closed"));
    await until(a.closed, "the old port closing");
    assert.equal(a.closed(), true, "the old port is closed");
    await assert.rejects(within(slot.port.spawn(SPEC), "a spawn on the new port"), codeIs("capacity"));
    assert.equal(oldGot.length, 1, "nothing more went to the old pty process");
    assert.equal(newGot.length, 1);
    b.peer.close();
  } finally {
    slot.dispose();
  }
});

test("the port closing mid-run: in flight fails closed, later calls fail closed until the next port, the slot stays usable", async () => {
  const slot = createPtyControlSlot();
  try {
    const a = controlPair();
    const got = peer(a.peer);
    slot.attach(a.mine);
    const inFlight = slot.port.spawn(SPEC);
    await until(() => got.length === 1, "the in-flight request reaching the pty process");
    a.peer.close();
    await assert.rejects(within(inFlight, "the in-flight spawn on the closed port"), codeIs("channel_closed"));
    await assert.rejects(slot.port.spawn(SPEC), codeIs("channel_closed"));
    const b = controlPair();
    peer(b.peer, (m) => ({ t: "spawn-failed", req: m["req"], code: "capacity" }));
    slot.attach(b.mine);
    await assert.rejects(within(slot.port.spawn(SPEC), "a spawn on the new port"), codeIs("capacity"));
    b.peer.close();
  } finally {
    slot.dispose();
  }
  // After dispose a port is closed at once.
  const c = controlPair();
  slot.attach(c.mine);
  await until(c.closed, "a port attached after dispose being closed");
  assert.equal(c.closed(), true);
});

const skip = gitSkipReason();

function entryRig(box: ReturnType<typeof sandbox>) {
  const port = new FakeParentPort();
  port.reply = (m, deliver) => {
    if (m["type"] === "anchor.get") deliver({ type: "anchor.result", requestId: m["requestId"], anchor: null });
    if (m["type"] === "anchor.put") deliver({ type: "anchor.ack", seq: m["seq"] });
  };
  const timers = new FakeTimers();
  const proc = new FakeProcess();
  const lines: string[] = [];
  const deps: DaemonEntryDeps = { timers, parentPort: port, process: proc, env: { PATH: process.env["PATH"] ?? "", HOME: box.root }, cwd: box.root, platform: platformName(), execArgv: [], stderr: (l) => void lines.push(l) };
  return { port, timers, proc, lines, deps };
}

test("entry: a control port held before init starts the host; a second one before ready replaces it; wrong shapes are closed and change nothing", { skip }, async () => {
  const box = sandbox();
  const pairs: Array<ReturnType<typeof controlPair>> = [];
  const pair = (): ReturnType<typeof controlPair> => {
    const p = controlPair();
    pairs.push(p);
    return p;
  };
  const { port, timers, lines, deps } = entryRig(box);
  const h = runDaemonEntry(deps);
  try {
    // Wrong shapes: an extra key, a type with a port that is not pty-control, and a port without the Electron listener API.
    const extra = pair();
    port.deliver({ type: "pty-control", x: 1 }, [extra.mine]);
    const other = pair();
    port.deliver({ type: "pty-controls" }, [other.mine]);
    const bare = pair();
    port.deliver({ type: "pty-control" }, [{ ...bare.mine, removeListener: undefined } as unknown as ElectronPortLike]);
    await settle();
    assert.deepEqual([extra.closed(), other.closed(), bare.closed()], [true, true, true]);
    // A valid init alone does not start the host: no control port is held yet.
    const init = initPayload(box);
    port.deliver(init.message);
    await settle();
    assert.equal(port.typesPosted().includes("anchor.get"), false, "nothing started before a control port");
    assert.equal(timers.pending(), 1, "the start bound is still armed");
    // Two good ones: the second replaces the first, which is closed.
    const first = pair();
    port.deliver({ type: "pty-control" }, [first.mine]);
    const second = pair();
    port.deliver({ type: "pty-control" }, [second.mine]);
    await settle();
    assert.equal(first.closed(), true, "the first control port is closed when replaced");
    assert.equal(second.closed(), false);
    assert.equal(await within(h.started, "the start"), true, lines.join("\n"));
    assert.equal(timers.pending(), 0, "init and a control port: the bound is cleared");
    // A connection still reaches the composition's handler through the entry's routing.
    const { port1, port2 } = new MessageChannel();
    const server: ElectronPortLike = {
      on: ((event: string, listener: (...a: never[]) => void) => (event === "message" ? port2.on("message", (data: unknown) => (listener as (e: unknown) => void)({ data, ports: [] })) : port2.on("close", listener as () => void))) as ElectronPortLike["on"],
      postMessage: (m) => port2.postMessage(m),
      start: () => port2.start(),
      close: () => port2.close(),
    };
    const attestation = signAttestation(init.key, { connectionId: randomBytes(16).toString("base64url"), windowId: "win-1", actorId: "person-1", actor: "user", trusted: true, clientKind: "desktop" }, Date.now());
    const welcome = once(port1, "message");
    port.deliver({ type: "connect", attestation }, [server]);
    port1.postMessage({ type: "hello", protocolVersions: [1], contracts: [{ id: "axis.projects", versions: [1] }] });
    assert.equal(((await within(welcome, "the welcome"))[0] as { type?: string }).type, "welcome");
    // A `pty-control` on a renderer connection is not the parent port: the routing never sees it and the control port stays.
    port1.postMessage({ type: "pty-control" });
    await settle();
    assert.equal(second.closed(), false, "the control port is not replaced or closed by a renderer message");
    port1.close();
    port.deliver({ type: "shutdown" });
    assert.equal(await within(h.finished, "the drain"), EXIT.OK, lines.join("\n"));
  } finally {
    // End the host whatever happened: `shutdown` if it started, the start bound if it did not.
    port.deliver({ type: "shutdown" });
    timers.fire();
    for (const p of pairs) p.peer.close();
    await within(h.finished, "the host's end", 10_000);
    box.cleanup();
  }
});

test("DC-3a: the slot carries the terminal port: spawn forwards onLate, grant and revoke reach the pty process, a closed slot is definitive", async () => {
  const slot = createPtyControlSlot({ spawnTimeoutMs: 50 });
  try {
    assert.equal(slot.port.lateSpawnReports, true);
    assert.equal(slot.port.revoke("pty_0123456789abcdef0123456789abcdef"), false, "no port: nothing sent");
    await assert.rejects(slot.port.spawn(SPEC, () => undefined), (e: unknown) => (e as { code?: unknown; definitive?: unknown }).code === "channel_closed" && (e as { definitive?: unknown }).definitive === true);
    const a = controlPair();
    const got = peer(a.peer); // holds the spawn past the client's bound
    slot.attach(a.mine);
    const lates: Array<{ kind: string; handle?: { terminalId: string } }> = [];
    const spawned = slot.port.spawn(SPEC, (l) => lates.push(l));
    await assert.rejects(within(spawned, "the spawn timing out"), (e: unknown) => (e as { code?: unknown }).code === "timeout" && (e as { definitive?: unknown }).definitive === false);
    const req = got.find((m) => m["t"] === "spawn")?.["req"];
    a.peer.postMessage({ t: "spawned", req, term: "pty_0123456789abcdef0123456789abcdef", group: { kind: "pgid", pgid: 999_999_9 } });
    await until(() => lates.length === 1, "the late spawn reaching onLate");
    assert.equal(lates[0]?.kind, "spawned");
    assert.equal(lates[0]?.handle?.terminalId, "pty_0123456789abcdef0123456789abcdef");
    await until(() => got.some((m) => m["t"] === "kill"), "the late group's kill");
    slot.port.grant("pty_0123456789abcdef0123456789abcdef", "c1");
    assert.equal(slot.port.revoke("pty_0123456789abcdef0123456789abcdef"), true);
    await until(() => got.filter((m) => m["t"] === "revoke").length === 2, "the grant and the revoke");
    assert.deepEqual(got.filter((m) => m["t"] === "grant" || m["t"] === "revoke").map((m) => m["t"]), ["revoke", "grant", "revoke"], "the late revoke, then the forwarded grant and revoke");
    a.peer.close();
  } finally {
    slot.dispose();
  }
});
