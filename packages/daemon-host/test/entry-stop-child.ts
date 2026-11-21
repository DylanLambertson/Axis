// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// TEST ONLY (PV-X1b finding): the daemon entry as a CHILD NODE PROCESS, composed the production way: `init` and a `pty-control`
// port, no `ports` override. `process.parentPort` is relayed over the IPC pipe, which the parent keeps open until the child exits,
// as Electron main keeps a utility process's parent port: neither lets the process end by draining. The control port's other end
// stands for the pty process.
import { MessageChannel, type MessagePort } from "node:worker_threads";
import type { ControlPortLike } from "../src/bindings/pty-control.js";
import { runDaemonEntry } from "../src/entry.js";
import type { ParentPortLike } from "../src/transport/electron-parent-port.js";

/** A Node MessagePort that delivers `{ data }` events, as Electron's `MessagePortMain` does. */
function electronShaped(port: MessagePort): ControlPortLike {
  const wrapped = new Map<unknown, (data: unknown) => void>();
  return {
    on(event: "message" | "close", listener: (arg: never) => void) {
      if (event === "message") {
        const w = (data: unknown): void => (listener as (e: unknown) => void)({ data, ports: [] });
        wrapped.set(listener, w);
        return port.on("message", w);
      }
      return port.on("close", listener as () => void);
    },
    removeListener(event: "message" | "close", listener: (arg: never) => void) {
      return port.removeListener(event, (event === "message" ? wrapped.get(listener) : listener) as () => void);
    },
    postMessage: (m: unknown) => port.postMessage(m),
    close: () => port.close(),
    start: () => port.start(),
  };
}

type Listener = (event: { data: unknown; ports?: readonly never[] }) => void;
let deliver: Listener | undefined;
const parentPort: ParentPortLike = {
  on: (_event, listener) => void (deliver = listener as Listener),
  off: () => void (deliver = undefined),
  postMessage: (m) => void process.send?.(m),
};
process.on("message", (m: unknown) => deliver?.({ data: m, ports: [] }));
const entry = runDaemonEntry({
  parentPort,
  process,
  env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
  cwd: process.cwd(),
  platform: process.platform,
  execArgv: process.execArgv,
  stderr: (l) => void process.stderr.write(`${l}\n`),
});
const { port2 } = new MessageChannel();
deliver?.({ data: { type: "pty-control" }, ports: [electronShaped(port2) as never] });
void entry.finished.then((code) => void process.stderr.write(`finished ${code}\n`));
