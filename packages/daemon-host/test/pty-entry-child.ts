// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// TEST ONLY (PV-X1a end to end): the Axis pty process as a child node process. It runs the real entry (`runPtyEntry`), so git
// runs through the production exec function (`createNodeExec`) configured from `AXIS_PTY_GIT` and `AXIS_PTY_SCRATCH`. Main's
// MessagePort cannot cross a process boundary, so the control channel is relayed over the IPC pipe: one MessageChannel here, its
// other end given to the entry as `{ type: "pty-control" }`. Terminals use the node:child_process stand-in (node-pty is Code OSS's).
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { runPtyEntry, type MessagePortLike } from "@axis/pty-process";
import { pipeSpawn } from "./pty-process-rig.js";

/** A Node MessagePort that delivers `{ data }` events, as Electron's `MessagePortMain` does. */
function electronShaped(port: MessagePort): MessagePortLike {
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

const { port1, port2 } = new MessageChannel();
port1.on("message", (m: unknown) => process.send?.(m));
process.on("message", (m: unknown) => port1.postMessage(m));
let deliver: ((event: { data: unknown; ports?: readonly MessagePortLike[] }) => void) | undefined;
const entry = runPtyEntry({
  parentPort: { on: (_e, l) => void (deliver = l), removeListener: () => void (deliver = undefined) },
  process: { exit: (c) => process.exit(c), on: (e, l) => process.on(e, l), removeListener: (e, l) => process.removeListener(e, l) },
  env: { ...process.env },
  execArgv: process.execArgv,
  platform: process.platform,
  spawn: pipeSpawn([]),
  stderr: (l) => void process.stderr.write(`${l}\n`),
});
deliver?.({ data: { type: "pty-control" }, ports: [electronShaped(port2)] });
process.on("disconnect", () => {
  entry.dispose();
  port1.close();
  process.exit(0);
});
