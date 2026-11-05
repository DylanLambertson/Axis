// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DrainGate, ShutdownCoordinator } from "@axis/daemon";
import { createDaemonHost, installHostLifecycle } from "../src/index.js";
import { hostFixture } from "./host-fixture.js";

/**
 * Child process of the exit-by-draining test: a real host (real storage, lock and database) behind the real
 * lifecycle on the real `process`. It never calls `process.exit` on a released shutdown, so it ends only if
 * nothing is left holding the event loop. stdin lines drive it: `pending` (start one unit of work), `release`
 * (finish it), `signal` (send itself SIGTERM), `message` (the control `shutdown` message), `again` (a repeat).
 */
const fx = hostFixture();
const drain = new DrainGate();
const flushMs = Number(process.argv[2] ?? "30000");
const coordinator = new ShutdownCoordinator(
  { drain, cancelAll: () => 0, closeAll: () => undefined, store: { flush: () => undefined } as never, onError: () => undefined },
  { graceMs: 60_000, cancelSettleMs: 50, flushTimeoutMs: 50 },
);
const host = createDaemonHost(fx.config, fx.ports);
const say = (o: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify(o)}\n`);

await host.start();
installHostLifecycle({
  daemon: { shutdown: (r) => coordinator.run(r), escalate: () => coordinator.escalate() },
  control: fx.client,
  stop: async () => {
    const r = await host.stop();
    fx.cleanup();
    return r;
  },
  process,
  finalize: () => undefined,
  finalizeTimeoutMs: flushMs,
  exit: (code, info) => {
    say({ exit: code, released: info.released, running: drain.running });
    process.exitCode = code;
    process.stdin.destroy(); // the child's own resource: the test driver pipe must not hold the loop
    if (!info.released) process.exit(code);
  },
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  for (const line of chunk.split("\n").map((l) => l.trim())) {
    if (line === "pending") drain.enter();
    else if (line === "release") drain.leave();
    else if (line === "signal") process.kill(process.pid, "SIGTERM");
    else if (line === "message" || line === "again") fx.peer.send({ type: "shutdown" });
    else if (line === "close") process.stdin.pause();
    if (line !== "") say({ ack: line });
  }
});
say({ ready: true });
