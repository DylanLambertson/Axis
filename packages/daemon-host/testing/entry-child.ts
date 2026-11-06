// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { MessageChannel, type MessagePort } from "node:worker_threads";
import type { ElectronPortLike } from "@axis/daemon";
import { resolveGit } from "@axis/git-ops";
import { runDaemonEntry } from "../src/entry.js";
import type { ParentPortLike } from "../src/index.js";
import { LocalPty, localPtyGitRunner } from "./fake-pty.js";

/**
 * TEST ONLY: the real daemon entry (`runDaemonEntry`) in a child process, as main's tests see it (`test/main-e2e.test.ts`). The
 * child's `process.parentPort` is a shim over the Node IPC channel. Node cannot transfer a `MessagePort` between processes, so a
 * message the parent sends with a port (`{ kind: "port", pid, data }`) becomes a REAL `MessageChannel` here: one end is handed to
 * the entry exactly as Electron hands a transferred `MessagePortMain`, the other is tunnelled to the parent as `frame` and `closed`
 * messages. The entry, the host and the attestation verifier are the production code; only the pty port and the pty git runner
 * are the test fakes the production entry does not have (it refuses `pty_required`); the run snapshotter is the real one.
 */

type Wire =
  | { kind: "ctl"; data: unknown }
  | { kind: "port"; pid: number; data: unknown }
  | { kind: "frame"; pid: number; data: unknown }
  | { kind: "close"; pid: number };

const send = (m: unknown): void => void process.send?.(m);
const tunnels = new Map<number, MessagePort>();
let listener: ((e: { data: unknown; ports?: ReadonlyArray<ElectronPortLike> }) => void) | undefined;

function electronEnd(port: MessagePort): ElectronPortLike {
  return {
    on: ((event: string, h: (...a: never[]) => void) =>
      event === "message" ? port.on("message", (data: unknown) => (h as (e: unknown) => void)({ data, ports: [] })) : port.on("close", h as () => void)) as ElectronPortLike["on"],
    postMessage: (m) => port.postMessage(m),
    start: () => port.start(),
    close: () => port.close(),
  };
}

process.on("message", (raw: unknown) => {
  const m = raw as Wire;
  if (m.kind === "ctl") listener?.({ data: m.data, ports: [] });
  else if (m.kind === "port") {
    const { port1, port2 } = new MessageChannel();
    tunnels.set(m.pid, port1);
    port1.on("message", (data: unknown) => send({ kind: "frame", pid: m.pid, data }));
    port1.on("close", () => {
      tunnels.delete(m.pid);
      send({ kind: "closed", pid: m.pid });
    });
    listener?.({ data: m.data, ports: [electronEnd(port2)] });
  } else if (m.kind === "frame") tunnels.get(m.pid)?.postMessage(m.data);
  else if (m.kind === "close") tunnels.get(m.pid)?.close();
});

const parentPort: ParentPortLike = {
  on: (_e, l) => void (listener = l),
  off: (_e, l) => void (listener === l ? (listener = undefined) : undefined),
  postMessage: (data) => send({ kind: "ctl", data }),
};

const env = { ...process.env };
const gitPath = resolveGit(env, process.platform);
if (gitPath === undefined) throw new Error("git not found");
const handle = runDaemonEntry({
  parentPort,
  process,
  env,
  cwd: process.cwd(),
  platform: process.platform,
  execArgv: process.execArgv,
  stderr: (line) => void process.stderr.write(`${line}\n`),
  ports: { pty: new LocalPty(), ptyGitRunner: localPtyGitRunner(gitPath, env) },
});
// A drained exit must not be held open by the IPC channel or a tunnel.
void handle.finished.then(() => {
  for (const p of tunnels.values()) p.close();
  process.disconnect?.();
});
