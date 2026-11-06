// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AxisPortClient, ClientError, type ClientPort } from "@axis/protocol";
import { anchorFilePath, createAnchorFile } from "../src/main/anchor-file.js";
import { createAnchorStore, type AnchorCipher } from "../src/main/anchor-store.js";
import { createMainAnswers } from "../src/main/answers.js";
import { signMainAttestation } from "../src/main/attest-sign.js";
import { ConnectBroker, type ConnectSender } from "../src/main/connect-broker.js";
import { DaemonSupervisor, type SupervisorEvent } from "../src/supervisor.js";
import { gitSkipReason } from "../testing/git-fixture.js";
import { testCipher } from "../testing/main-fakes.js";
import { channel, closePort, hmacSha256, TunnelChild, type TunnelEnd } from "../testing/main-rig.js";
import { until } from "../testing/test-client.js";

/**
 * Tickets X1b and X1c end to end (`docs/design/main-answers.md` section 5): the REAL daemon entry in a child process
 * (`testing/entry-child.ts`), driven by main's real `DaemonSupervisor`, `ConnectBroker`, answers, anchor store and anchor file, with
 * the renderer's real `AxisPortClient`. Only the cipher (a test cipher), the transport of the port (tunnelled: Node cannot transfer a
 * port between processes) and the pty fakes are not the product's.
 */

const WB = "vscode-file://vscode-app/app/out/vs/code/electron-browser/workbench/workbench.html";
const sender: ConnectSender = { codeWindowId: 3, frameUrl: WB, isMainFrame: true, destroyed: false };
const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const CONTRACTS = [{ id: "axis.projects", versions: [1] }, { id: "axis.audit", versions: [1] }];

function mainProcess(root: string, cipher: AnchorCipher) {
  const base = join(root, "Axis");
  const dataDir = join(base, "daemon");
  const events: Array<[SupervisorEvent, string | undefined]> = [];
  const children: TunnelChild[] = [];
  let sup: DaemonSupervisor | undefined;
  const broker = new ConnectBroker<TunnelEnd | ClientPort>({
    supervisor: { connect: (identity, port) => sup?.connect(identity, port) ?? false },
    createChannel: channel,
    closePort,
    randomBytes: (n) => randomBytes(n),
    workbenchUrls: [WB],
    windowTrusted: () => true,
    now: () => performance.now(),
  });
  const answers = createMainAnswers({
    anchors: createAnchorStore(cipher, createAnchorFile(anchorFilePath(dataDir))),
    dialog: { confirm: () => Promise.resolve(false) },
    windows: broker,
    trust: { projectPath: () => undefined, trustModel: () => undefined },
    settings: { inspect: () => ({}) },
    platform,
    now: () => performance.now(),
  });
  sup = new DaemonSupervisor({
    spawn: () => {
      const c = new TunnelChild({ PATH: process.env["PATH"] ?? "", HOME: root });
      children.push(c);
      return c;
    },
    config: { dataDir, worktreeRoot: join(base, "worktrees"), platform, logLevel: "info", devDiagnostics: true },
    randomBytes: (n) => randomBytes(n),
    timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as NodeJS.Timeout) },
    now: () => performance.now(),
    hmacSha256,
    onRequest: (m, reply) => answers.onRequest(m, reply),
    onEvent: (e, f) => void events.push([e, f.reason]),
  });
  const child = (): TunnelChild => children.at(-1) as TunnelChild;
  const sentToChild = (type: string): Array<Record<string, unknown>> =>
    child().posted.map((p) => p.message as Record<string, unknown>).filter((m) => m["type"] === type);
  const stop = async (): Promise<number | null> => {
    const c = child();
    const exited = c.proc.exitCode !== null ? Promise.resolve(c.proc.exitCode) : new Promise<number | null>((r) => c.proc.once("exit", (code) => r(code)));
    await sup?.shutdown();
    answers.dispose();
    return exited;
  };
  return { sup, broker, answers, events, child, children, sentToChild, stop, anchorPath: anchorFilePath(dataDir), up: async () => {
    await answers.prepare();
    sup?.start();
    await until(() => sup?.state() === "running" || sup?.state() === "failed", "the host is running", 3000);
    assert.equal(sup?.state(), "running", `${JSON.stringify(events)}\n${child().stderr}`);
  } };
}

const open = (port: ClientPort): Promise<AxisPortClient> => AxisPortClient.open(port, { contracts: CONTRACTS });
const refused = (e: unknown): boolean => e instanceof ClientError && e.code === "E_UNAUTHENTICATED" && e.reason === "rejected";

test("main brokers a signed port the renderer client uses; a forged or replayed connect is rejected; the anchor survives a restart, and a lost anchor starts degraded", { skip: gitSkipReason(), timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "axis-main-e2e-"));
  const all: TunnelChild[] = [];
  try {
    // 1. A true first start: no record, a secure backend. Main answers `null` and the host comes up not degraded.
    const first = mainProcess(root, testCipher());
    await first.up();
    all.push(...first.children);
    assert.deepEqual(first.events.find(([e]) => e === "ready" || e === "degraded"), ["ready", undefined]);
    assert.deepEqual(first.sentToChild("anchor.result").map((m) => m["anchor"]), [null]);

    // 2. A renderer connection through the broker: welcome, and a request served by the host.
    const out = first.broker.connect(sender, "nonce-1");
    assert.equal(out.ok, true);
    assert.ok(out.ok);
    const client = await open(out.port as ClientPort);
    assert.deepEqual(client.welcome.contracts.map((c) => c.id).sort(), ["axis.audit", "axis.projects"]);
    const listed = await client.call("axis.projects", "list", {});
    assert.deepEqual(listed, { ok: true, result: { projects: [] } });

    // 3. The exact connect main sent, replayed on a new port, is refused (single use), and so is one signed with another key.
    const sent = first.child().posted.find((p) => p.withPort && (p.message as { type?: string }).type === "connect");
    assert.ok(sent);
    await assert.rejects(open(first.child().postWithNewPort(sent.message)), refused);
    const identity = { connectionId: randomBytes(16).toString("base64url"), windowId: "w3", actorId: "local-user", actor: "user" as const, trusted: true, clientKind: "desktop" as const };
    await assert.rejects(open(first.child().postWithNewPort({ type: "connect", attestation: signMainAttestation(hmacSha256, randomBytes(32), identity, Date.now()) })), refused);
    // A sender main refuses gets no port at all.
    assert.deepEqual(first.broker.connect({ ...sender, frameUrl: "about:blank" }, "nonce-2"), { ok: false, reason: "bad_frame" });
    // The first connection still works after the refusals.
    assert.equal((await client.call("axis.projects", "list", {})).ok, true);

    // 4. The host anchored what startup wrote: main made it durable before acknowledging it.
    await until(() => first.sentToChild("anchor.ack").length > 0, "an anchor ack", 3000);
    assert.equal(existsSync(first.anchorPath), true);
    const stored = await createAnchorStore(testCipher(), createAnchorFile(first.anchorPath)).read();
    assert.equal(stored.kind, "anchor");
    assert.ok(stored.kind === "anchor");
    assert.ok(first.sentToChild("anchor.ack").some((m) => m["seq"] === stored.head.seq));
    client.close();
    assert.equal(await first.stop(), 0, first.child().stderr);

    // 5. A restart on the same data: main answers the stored anchor, the chain still holds it, not degraded.
    const second = mainProcess(root, testCipher());
    await second.up();
    all.push(...second.children);
    const answered = second.sentToChild("anchor.result")[0]?.["anchor"] as { seq: number } | null;
    assert.ok(answered !== null && answered !== undefined && answered.seq >= stored.head.seq);
    assert.deepEqual(second.events.find(([e]) => e === "ready" || e === "degraded"), ["ready", undefined]);
    assert.equal(await second.stop(), 0, second.child().stderr);

    // 6. The record deleted while the database has events: main says "absent", the host sees events without an anchor and is
    //    degraded (`anchor_missing`), never a first start. It still serves its read methods.
    rmSync(second.anchorPath);
    const third = mainProcess(root, testCipher());
    await third.up();
    all.push(...third.children);
    assert.deepEqual(third.sentToChild("anchor.result").map((m) => m["anchor"]), [null]);
    assert.deepEqual(third.events.find(([e]) => e === "ready" || e === "degraded"), ["degraded", "anchor_missing"]);
    const out3 = third.broker.connect(sender, "nonce-3");
    assert.ok(out3.ok);
    const c3 = await open(out3.port as ClientPort);
    assert.equal((await c3.call("axis.projects", "list", {})).ok, true);
    c3.close();
    assert.equal(existsSync(third.anchorPath), false, "a degraded host anchors nothing");
    // It stopped by itself on `shutdown` (not killed); its code is the host's own (a degraded host has no acknowledged final anchor).
    assert.notEqual(await third.stop(), null, third.child().stderr);
  } finally {
    for (const c of all) if (c.proc.exitCode === null && c.proc.signalCode === null) c.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
