// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// TEST ONLY (OS-3h case c): the real pty entry inside a worker thread, so its control port arrives by a REAL transfer. Main sends
// `{ data, port? }`; a `{ fire: true }` message runs the entry's timers (its expiry) on demand.
import { parentPort } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import { runPtyEntry } from "../src/index.js";
import { electronShaped } from "./ports.js";

const timers: Array<() => void> = [];
let listener: ((e: { data: unknown; ports?: readonly unknown[] }) => void) | undefined;
runPtyEntry({
  parentPort: {
    on: (_e, l) => void (listener = l as never),
    removeListener: () => void (listener = undefined),
    postMessage: (m) => parentPort?.postMessage({ note: m }),
  },
  process: { exit: () => undefined, on: () => undefined, removeListener: () => undefined },
  env: {},
  execArgv: [],
  spawn: (() => {
    throw new Error("no spawn in this test");
  }) as never,
  stderr: () => undefined,
  timers: { set: (fn) => (timers.push(fn), timers.length), clear: (h) => void (timers[(h as number) - 1] = () => undefined) },
});
parentPort?.on("message", (m: { data?: unknown; port?: MessagePort; fire?: boolean }) => {
  if (m.fire === true) {
    for (const fn of timers.splice(0)) fn();
    parentPort?.postMessage({ fired: true });
    return;
  }
  listener?.({ data: m.data, ports: m.port === undefined ? [] : [electronShaped(m.port) as never] });
});
