// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import { classifyDeniedName, isValidName } from "@axis/pty-policy";
import { controlRequest, dataRequest, type ControlReply, type ControlRequest, type DataReply } from "./messages.js";
import { probeGroup, signalGroup, validPgid } from "./group.js";
import { OscCwdFilter } from "./osc.js";
import { hasNul, isAbsolutePath } from "./paths.js";
import { systemProcessOps, type Channel, type Disposable, type ProcessOps, type PtyChild, type PtySignal, type SpawnFn } from "./ports.js";

export interface PtyServiceOptions {
  /** Starts a child in its own session or job. In the shipped entry this is the native pty binding. */
  readonly spawn: SpawnFn;
  readonly ops?: ProcessOps;
  /** Terminal ids are `pty_` plus 32 hex characters of this. Default: node:crypto. */
  readonly randomBytes?: (n: number) => Uint8Array;
  /** Live terminals (a leader or a group still running). Default 64. */
  readonly maxTerminals?: number;
  /** Decides what an absolute path is for `argv[0]` and `cwd`. Default: this process's platform. */
  readonly platform?: NodeJS.Platform;
}

export interface PtyService {
  /** The one channel that may spawn and signal (the daemon's). A second control channel is refused. */
  serveControl(channel: Channel): Disposable;
  /**
   * A renderer data channel, named `conn` by whoever brokered it. It can attach only to a terminal the control channel
   * `grant`ed to `conn`, then write, resize and read output. A second channel with the same `conn` is closed.
   */
  serveData(channel: Channel, conn: string): Disposable;
  /** SIGKILLs the process group of every terminal, closes the channels, releases the listeners and settles. Idempotent. */
  dispose(): void;
}

interface Terminal {
  readonly id: string;
  readonly child: PtyChild;
  readonly filter: OscCwdFilter;
  readonly subs: Disposable[];
  /** The data connection that may attach (set by `grant`, cleared when that connection closes). */
  granted: string | undefined;
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
  const dataChannels = new Map<Channel, string>();
  const platform = options.platform ?? process.platform;
  const serviceSubs: Disposable[] = [];
  let control: Channel | undefined;
  let disposed = false;

  const sendTo = (ch: Channel | undefined, msg: ControlReply | DataReply): boolean => {
    if (ch === undefined) return false;
    try {
      ch.send(msg);
      return true;
    } catch {
      return false; // a closed peer; its onClose handler cleans up
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

  const refuseSpawn = (req: string, code: Extract<ControlReply, { t: "spawn-failed" }>["code"]): void => void sendTo(control, { t: "spawn-failed", req, code });

  /** Ends a terminal nobody can own any more: kills its group, releases its listeners and tells its viewer. */
  const discard = (t: Terminal): void => {
    killTerminal(t, "SIGKILL");
    t.subs.forEach((d) => d.dispose());
    terminals.delete(t.id);
    sendTo(t.owner, { t: "exit", term: t.id });
    t.owner = undefined;
  };

  const handleSpawn = (m: Extract<ControlRequest, { t: "spawn" }>): void => {
    if (disposed) return refuseSpawn(m.req, "spawn_failed");
    // PTY-5 backstop: the daemon already built the environment; a denied or malformed name here is a bug or an attack, so refuse.
    for (const name of Object.keys(m.env)) if (!isValidName(name) || classifyDeniedName(name) !== undefined) return refuseSpawn(m.req, "env_denied");
    for (const value of Object.values(m.env)) if (hasNul(value)) return refuseSpawn(m.req, "env_denied");
    // CLI-1 backstop: the daemon resolved an absolute executable and the worktree is an absolute directory; a relative one would be
    // searched in PATH by the spawn function, and a NUL would truncate silently in a native binding.
    if (!isAbsolutePath(m.argv[0] ?? "", platform) || !isAbsolutePath(m.cwd, platform) || m.argv.some(hasNul) || hasNul(m.cwd)) return refuseSpawn(m.req, "spawn_failed");
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
    const t: Terminal = { id: idText, child, filter: new OscCwdFilter(), subs: [], granted: undefined, owner: undefined, exited: false, groupGone: false };
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
    // Nobody to tell (the control channel closed or refuses the message): nobody could own or kill this group, so end it now.
    if (!sendTo(control, { t: "spawned", req: m.req, term: t.id, group: g.kind === "pgid" ? { kind: "pgid", pgid: g.pgid } : { kind: "job" } })) discard(t);
  };

  const onControl = (channel: Channel, raw: unknown): void => {
    if (control !== channel) return; // closed: a message that was already queued must not start anything
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
    if (m.t === "grant") {
      if (t.owner !== undefined && dataChannels.get(t.owner) !== m.conn) t.owner = undefined; // re-granted to another connection
      t.granted = m.conn;
      return;
    }
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
      return void sendTo(channel, { t: "refused", term: null, code: "unsupported" });
    }
    const m = parsed.data;
    const t = terminals.get(m.term);
    // One answer for an unknown id and for an id granted to someone else.
    const refuse = (): void => void sendTo(channel, { t: "refused", term: null, code: "foreign_terminal" });
    if (t === undefined || t.granted === undefined || t.granted !== dataChannels.get(channel)) return refuse();
    if (m.t === "attach") {
      t.owner = channel;
      sendTo(channel, { t: "attached", term: t.id });
      return;
    }
    if (t.owner !== channel) return refuse();
    try {
      if (m.t === "resize") t.child.resize(m.cols, m.rows);
      else if (!t.exited) t.child.write(m.data);
    } catch {
      /* a dying child */
    }
  };

  const closeChannel = (channel: Channel): void => {
    const conn = dataChannels.get(channel);
    for (const t of terminals.values()) {
      if (t.owner === channel) t.owner = undefined;
      if (conn !== undefined && t.granted === conn) t.granted = undefined; // the grant dies with the connection: only a new grant lets one attach
    }
    dataChannels.delete(channel);
    if (control === channel) {
      control = undefined;
      // Nobody can signal these any more and no run row will ever name them: closing the control channel ends every terminal.
      for (const t of [...terminals.values()]) discard(t);
    }
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
      const subs = [channel.onMessage((m) => onControl(channel, m)), channel.onClose(() => closeChannel(channel))];
      serviceSubs.push(...subs);
      return { dispose: () => void (subs.forEach((s) => s.dispose()), closeChannel(channel)) };
    },
    serveData(channel, conn) {
      if (disposed || [...dataChannels.values()].includes(conn)) {
        try {
          channel.close();
        } catch {
          /* already closed */
        }
        return { dispose: () => undefined };
      }
      dataChannels.set(channel, conn);
      const subs = [channel.onMessage((m) => onData(channel, m)), channel.onClose(() => closeChannel(channel))];
      serviceSubs.push(...subs);
      return { dispose: () => void (subs.forEach((s) => s.dispose()), closeChannel(channel)) };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const t of terminals.values()) killTerminal(t, "SIGKILL");
      for (const t of terminals.values()) t.subs.forEach((d) => d.dispose());
      terminals.clear();
      serviceSubs.forEach((d) => d.dispose());
      serviceSubs.length = 0;
      for (const ch of [...dataChannels.keys(), ...(control === undefined ? [] : [control])]) {
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
