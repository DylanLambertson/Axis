// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Runs one test suite as a child in its own process group and streams its output live. Memory is
// bounded (only a tail is kept, for the pass/fail counts and the "last output" in a report), the
// output is capped and the run is time-limited: a suite that spins, hangs or floods is killed and
// named in its `== suite:` line instead of stalling or exhausting the job silently.
import { spawn, spawnSync } from "node:child_process";
import { parseTestCounts } from "./lib.mjs";

export const DEFAULT_TIMEOUT_MS = 20 * 60_000;
export const DEFAULT_OUTPUT_CAP_BYTES = 512 * 1024 * 1024;
const TAIL_BYTES = 256 * 1024;
const KILL_GRACE_MS = 5_000;

/** Kill a whole process group: SIGTERM, then SIGKILL after a grace. Resolves when the group is gone or the grace passed. */
export function killGroup(pid, graceMs = KILL_GRACE_MS) {
  if (pid === undefined || process.platform === "win32") return Promise.resolve();
  const send = (sig) => { try { process.kill(-pid, sig); return true; } catch { return false; } };
  if (!send("SIGTERM")) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => { send("SIGKILL"); resolve(); }, graceMs);
    const poll = setInterval(() => { if (!send(0)) { clearTimeout(t); clearInterval(poll); resolve(); } }, 100);
  });
}

/** Memory and the biggest processes now: the evidence a CI job killed for memory leaves nowhere else (dmesg is not readable on a runner). */
export function memorySample() {
  if (process.platform !== "linux") return "";
  const run = (c, a) => spawnSync(c, a, { encoding: "utf8", timeout: 5_000 }).stdout ?? "";
  const mem = run("free", ["-m"]).split("\n").slice(0, 2).join(" | ");
  const top = run("ps", ["-eo", "rss,pid,args", "--sort=-rss"]).split("\n").slice(1, 6).map((l) => l.trim().slice(0, 140)).join("\n    ");
  return `${mem}\n    ${top}`;
}

/** Limits from the environment: a positive integer or an error naming the variable (a typo must not disable a limit or kill at once). */
export function readLimits(env = process.env) {
  const one = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
    return Number(raw);
  };
  return { timeoutMs: one("AXIS_TEST_SUITE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS), capBytes: one("AXIS_TEST_OUTPUT_CAP_BYTES", DEFAULT_OUTPUT_CAP_BYTES) };
}

/** The child of the running suite (for the runner's signal handler). */
export const live = { child: undefined, name: "(none)" };

export function runSuite(name, command, args, opts = {}) {
  const cwd = opts.cwd;
  const timeoutMs = opts.timeoutMs ?? readLimits().timeoutMs;
  const capBytes = opts.capBytes ?? readLimits().capBytes;
  const out = opts.out ?? process.stdout;
  const err = opts.err ?? process.stderr;
  const sampleMs = opts.sampleMs ?? Number(process.env.AXIS_TEST_SAMPLE_MS ?? (process.env.CI === undefined ? 0 : 30_000));
  const sampleAfterMs = opts.sampleAfterMs ?? 180_000;
  live.name = name;
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    live.child = child;
    let tail = Buffer.alloc(0);
    let total = 0;
    let spawnError;
    const started = Date.now();
    const sample = (why) => { const m = memorySample(); if (m !== "") out.write(`\n== sample (${name}, +${Math.round((Date.now() - started) / 1000)}s, ${why}): ${m}\n`); };
    const sampler = sampleMs > 0 ? setInterval(() => { if (Date.now() - started >= sampleAfterMs) sample("running"); }, sampleMs) : undefined;
    sampler?.unref();
    let stopped; // why the runner ended it: "timeout" | "cap"
    const stop = (why) => {
      if (stopped !== undefined) return;
      stopped = why;
      sample(why);
      void killGroup(child.pid, opts.graceMs ?? KILL_GRACE_MS);
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const take = (sink) => (data) => {
      total += data.length;
      if (total > capBytes && stopped === undefined) stop("cap");
      if (stopped === "cap") return;
      sink.write(data);
      tail = Buffer.concat([tail, data]);
      if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
    };
    child.stdout.on("data", take(out));
    child.stderr.on("data", take(err));
    child.on("error", (e) => { spawnError = e; });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      clearInterval(sampler);
      // Anything the suite left running in its group is killed, never left to hold the job.
      if (child.pid !== undefined && process.platform !== "win32") try { process.kill(-child.pid, "SIGKILL"); } catch { /* none left */ }
      const text = tail.toString("utf8");
      const counts = parseTestCounts(text);
      let why = "";
      if (stopped === "timeout") {
        const last = text.trimEnd().split("\n").pop()?.slice(0, 200) ?? "";
        why = `, TIMED OUT after ${Math.round(timeoutMs / 1000)}s (last output: ${last})`;
      } else if (stopped === "cap") why = `, OUTPUT CAP exceeded (${capBytes} bytes; output beyond it was dropped)`;
      else if (signal !== null) why = `, killed by ${signal}`;
      else if (spawnError !== undefined) why = `, ${spawnError.message}`;
      else if (status !== 0) why = `, exit ${status}`;
      const ok = status === 0 && signal === null && spawnError === undefined && stopped === undefined;
      out.write(`\n== ${name}: ${ok ? "ok" : "FAILED"} (${counts.pass} pass, ${counts.fail} fail${why})\n\n`);
      live.child = undefined;
      resolve({ name, ok, ...counts });
    });
  });
}
