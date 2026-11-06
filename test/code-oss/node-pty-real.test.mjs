// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Opt-in conformance run of the pty process against Code OSS's OWN node-pty (docs/design/pty-process.md, addendum). Set
// AXIS_CODE_OSS_TREE to a Code OSS checkout whose node_modules holds a built node-pty, and build the packages first
// (`npm run build`). Without it every test is skipped with that reason; the package suite cannot import node-pty.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, openSync, closeSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const tree = process.env.AXIS_CODE_OSS_TREE;
const dist = new URL("../../packages/pty-process/dist/", import.meta.url);
const skip = process.platform === "win32" ? "POSIX only" : tree === undefined || tree === "" ? "set AXIS_CODE_OSS_TREE to a Code OSS tree with a built node-pty" : !existsSync(new URL("src/index.js", dist)) ? "build the packages first" : false;

async function load() {
  const nodePty = createRequire(join(tree, "package.json"))("node-pty");
  const lib = await import(new URL("src/index.js", dist));
  const helpers = await import(new URL("testing/helpers.js", dist));
  return { nodePty, lib, helpers };
}

async function rig(opts = {}) {
  const { nodePty, lib, helpers } = await load();
  const pair = helpers.channelPair();
  const svc = lib.createPtyService({ spawn: lib.createNodePtySpawn((f, a, o) => nodePty.spawn(f, a, o)), ...opts });
  svc.serveControl(pair.b);
  const port = lib.createPtyProcessPort({ channel: pair.a });
  const data = helpers.channelPair();
  svc.serveData(data.b, "c1");
  const out = { text: "", replies: [] };
  data.a.onMessage((m) => (out.replies.push(m), (out.text += m.chunk ?? "")));
  const start = async (argv) => {
    const h = await port.spawn({ runId: "r", argv, cwd: "/", env: { PATH: "/usr/bin:/bin" }, cols: 80, rows: 24 });
    port.grant(h.terminalId, "c1");
    await helpers.settle();
    data.a.send({ t: "attach", term: h.terminalId });
    await helpers.settle();
    return h;
  };
  return { helpers, svc, port, pair, data, out, start, end: () => (port.dispose(), svc.dispose()) };
}

test("child-fd: a shell behind node-pty sees only its pty, not the parent's descriptors", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "axis-fds-"));
  const held = openSync(join(dir, "held-one"), "w");
  const r = await rig();
  try {
    const h = await r.start(["/bin/sh", "-c", "read go; ls -l /proc/$$/fd; env; echo end; sleep 30"]);
    r.data.a.send({ t: "write", term: h.terminalId, data: "go\n" });
    await r.helpers.until(() => r.out.text.includes("end"));
    const targets = [...r.out.text.matchAll(/\d+ -> (\S+)/g)].map((m) => m[1]);
    assert.ok(targets.length >= 3);
    assert.deepEqual(targets.filter((t) => t.includes("axis-fds-") || t.includes("held-")), []);
    assert.equal(/^VSCODE_/m.test(r.out.text), false, "no VSCODE_* variable (PTY-6)");
    assert.equal(h.groupAlive(), true);
  } finally {
    r.end();
    closeSync(held);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("closing the control channel ends the group of a node-pty child", { skip }, async () => {
  const r = await rig();
  const h = await r.start(["/bin/sh", "-c", "sleep 30"]);
  try {
    r.pair.a.close();
    await r.helpers.until(() => !h.groupAlive());
  } finally {
    r.end();
  }
});

test("PTY-4: node-pty's write queue has the shape the meter reads, and a flood into a child that never reads is refused", { skip }, async () => {
  const limit = 256 * 1024;
  const r = await rig({ input: { terminal: limit, process: 4 * limit } });
  const h = await r.start(["/bin/sleep", "30"]);
  try {
    const chunk = "x".repeat(65536);
    for (let i = 0; i < 400; i++) r.data.a.send({ t: "write", term: h.terminalId, data: chunk });
    await r.helpers.until(() => r.out.replies.some((m) => m.t === "refused" && m.code === "input_full"));
    r.data.a.send({ t: "write", term: h.terminalId, data: "still refused" });
    await r.helpers.settle();
    assert.equal(r.out.replies.filter((m) => m.code === "input_full").length >= 2, true);
  } finally {
    r.end();
  }
});

test("PTY-4: a flood of one-byte writes into a child that never reads is refused on the entry bound, not scanned for ever", { skip }, async () => {
  const r = await rig();
  const h = await r.start(["/bin/sleep", "30"]);
  try {
    for (let i = 0; i < 5000; i++) r.data.a.send({ t: "write", term: h.terminalId, data: "x" });
    await r.helpers.until(() => r.out.replies.some((m) => m.t === "refused" && m.code === "input_full"));
    const refused = r.out.replies.filter((m) => m.code === "input_full").length;
    assert.ok(refused > 3000, `refused ${refused}`);
  } finally {
    r.end();
  }
});
