// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import { classifyDeniedName, isValidName } from "@axis/pty-policy";
import type { ForgeReply } from "@axis/protocol";
import { createForgeList, forgeRequestId, type ForgeList, type ForgeListConfig } from "./forge-list.js";
import { createGitExec, type GitExec, type GitExecConfig } from "./git-exec.js";
import { controlRequest, dataRequest, relayOutbound, type ControlReply, type ControlRequest, type DataReply, type ExecReply, type RelayInbound } from "./messages.js";
import { createEndpointHost, type EndpointHostConfig } from "./endpoint-host.js";
import { DEFAULT_FLOW, OutputFlow, type FlowLimits } from "./flow.js";
import { DEFAULT_INPUT_LIMITS, inputFull as inputOver } from "./input.js";
import { probeGroup, signalGroup, validPgid } from "./group.js";
import { OscCwdFilter } from "./osc.js";
import { preparePush, vetPushRemote } from "./push-run.js";
import { hasNul, isAbsolutePath } from "./paths.js";
import { systemClock, systemProcessOps, type Channel, type Clock, type Disposable, type ExecChild, type ProcessOps, type PtyChild, type PtySignal, type SpawnFn } from "./ports.js";

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
  /** `exec`, `scratch-*` and `hook` (H9-hooks). Absent: every such message is refused. */
  readonly git?: GitExecConfig;
  /** `forge-list` (PV-D2): `gh` through its own exec function. Absent: every `forge-list` answers `spawn_missing`. */
  readonly forge?: ForgeListConfig;
  /** Times each exec. Default: the system clock. */
  readonly clock?: Clock;
  /** Output flow-control bounds per terminal (characters in flight to the viewer). Default 1 MiB pause, 256 KiB resume, 4 MiB drop. */
  readonly flow?: FlowLimits;
  /** Bytes of unconsumed input per terminal and in the whole process before further input is refused (PTY-4). Default 1 MiB and 8 MiB. */
  readonly input?: Partial<{ terminal: number; process: number; entriesTerminal: number; entriesProcess: number }>;
  /** Distinct data-connection names served over the life of the service; past this a new name is refused. Default 65536. */
  readonly maxConnNames?: number;
  /** PV-M6: the messaging endpoint listener's runtime directory. Absent (the default): a spawn asking for an endpoint is refused. */
  readonly messagesEndpoints?: EndpointHostConfig;
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
  filter: OscCwdFilter;
  readonly flow: OutputFlow;
  readonly subs: Disposable[];
  /** The data connection that may attach (set by `grant`, cleared when that connection closes). */
  granted: string | undefined;
  owner: Channel | undefined;
  /** The viewer parser may have missed output (a drop, or no viewer): the next chunk starts from a fresh filter and a CAN. */
  resync: boolean;
  /** A viewer parser has seen part of this stream and may now have a gap: the next chunk also starts with CAN. */
  cancel: boolean;
  /** A viewer has been attached at some point. */
  seen: boolean;
  /** Input was refused: every write is refused until the child has taken all it was given. */
  inputBlocked: boolean;
  exited: boolean;
  /** DC-3a: no data connection may reach this terminal again (a `revoke`, or the leader's exit). Never cleared. */
  revoked: boolean;
  /** The run's messaging endpoint, closed with the terminal (PV-M6). */
  endpoint?: string;
  groupGone: boolean;
}

export const DEFAULT_MAX_TERMINALS = 64;
export { DEFAULT_INPUT_LIMITS } from "./input.js";
export const DEFAULT_MAX_CONN_NAMES = 65536;

export function createPtyService(options: PtyServiceOptions): PtyService {
  const ops = options.ops ?? systemProcessOps;
  const max = options.maxTerminals ?? DEFAULT_MAX_TERMINALS;
  const rand = options.randomBytes ?? ((n: number): Uint8Array => randomBytes(n));
  const terminals = new Map<string, Terminal>();
  const dataChannels = new Map<Channel, string>();
  const platform = options.platform ?? process.platform;
  const usedNames = new Set<string>();
  const maxNames = options.maxConnNames ?? DEFAULT_MAX_CONN_NAMES;
  const channelSubs = new Map<Channel, Disposable[]>();
  let control: Channel | undefined;
  let disposed = false;
  // Replies go to whichever control channel is open when the work finishes; after a close they are dropped.
  const clock = options.clock ?? systemClock;
  const git: GitExec | undefined = options.git === undefined ? undefined : createGitExec(options.git, clock, platform, (m) => void sendTo(control, m));
  const forge: ForgeList | undefined = options.forge === undefined ? undefined : createForgeList(options.forge, clock, platform, (m) => void sendTo(control, m));
  const endpoints = options.messagesEndpoints === undefined ? undefined : createEndpointHost(options.messagesEndpoints, { send: (m) => sendTo(control, m), clock, random: rand });

  const sendTo = (ch: Channel | undefined, msg: ControlReply | DataReply | ExecReply | ForgeReply | RelayInbound): boolean => {
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

  const tryChild = (fn: (() => void) | undefined): void => {
    try {
      fn?.();
    } catch {
      /* a dying child */
    }
  };
  /** The viewer changed or left: nothing is outstanding, so a paused child must run again (its output is dropped without a viewer). */
  const releaseFlow = (t: Terminal): void => {
    if (t.flow.reset()) tryChild(t.child.resume?.bind(t.child));
  };
  /**
   * DC-3a (terminals-contract.md section 5): ends every data connection's access to `t`, for good. The grant is cleared, the owner
   * is told the terminal ended and detached, and no later grant is taken (a stale one in flight included). The data connection
   * itself stays open: it may carry other terminals.
   */
  const revoke = (t: Terminal): void => {
    if (t.revoked) return;
    t.revoked = true;
    t.granted = undefined;
    if (t.owner === undefined) return;
    sendTo(t.owner, { t: "exit", term: t.id });
    t.owner = undefined;
    releaseFlow(t);
  };

  const inputLimits = { ...DEFAULT_INPUT_LIMITS, ...options.input };
  const inputFull = (t: Terminal): boolean => inputOver(t, () => terminals.values(), inputLimits);

  const refuseSpawn = (req: string, code: Extract<ControlReply, { t: "spawn-failed" }>["code"]): void => void sendTo(control, { t: "spawn-failed", req, code });

  /** Ends a terminal nobody can own any more: kills its group, releases its listeners and tells its viewer. */
  const discard = (t: Terminal): void => {
    killTerminal(t, "SIGKILL");
    t.subs.forEach((d) => d.dispose());
    if (t.endpoint !== undefined) endpoints?.close(t.endpoint);
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
    const ep = m.messagesEndpoint;
    if (ep === undefined) return startTerminal(m.req, m.argv, m.cwd, m.env, m.cols, m.rows);
    // ADR 0007 amendment item 1: the two names are added here only, after the PTY-5 check above, and only with the request.
    if (endpoints === undefined) return refuseSpawn(m.req, "endpoint_unavailable");
    const ch = control;
    void endpoints.open(ep.endpoint).then((path) => {
      if (disposed || control !== ch) return endpoints.close(ep.endpoint); // nobody to answer: listen for nobody either
      if (path === undefined) return refuseSpawn(m.req, "endpoint_unavailable");
      startTerminal(m.req, m.argv, m.cwd, { ...m.env, AXIS_MESSAGES_ENDPOINT: path, AXIS_MESSAGES_TOKEN: ep.token }, m.cols, m.rows, ep.endpoint);
      if (![...terminals.values()].some((t) => t.endpoint === ep.endpoint)) endpoints.close(ep.endpoint); // the spawn was refused
    });
  };

  /** H9-hooks: a hook is a terminal like any other, but its argv, cwd and redirectors come from the service (§4.2, §4.3). */
  const handleHook = (m: Extract<ControlRequest, { t: "hook" }>): void => {
    if (disposed || git === undefined) return refuseSpawn(m.req, "spawn_failed");
    const p = git.prepareHook(m);
    if ("code" in p) return refuseSpawn(m.req, p.code);
    startTerminal(m.req, p.argv, p.cwd, p.env, m.cols, m.rows);
  };

  /** Remote checks running for a push (each starts two git reads); past the bound a push is refused `capacity`. */
  let vetting = 0;
  const vetChildren = new Set<ExecChild>();
  const killVets = (): void => {
    for (const c of [...vetChildren]) {
      try {
        c.kill();
      } catch {
        /* gone */
      }
    }
    vetChildren.clear();
  };
  /**
   * H9-hooks S4: a push is a terminal like any other, but its argv, pins and environment come from the service (§5.2), and the
   * service checks the remote itself first (`vetPushRemote`: no `remote.<r>.vcs` helper, no helper URL). A control channel that
   * closed (or a service disposed) while the check ran starts nothing and gets no reply.
   */
  const handlePush = (m: Extract<ControlRequest, { t: "push" }>): void => {
    if (disposed || options.git === undefined) return refuseSpawn(m.req, "spawn_failed");
    const cfg = options.git;
    const p = preparePush(m, cfg, platform);
    if ("code" in p) return refuseSpawn(m.req, p.code);
    if (vetting >= 4) return refuseSpawn(m.req, "capacity");
    vetting++;
    const ch = control;
    void vetPushRemote(cfg, clock, m.repo, m.remote, m.pushUrls, p.readEnv, vetChildren)
      .catch(() => "spawn_failed" as const)
      .then((verdict) => {
        vetting--;
        if (disposed || control === undefined || control !== ch) return;
        if (verdict !== true) return refuseSpawn(m.req, verdict);
        startTerminal(m.req, p.argv, p.cwd, p.env, m.cols, m.rows);
      });
  };

  const startTerminal = (req: string, argv: readonly string[], cwd: string, env: Readonly<Record<string, string>>, cols: number, rows: number, endpoint?: string): void => {
    reap();
    if (terminals.size >= max) return refuseSpawn(req, "capacity");
    let child: PtyChild;
    try {
      child = options.spawn({ argv, cwd, env, cols, rows });
    } catch {
      return refuseSpawn(req, "spawn_failed");
    }
    const g = child.group;
    if (g.kind === "pgid" && (!validPgid(g.pgid) || g.pgid !== child.pid)) {
      // Not the leader of its own group: signalling `-pgid` would hit someone else's processes. Stop the leader only.
      try {
        child.kill("SIGKILL");
      } catch {
        /* nothing more can be done */
      }
      return refuseSpawn(req, "bad_group");
    }
    let idText = "";
    do idText = "pty_" + Buffer.from(rand(16)).toString("hex");
    while (terminals.has(idText));
    const t: Terminal = { id: idText, child, filter: new OscCwdFilter(), resync: true, cancel: false, seen: false, inputBlocked: false, flow: new OutputFlow(options.flow ?? DEFAULT_FLOW), subs: [], granted: undefined, owner: undefined, exited: false, revoked: false, groupGone: false, ...(endpoint === undefined ? {} : { endpoint }) };
    terminals.set(t.id, t);
    t.subs.push(
      child.onData((chunk) => {
        // The drop decision comes BEFORE the OSC filter: the filter is only right if the viewer parser sees the same subsequence.
        if (t.owner === undefined) return void (t.resync = true, t.cancel = t.cancel || t.seen);
        const verdict = t.flow.offer(chunk.length);
        if (verdict.pause) tryChild(t.child.pause?.bind(t.child));
        if (!verdict.send) return void (t.resync = true, t.cancel = true);
        let out = "";
        if (t.resync) {
          t.filter = new OscCwdFilter();
          t.resync = false;
          if (t.cancel) out = "\x18"; // CAN: the viewer parser abandons any sequence a missed chunk left open
          t.cancel = false;
        }
        out += t.filter.push(chunk);
        t.flow.refund(chunk.length - out.length);
        if (out !== "") sendTo(t.owner, { t: "data", term: t.id, chunk: out });
      }),
      child.onExit((exit) => {
        t.exited = true;
        if (t.endpoint !== undefined) endpoints?.close(t.endpoint); // the run ended: its endpoint goes with it
        sendTo(control, { t: "exit", term: t.id, exitCode: exit.exitCode, signal: exit.signal });
        revoke(t); // the leader's exit ends access even while a child of its group survives
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
    if (!sendTo(control, { t: "spawned", req, term: t.id, group: g.kind === "pgid" ? { kind: "pgid", pgid: g.pgid } : { kind: "job" } })) discard(t);
  };

  const onControl = (channel: Channel, raw: unknown): void => {
    if (control !== channel) return; // closed: a message that was already queued must not start anything
    // PV-D2: `forge-list` has its own shared schema (@axis/protocol) and reply family; it never reaches the union below.
    if (typeof raw === "object" && raw !== null && (raw as { t?: unknown }).t === "forge-list") {
      if (forge !== undefined && !disposed) return forge.handle(raw);
      const req = forgeRequestId(raw); // no usable req: nothing to answer
      return void (req === undefined || sendTo(control, { t: "forge-failed", req, code: "spawn_missing" }));
    }
    const relay = relayOutbound.safeParse(raw); // PV-M6: the daemon's answers for the endpoint relay
    if (relay.success) return void endpoints?.onRelay(relay.data);
    const parsed = controlRequest.safeParse(raw);
    if (!parsed.success) {
      const req = typeof raw === "object" && raw !== null && typeof (raw as { req?: unknown }).req === "string" ? (raw as { req: string }).req : undefined;
      if (req === undefined || req.length === 0 || req.length > 128) return;
      // A malformed request must not leave the daemon waiting for its bound: answer in the family it was sent in.
      const t = (raw as { t?: unknown }).t;
      if (t === "exec") return void sendTo(control, { t: "exec-failed", req, code: "bad_argv" });
      if (t === "scratch-begin" || t === "scratch-verify" || t === "scratch-end") return void sendTo(control, { t: "scratch-failed", req, code: "bad_bind" });
      // A push whose remote or refspec is not the closed form (a force, another ref, an option) is refused as a bad argv.
      if (t === "push") return refuseSpawn(req, "bad_argv");
      return refuseSpawn(req, "spawn_failed");
    }
    const m = parsed.data;
    if (m.t === "spawn") return handleSpawn(m);
    if (m.t === "hook") return handleHook(m);
    if (m.t === "push") return handlePush(m);
    if (m.t === "exec" || m.t === "scratch-begin" || m.t === "scratch-verify" || m.t === "scratch-end") {
      if (disposed || git === undefined) {
        if (m.t === "exec") return void sendTo(control, { t: "exec-failed", req: m.req, code: "spawn_failed" });
        return void sendTo(control, { t: "scratch-failed", req: m.req, code: "spawn_failed" });
      }
      return git.handle(m);
    }
    const t = terminals.get(m.term);
    if (t === undefined) return; // already reaped: the group is gone
    if (m.t === "revoke") return revoke(t);
    if (m.t === "grant") {
      if (t.revoked) return; // monotonic: an ended terminal is never granted again
      if (t.owner !== undefined && dataChannels.get(t.owner) !== m.conn) {
        t.owner = undefined; // re-granted to another connection
        releaseFlow(t);
      }
      t.granted = m.conn;
      return;
    }
    try {
      if (m.t === "kill") killTerminal(t, m.signal);
      else if (m.t === "resize") t.child.resize(m.cols, m.rows);
      else if (!t.exited) {
        if (inputFull(t)) sendTo(control, { t: "input-refused", term: t.id });
        else t.child.write(m.data);
      }
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
      if (t.owner !== channel) {
        releaseFlow(t);
        t.resync = true;
        t.cancel = t.seen;
      }
      t.owner = channel;
      t.seen = true;
      sendTo(channel, { t: "attached", term: t.id });
      return;
    }
    if (t.owner !== channel) return refuse();
    if (m.t === "ack") {
      const r = t.flow.ack(m.chars);
      if (r.resume) tryChild(t.child.resume?.bind(t.child));
      if (r.overflow > 0) sendTo(channel, { t: "overflow", term: t.id, chars: r.overflow });
      return;
    }
    try {
      if (m.t === "resize") t.child.resize(m.cols, m.rows);
      else if (!t.exited) {
        if (inputFull(t)) sendTo(channel, { t: "refused", term: t.id, code: "input_full" });
        else t.child.write(m.data);
      }
    } catch {
      /* a dying child */
    }
  };

  const closeChannel = (channel: Channel): void => {
    const conn = dataChannels.get(channel);
    for (const t of terminals.values()) {
      if (t.owner === channel) {
        t.owner = undefined;
        releaseFlow(t);
      }
      if (conn !== undefined && t.granted === conn) t.granted = undefined; // the grant dies with the connection: only a new grant lets one attach
    }
    dataChannels.delete(channel);
    // A closed channel holds nothing: its listeners go, so a port opened and closed per view is not kept for the process lifetime.
    for (const d of channelSubs.get(channel) ?? []) d.dispose();
    channelSubs.delete(channel);
    if (control === channel) {
      control = undefined;
      // Nobody can signal these any more and no run row will ever name them: closing the control channel ends every terminal,
      // every exec and every scratch attempt.
      for (const t of [...terminals.values()]) discard(t);
      endpoints?.closeAll();
      git?.closeAll();
      forge?.closeAll();
      killVets();
    }
  };

  return {
    serveControl(channel) {
      if (disposed) {
        try {
          channel.close();
        } catch {
          /* already closed */
        }
        return { dispose: () => undefined };
      }
      // Latest wins (OS-3h, own-shell-main-seam.md §3a): only main can hand this process a control port, so a newer one is main's
      // own replacement. The old channel is retired first, exactly as if it had closed: every terminal, exec and scratch attempt on
      // it ends (the daemon that owned them is gone or starts with an empty registry, so a surviving shell would have no owner).
      const old = control;
      if (old !== undefined) {
        closeChannel(old);
        try {
          old.close();
        } catch {
          /* already closed */
        }
      }
      control = channel;
      const subs = [channel.onMessage((m) => onControl(channel, m)), channel.onClose(() => closeChannel(channel))];
      channelSubs.set(channel, subs);
      return { dispose: () => void (subs.forEach((s) => s.dispose()), closeChannel(channel)) };
    },
    serveData(channel, conn) {
      // A name is served once for the life of the service: a `grant` that lands after its view closed cannot be claimed by a later port.
      if (disposed || usedNames.has(conn) || usedNames.size >= maxNames) {
        try {
          channel.close();
        } catch {
          /* already closed */
        }
        return { dispose: () => undefined };
      }
      usedNames.add(conn);
      dataChannels.set(channel, conn);
      const subs = [channel.onMessage((m) => onData(channel, m)), channel.onClose(() => closeChannel(channel))];
      channelSubs.set(channel, subs);
      return { dispose: () => void (subs.forEach((s) => s.dispose()), closeChannel(channel)) };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const t of terminals.values()) killTerminal(t, "SIGKILL");
      for (const t of terminals.values()) t.subs.forEach((d) => d.dispose());
      endpoints?.closeAll();
      git?.closeAll();
      forge?.closeAll();
      killVets();
      terminals.clear();
      for (const subs of channelSubs.values()) subs.forEach((d) => d.dispose());
      channelSubs.clear();
      usedNames.clear();
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
