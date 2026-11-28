// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-3c must-prove 7: with the REAL pty service and host port, a trust-registry revoke routed to a terminal ends its viewer's
// access on the data connection (told `exit`, no later output, attach and write refused), while another terminal carried by the
// SAME data connection keeps its output and input.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPtyProcessPort, createPtyService, type ProcessOps, type PtyChild, type PtyExit } from "@axis/pty-process";
import { InMemoryTrustRegistry } from "../../src/policy/trust-registry.js";
import type { PtyTerminalHandle } from "../../src/ports/pty.js";
import { TerminalRegistry } from "../../src/terminals/registry.js";
import { installTerminalRevocationRouting } from "../../src/terminals/routing.js";
import { channelPair } from "../pty-process-rig.js";

class Child implements PtyChild {
  readonly written: string[] = [];
  readonly group: PtyChild["group"];
  private readonly dl = new Set<(c: string) => void>();
  private readonly el = new Set<(e: PtyExit) => void>();
  constructor(readonly pid: number) {
    this.group = { kind: "pgid", pgid: pid };
  }
  write(d: string): void {
    this.written.push(d);
  }
  resize(): void {}
  kill(): void {}
  onData(l: (c: string) => void) {
    this.dl.add(l);
    return { dispose: () => void this.dl.delete(l) };
  }
  onExit(l: (e: PtyExit) => void) {
    this.el.add(l);
    return { dispose: () => void this.el.delete(l) };
  }
  emit(c: string): void {
    this.dl.forEach((l) => l(c));
  }
}
/** Groups live until killed. */
const live = new Set<number>();
const ops: ProcessOps = {
  signal(pid, sig) {
    if (!live.has(-pid)) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    if (sig === "SIGKILL") live.delete(-pid);
  },
};
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

test("a routed revoke ends one terminal's viewer on a shared data connection; the other terminal on it is unaffected", async () => {
  const children: Child[] = [];
  let pid = 5000;
  const service = createPtyService({ spawn: () => { const c = new Child(++pid); live.add(c.pid); children.push(c); return c; }, ops });
  const control = channelPair();
  service.serveControl(control.b);
  const port = createPtyProcessPort({ channel: control.a, ops, leaderPresent: () => true });
  const registry = new TerminalRegistry({ port });
  const trust = new InMemoryTrustRegistry();
  installTerminalRevocationRouting(trust, registry, () => undefined);
  const spec = (ws: string) => ({ runId: `r-${ws}`, argv: ["/bin/sh"], cwd: "/w", env: {}, cols: 80, rows: 24 });
  const open = async (ws: string): Promise<PtyTerminalHandle> => {
    const op = registry.reserve(ws, "p1", "w1");
    assert.ok(op !== undefined);
    const h = (await port.spawn(spec(ws))) as PtyTerminalHandle;
    assert.ok(registry.publish(op, h) !== undefined);
    return h;
  };
  const a = await open("wsA");
  const b = await open("wsB");
  const data = channelPair();
  const got: Array<Record<string, unknown>> = [];
  data.a.onMessage((m) => void got.push(m as Record<string, unknown>));
  service.serveData(data.b, "c1");
  port.grantTerminal(a.terminalId, "c1");
  port.grantTerminal(b.terminalId, "c1");
  await settle();
  data.a.send({ t: "attach", term: a.terminalId });
  data.a.send({ t: "attach", term: b.terminalId });
  await settle();
  assert.deepEqual(got.filter((m) => m["t"] === "attached").map((m) => m["term"]), [a.terminalId, b.terminalId]);

  trust.set({ windowId: "w9", workspaceId: "wsA" }, false); // a workspace revoke, through another window
  await settle();
  assert.ok(got.some((m) => m["t"] === "exit" && m["term"] === a.terminalId), "A's viewer is told it ended");
  const mark = got.length;
  const [ca, cb] = children;
  ca?.emit("after");
  cb?.emit("still");
  data.a.send({ t: "write", term: a.terminalId, data: "x" });
  data.a.send({ t: "write", term: b.terminalId, data: "y" });
  data.a.send({ t: "attach", term: a.terminalId });
  await settle();
  const later = got.slice(mark);
  assert.equal(later.some((m) => m["t"] === "data" && m["term"] === a.terminalId), false, "no later output of A");
  assert.ok(later.some((m) => m["t"] === "data" && m["term"] === b.terminalId && String(m["chunk"]).endsWith("still")), "B's output still arrives");
  assert.deepEqual(ca?.written, [], "A's input refused");
  assert.deepEqual(cb?.written, ["y"], "B's input still reaches it");
  assert.deepEqual(later.at(-1), { t: "refused", term: null, code: "foreign_terminal" }, "A's re-attach refused");
  service.dispose();
  port.dispose();
});
