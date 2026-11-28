// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Seam smoke test (OS-3.1, docs/design/own-shell-main-seam.md §4): the real app, run from a READ-ONLY copy of its bundle (so the
// daemon's and the pty process's cwd is read-only), forks both children, the daemon reaches ready, SIGUSR1 sent to both children
// while they start opens no inspector and ends neither, and a SIGTERM to main quits cleanly: the daemon first, then the pty
// process, and no child is left. Needs the Electron runtime and a display (CI: xvfb-run); not part of `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appDir } from "../scripts/bundle.mjs";

const TIMEOUT_MS = 90_000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) => new Promise((r) => { const s = connect(port, "127.0.0.1"); s.on("connect", () => (s.destroy(), r(true))); s.on("error", () => r(false)); });
const children = (pid) => {
  try {
    return execFileSync("ps", ["-o", "pid=,args=", "--ppid", String(pid)], { encoding: "utf8" }).split("\n").filter((l) => l.includes("node.mojom.NodeService")).map((l) => Number(l.trim().split(/\s+/)[0]));
  } catch {
    return [];
  }
};
const alive = (pid) => existsSync(`/proc/${pid}`);

function setReadOnly(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) setReadOnly(p);
    chmodSync(p, statSync(p).isDirectory() ? 0o555 : 0o444);
  }
  chmodSync(dir, 0o555);
}
function setWritable(dir) {
  chmodSync(dir, 0o755);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) setWritable(p);
    else chmodSync(p, 0o644);
  }
}

test("the daemon and the pty process run from a read-only cwd, survive SIGUSR1, and stop in order on quit", { skip: process.platform !== "linux" ? "the child and port checks are Linux-only" : false }, async () => {
  assert.ok(process.env.DISPLAY || process.env.WAYLAND_DISPLAY, "no display: run under xvfb-run");
  const electron = createRequire(import.meta.url)("electron");
  assert.equal(typeof electron, "string", "the Electron runtime is not installed");
  const root = mkdtempSync(join(tmpdir(), "axis-desktop-seam-"));
  const app = join(root, "app");
  mkdirSync(join(app, "dist"), { recursive: true });
  cpSync(join(appDir, "package.json"), join(app, "package.json"));
  cpSync(join(appDir, "dist", "app"), join(app, "dist", "app"), { recursive: true });
  setReadOnly(app);
  const data = join(root, "data");
  const userData = join(root, "profile");
  let out = "";
  const env = { ...process.env, XDG_DATA_HOME: data };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.AXIS_DESKTOP_SMOKE;
  const child = spawn(electron, [app, `--user-data-dir=${userData}`], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise((r) => child.on("close", (code, signal) => r({ code, signal })));
  try {
    // SIGUSR1 to every Node service child from 300 ms after it appears (past the band before any statement runs) until ready.
    const start = Date.now();
    const seen = new Map();
    let signals = 0;
    while (!out.includes('"event":"host.ready"') && Date.now() - start < TIMEOUT_MS) {
      for (const pid of children(child.pid)) if (!seen.has(pid)) seen.set(pid, Date.now());
      for (const [pid, at] of seen) {
        if (Date.now() - at > 300 && alive(pid)) {
          try {
            process.kill(pid, "SIGUSR1");
            signals++;
          } catch {
            // gone
          }
        }
      }
      await wait(50);
    }
    assert.match(out, /"event":"host\.ready"/, `the daemon reached ready\n${out}`);
    assert.ok(signals > 4, `SIGUSR1 was sent while the children started (${signals})`);
    const kids = [...seen.keys()];
    assert.equal(kids.length, 2, `two Node service children: ${JSON.stringify(kids)}`);
    for (const pid of kids) assert.ok(alive(pid), `child ${pid} survived SIGUSR1`);
    assert.equal(await portOpen(9229), false, "no inspector on 127.0.0.1:9229");
    assert.doesNotMatch(out, /Debugger listening/);
    assert.doesNotMatch(out, /EACCES|EROFS|read-only/i, "no write into the read-only cwd");
    // OS-3h: the first hand-over completed only once both children acknowledged it.
    assert.match(out, /axis pty: handed_over generation=1/, "generation 1 acknowledged by both");
    // A daemon killed while running is restarted, and the next generation is acknowledged by both (the pty child started first).
    const daemonPid = Math.max(...kids);
    process.kill(daemonPid, "SIGKILL");
    const restartBy = Date.now() + 30_000;
    while (!/axis pty: handed_over generation=2/.test(out) && Date.now() < restartBy) await wait(100);
    assert.match(out, /axis pty: handed_over generation=2/, `a fresh hand-over after the daemon's restart\n${out}`);
    assert.doesNotMatch(out, /handover_failed/);
    // Quit: SIGTERM to main runs before-quit; the daemon stops first, then the pty process.
    child.kill("SIGTERM");
    const { code } = await Promise.race([exited, wait(40_000).then(() => ({ code: "timeout" }))]);
    assert.notEqual(code, "timeout", `main quit within the bound\n${out}`);
    const stopping = out.lastIndexOf("axis daemon: stopping");
    const daemonGone = out.indexOf("axis daemon: exited", out.lastIndexOf("axis daemon: stopping"));
    assert.ok(stopping !== -1, `the daemon was stopped gracefully\n${out}`);
    assert.ok(daemonGone === -1 || daemonGone > stopping, "the daemon stopped after the stop began");
    for (const pid of children(child.pid).concat(kids)) assert.equal(alive(pid), false, `child ${pid} gone after quit`);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    setWritable(app);
    rmSync(root, { recursive: true, force: true });
  }
});
