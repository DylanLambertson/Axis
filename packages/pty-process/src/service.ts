// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import { classifyDeniedName, isValidName } from "@axis/pty-policy";
import { controlRequest, dataRequest, type ControlReply, type ControlRequest, type DataReply } from "./messages.js";
import { probeGroup, signalGroup, validPgid } from "./group.js";
import { Osc633Filter } from "./osc.js";
import { systemProcessOps, type Channel, type Disposable, type ProcessOps, type PtyChild, type PtySignal, type SpawnFn } from "./ports.js";

export interface PtyServiceOptions {
  /** Starts a child in its own session or job. In the shipped entry this is the native pty binding. */
  readonly spawn: SpawnFn;
  readonly ops?: ProcessOps;
  /** Terminal ids are `pty_` plus 32 hex characters of this. Default: node:crypto. */
  readonly randomBytes?: (n: number) => Uint8Array;
  /** Live terminals (a leader or a group still running). Default 64. */
  readonly maxTerminals?: number;
}

export interface PtyService {
  /** The one channel that may spawn and signal (the daemon's). A second control channel is refused. */
  serveControl(channel: Channel): Disposable;
  /** A renderer data channel. It can only attach to issued ids, then write, resize and read output. */
  serveData(channel: Channel): Disposable;
  /** SIGKILLs the process group of every terminal, closes the channels and settles. Idempotent. */
  dispose(): void;
}

interface Terminal {
  readonly id: string;
  readonly child: PtyChild;
  readonly filter: Osc633Filter;
  readonly subs: Disposable[];
  owner: Channel | undefined;
  exited: boolean;
  groupGone: boolean;
}

export const DEFAULT_MAX_TERMINALS = 64;

export function createPtyService(options: PtyServiceOptions): PtyService {
  const ops = options.ops ?? systemProcessOps;
  const max = options.maxTerminals ?? DEFAULT_MAX_TERMINALS;
  const rand = options.randomBytes ?? ((n: number): Uint8Array => randomBytes(n));
  const terminals = new Map<string, Terminal>();
  const dataChannels = new Set<Channel>();
  let control: Channel | undefined;
  let disposed = false;

  const sendTo = (ch: Channel | undefined, msg: ControlReply | DataReply): void => {
    if (ch === undefined) return;
    try {
      ch.send(msg);
    } catch {
      /* a closed peer; its onClose handler cleans up */
    }
  };

  /** Whether the group still has a process. Unknown counts as alive (fail closed). */
  const groupLive = (t: Terminal): boolean => {
    if (t.groupGone) return false;
    if (t.child.group.kind === "job") return true; // ends only on onGroupEmpty
    try {
      if (probeGroup(ops, t.child.group.pgid) === "gone") t.groupGone = true;
    } catch {
      return true;
    }
    return !t.groupGone;
  };

  const reap = (): void => {
    for (const [id, t] of terminals) {
      if (!t.exited || groupLive(t)) continue;
      t.subs.forEach((d) => d.dispose());
      terminals.delete(id);
    }
  };

  const killTerminal = (t: Terminal, signal: PtySignal): void => {
    try {
      if (t.child.group.kind === "pgid") {
        if (signalGroup(ops, t.child.group.pgid, signal) === "gone") t.groupGone = true;
      } else if (!t.groupGone) t.child.kill(signal);
    } catch {
      /* a refused signal leaves the group alive, which stays visible through groupAlive */
    }
  };

  const refuseSpawn = (req: string, code: Extract<ControlReply, { t: "spawn-failed" }>["code"]): void => sendTo(control, { t: "spawn-failed", req, code });

  const handleSpawn = (m: Extract<ControlRequest, { t: "spawn" }>): void => {
    if (disposed) return refuseSpawn(m.req, "spawn_failed");
    // PTY-5 backstop: the daemon already built the environment; a denied or malformed name here is a bug or an attack, so refuse.
    for (const name of Object.keys(m.env)) if (!isValidName(name) || classifyDeniedName(name) !== undefined) return refuseSpawn(m.req, "env_denied");
    for (const value of Object.values(m.env)) if (value.includes("\0")) return refuseSpawn(m.req, "env_denied");
    reap();
    if (terminals.size >= max) return refuseSpawn(m.req, "capacity");
    let child: PtyChild;
    try {
      child = options.spawn({ argv: m.argv, cwd: m.cwd, env: m.env, cols: m.cols, rows: m.rows });
    } catch {
      return refuseSpawn(m.req, "spawn_failed");
    }
    const g = child.group;
    if (g.kind === "pgid" && (!validPgid(g.pgid) || g.pgid !== child.pid)) {
      // Not the leader of its own group: signalling `-pgid` would hit someone else's processes. Stop the leader only.
      try {
        child.kill("SIGKILL");
      } catch {
        /* nothing more can be done */
      }
      return refuseSpawn(m.req, "bad_group");
    }
    let idText = "";
    do idText = "pty_" + Buffer.from(rand(16)).toString("hex");
    while (terminals.has(idText));
    const t: Terminal = { id: idText, child, filter: new Osc633Filter(), subs: [], owner: undefined, exited: false, groupGone: false };
    terminals.set(t.id, t);
    t.subs.push(
      child.onData((chunk) => {
        const out = t.filter.push(chunk);
        if (out !== "") sendTo(t.owner, { t: "data", term: t.id, chunk: out });
      }),
      child.onExit((exit) => {
        t.exited = true;
        sendTo(control, { t: "exit", term: t.id, exitCode: exit.exitCode, signal: exit.signal });
        sendTo(t.owner, { t: "exit", term: t.id });
      }),
    );
    if (child.onGroupEmpty !== undefined) {
      t.subs.push(
        child.onGroupEmpty(() => {
          t.groupGone = true;
          sendTo(control, { t: "group-empty", term: t.id });
        }),
      );
    }
    sendTo(control, { t: "spawned", req: m.req, term: t.id, group: g.kind === "pgid" ? { kind: "pgid", pgid: g.pgid } : { kind: "job" } });
  };

  const onControl = (raw: unknown): void => {
    const parsed = controlRequest.safeParse(raw);
    if (!parsed.success) {
      const req = typeof raw === "object" && raw !== null && typeof (raw as { req?: unknown }).req === "string" ? (raw as { req: string }).req : undefined;
      if (req !== undefined && req.length > 0 && req.length <= 128) refuseSpawn(req, "spawn_failed"); // a malformed spawn must not leave the daemon waiting for its bound
      return;
    }
    const m = parsed.data;
    if (m.t === "spawn") return handleSpawn(m);
    const t = terminals.get(m.term);
    if (t === undefined) return; // already reaped: the group is gone
    try {
      if (m.t === "kill") killTerminal(t, m.signal);
      else if (m.t === "resize") t.child.resize(m.cols, m.rows);
      else if (!t.exited) t.child.write(m.data);
    } catch {
      /* a dying child */
    }
  };

  const onData = (channel: Channel, raw: unknown): void => {
    const parsed = dataRequest.safeParse(raw);
    if (!parsed.success) {
      // A spawn, a kill or anything else on a data channel is refused and never acted on.
      return sendTo(channel, { t: "refused", term: null, code: "unsupported" });
    }
    const m = parsed.data;
    const t = terminals.get(m.term);
    if (t === undefined) return sendTo(channel, { t: "refused", term: null, code: "unknown_terminal" });
    if (m.t === "attach") {
      if (t.owner !== undefined && t.owner !== channel) return sendTo(channel, { t: "refused", term: null, code: "foreign_terminal" });
      t.owner = channel;
      return sendTo(channel, { t: "attached", term: t.id });
    }
    if (t.owner !== channel) return sendTo(channel, { t: "refused", term: null, code: "foreign_terminal" });
    try {
      if (m.t === "resize") t.child.resize(m.cols, m.rows);
      else if (!t.exited) t.child.write(m.data);
    } catch {
      /* a dying child */
    }
  };

  const closeChannel = (channel: Channel): void => {
    for (const t of terminals.values()) if (t.owner === channel) t.owner = undefined;
    dataChannels.delete(channel);
    if (control === channel) control = undefined;
  };

  return {
    serveControl(channel) {
      if (disposed || control !== undefined) {
        try {
          channel.close();
        } catch {
          /* already closed */
        }
        return { dispose: () => undefined };
      }
      control = channel;
      const subs = [channel.onMessage(onControl), channel.onClose(() => closeChannel(channel))];
      return { dispose: () => void (subs.forEach((s) => s.dispose()), closeChannel(channel)) };
    },
    serveData(channel) {
      if (disposed) {
        channel.close();
        return { dispose: () => undefined };
      }
      dataChannels.add(channel);
      const subs = [channel.onMessage((m) => onData(channel, m)), channel.onClose(() => closeChannel(channel))];
      return { dispose: () => void (subs.forEach((s) => s.dispose()), closeChannel(channel)) };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const t of terminals.values()) killTerminal(t, "SIGKILL");
      for (const t of terminals.values()) t.subs.forEach((d) => d.dispose());
      terminals.clear();
      for (const ch of [...dataChannels, ...(control === undefined ? [] : [control])]) {
        try {
          ch.close();
        } catch {
          /* already closed */
        }
      }
      dataChannels.clear();
      control = undefined;
    },
  };
}
