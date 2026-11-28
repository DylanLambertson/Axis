// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// TEST ONLY (OS-3h case b): a pty-side receiver in a worker thread that adopts every control port it is given by a REAL transfer
// and never answers anything: no acknowledgement, no close confirmation. It reports how many messages arrived on its ports.
import { parentPort, type MessagePort } from "node:worker_threads";

const held: MessagePort[] = [];
let received = 0;
parentPort?.on("message", (m: { port?: MessagePort; count?: boolean }) => {
  if (m.count === true) {
    parentPort?.postMessage({ received });
    return;
  }
  if (m.port !== undefined) {
    m.port.on("message", () => void received++);
    held.push(m.port);
  }
});
