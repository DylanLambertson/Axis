// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// The packaged-build half of ticket NET-GATE (docs/design/net-gate.md; gates 1a/L29 and L33, residual RR-19). It launches a
// packaged desktop build and checks, from outside:
//   1. a plain run (extensions disabled) leaves no listening socket owned by the app's process tree (no reh-web, no Axis
//      listener, no inspector);
//   2. a run with --remote-debugging-port=<free port>, --inspect=<port>, --inspect-brk=<port> or --inspect-extensions=<port>
//      leaves nothing accepting connections on that port.
// It needs a packaged build and a way to list sockets (lsof, or /proc on Linux). Without a build it exits 2 and says so;
// with a build but no way to list sockets it exits 2 for check 1 (never a pass). Exit 0 = every check ran and passed,
// 1 = a check failed, 2 = skipped or inconclusive (the gate has NOT been satisfied).
//
//   node scripts/code-oss/check-net-packaged.mjs --app <executable> [--app-arg <arg>]... [--settle-ms N] [--record <file>]
//   (or AXIS_PACKAGED_APP=<executable>). --app-arg arguments go before the check's own flags (headless wrappers, test fakes).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_SKIP = 2;
export const SKIP_DIAGNOSTIC = "needs a packaged build: pass --app <executable> or set AXIS_PACKAGED_APP; the NET-GATE packaged checks did not run";
export const DEBUG_FLAGS = ["--remote-debugging-port", "--inspect", "--inspect-brk", "--inspect-extensions"];

/** Listening TCP ports of `lsof -F pn` output (`p<pid>` then `n<addr>:<port>` lines) restricted to `pids`. */
export function parseLsofListeners(text, pids) {
  const wanted = new Set(pids.map(String));
  const out = [];
  let pid = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("n") && wanted.has(pid)) {
      const m = /:(\d+)(?:\s|$)/.exec(line);
      if (m !== null) out.push({ pid: Number(pid), address: line.slice(1), port: Number(m[1]) });
    }
  }
  return out;
}

/** Listening sockets (state 0A) of /proc/net/tcp(6) text as inode -> { address, port }. */
export function parseProcNet(text) {
  const out = new Map();
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== "0A") continue;
    const [addr, port] = f[1].split(":");
    out.set(f[9], { address: addr, port: Number.parseInt(port, 16) });
  }
  return out;
}

/** All descendants of `root` (inclusive) in `ps -A -o pid=,ppid=` text. */
export function processTree(psText, root) {
  const children = new Map();
  for (const line of psText.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m !== null) children.set(m[2], [...(children.get(m[2]) ?? []), m[1]]);
  }
  const seen = [String(root)];
  for (let i = 0; i < seen.length; i++) for (const c of children.get(seen[i]) ?? []) if (!seen.includes(c)) seen.push(c);
  return seen.map(Number);
}

/** Listening sockets owned by `root`'s process tree: an array, or null when this host cannot say. */
export function listenersOfTree(root) {
  const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  if (ps.status !== 0 || ps.error !== undefined) return null;
  const pids = processTree(ps.stdout, root);
  if (process.platform === "linux" && existsSync("/proc/net/tcp")) {
    const sockets = new Map();
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) if (existsSync(file)) for (const [k, v] of parseProcNet(readFileSync(file, "utf8"))) sockets.set(k, v);
    const out = [];
    for (const pid of pids) {
      let fds = [];
      try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
      for (const fd of fds) {
        try {
          const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
          const s = m === null ? undefined : sockets.get(m[1]);
          if (s !== undefined) out.push({ pid, address: s.address, port: s.port });
        } catch { /* the descriptor closed */ }
      }
    }
    return out;
  }
  const lsof = spawnSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"], { encoding: "utf8" });
  if (lsof.error !== undefined || (lsof.status !== 0 && lsof.status !== 1)) return null;
  return parseLsofListeners(lsof.stdout, pids);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function freePort() {
  return new Promise((ok, fail) => {
    const s = net.createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

/** True when something accepts a TCP connection on 127.0.0.1:port (and ::1). */
export async function accepts(port) {
  const one = (host) => new Promise((ok) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); ok(v); };
    s.setTimeout(1000, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
  return (await one("127.0.0.1")) || (await one("::1"));
}

/** Kill the app's whole process group (a lone process on Windows). Always run, also after the leader exited: its children may live. */
export function killGroup(child) {
  try { process.platform === "win32" ? child.kill("SIGKILL") : process.kill(-child.pid, "SIGKILL"); } catch { /* the group is gone */ }
}

/** Launch the app, let it settle, run `inspect(child)`, then stop it. The profile is private and removed. */
async function withApp(app, appArgs, flags, settleMs, inspect, kill = killGroup) {
  const profile = mkdtempSync(join(tmpdir(), "axis-net-gate-"));
  const args = [...appArgs, `--user-data-dir=${join(profile, "user")}`, `--extensions-dir=${join(profile, "ext")}`, "--disable-extensions", "--no-sandbox", ...flags];
  const child = spawn(app, args, { stdio: "ignore", detached: process.platform !== "win32", env: { ...process.env, NODE_OPTIONS: "" } });
  let exit;
  child.once("exit", (code, signal) => { exit = { code, signal }; });
  child.once("error", (error) => { exit = { error: error.message }; });
  try {
    await delay(settleMs);
    return await inspect(child, exit);
  } finally {
    kill(child);
    await delay(100);
    rmSync(profile, { recursive: true, force: true });
  }
}

/** Run every check. Returns { status, results } with status "pass", "fail" or "skip". Injectable for the tests. */
export async function runChecks({ app, appArgs = [], settleMs = 8000, listeners = listenersOfTree, kill = killGroup } = {}) {
  if (app === undefined || app === "") return { status: "skip", results: [], diagnostic: SKIP_DIAGNOSTIC };
  const results = [];
  const plain = await withApp(app, appArgs, [], settleMs, async (child, exit) => {
    if (exit !== undefined) return { name: "plain run: no listener", status: "fail", detail: `the app did not stay up (${JSON.stringify(exit)}): nothing to inspect` };
    const found = listeners(child.pid);
    if (found === null) return { name: "plain run: no listener", status: "skip", detail: "this host cannot list sockets (needs lsof, or /proc on Linux): inconclusive" };
    return found.length === 0
      ? { name: "plain run: no listener", status: "pass", detail: "no listening socket in the app's process tree" }
      : { name: "plain run: no listener", status: "fail", detail: `listening: ${found.map((f) => `${f.address}:${f.port} (pid ${f.pid})`).join(", ")}` };
  }, kill);
  results.push(plain);
  for (const flag of DEBUG_FLAGS) {
    const port = await freePort();
    const name = `${flag} refused`;
    results.push(await withApp(app, appArgs, [`${flag}=${port}`], settleMs, async (_child, exit) => {
      // An app that exited did not honour the flag; whether it refused or crashed is not told apart (the plain run fails closed on a crash).
      if (exit !== undefined) return { name, status: "pass", detail: `the app exited (${JSON.stringify(exit)}): refused or crashed, not told apart` };
      const open = await accepts(port);
      return open ? { name, status: "fail", detail: `port ${port} accepts connections: the flag was honoured` } : { name, status: "pass", detail: `nothing accepts on port ${port}` };
    }, kill));
  }
  const status = results.some((r) => r.status === "fail") ? "fail" : results.some((r) => r.status === "skip") ? "skip" : "pass";
  return { status, results };
}

export const exitCodeOf = (status) => (status === "pass" ? EXIT_OK : status === "fail" ? EXIT_FAIL : EXIT_SKIP);

function parseArgs(argv, env) {
  const o = { app: env.AXIS_PACKAGED_APP, appArgs: [], settleMs: 8000, record: undefined };
  for (let i = 0; i < argv.length; i++) {
    const take = () => argv[++i];
    if (argv[i] === "--app") o.app = take();
    else if (argv[i] === "--app-arg") o.appArgs.push(take());
    else if (argv[i] === "--settle-ms") o.settleMs = Number(take());
    else if (argv[i] === "--record") o.record = take();
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!Number.isFinite(o.settleMs) || o.settleMs < 0) throw new Error("--settle-ms must be a number of milliseconds");
  return o;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2), process.env); } catch (e) { console.error(`check-net-packaged: ${e.message}`); process.exit(EXIT_FAIL); }
  const outcome = await runChecks(opts);
  if (outcome.diagnostic !== undefined) console.error(`check-net-packaged: SKIP: ${outcome.diagnostic}`);
  for (const r of outcome.results) console.log(`${r.status.toUpperCase().padEnd(4)} ${r.name}: ${r.detail}`);
  console.log(`check-net-packaged: ${outcome.status}${outcome.status === "skip" ? " (the gate is NOT satisfied)" : ""}`);
  if (opts.record !== undefined) {
    writeFileSync(opts.record, `${JSON.stringify({ status: outcome.status, platform: process.platform, recordedAt: new Date().toISOString(), results: outcome.results }, null, 2)}\n`);
  }
  process.exit(exitCodeOf(outcome.status));
}
