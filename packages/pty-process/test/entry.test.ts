// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptMessagePort, createPtyProcessPort, runPtyEntry, type DataReply, type MessagePortLike, type PtyEntryDeps, type PtyEntryHandle } from "../src/index.js";
import { pipeSpawn, settle, until } from "../testing/helpers.js";
import { electronShaped, nodePair, nodeShaped, RecordingPort } from "../testing/ports.js";
import { SPEC } from "../testing/rig.js";

type ParentListener = (event: { data: unknown; ports?: readonly MessagePortLike[] }) => void;

/** TEST ONLY. The utility process's `parentPort`, `process` and a log, driven by hand. */
function harness(over: Partial<PtyEntryDeps> = {}): { entry: PtyEntryHandle; send: (data: unknown, ports?: readonly MessagePortLike[]) => void; exits: number[]; lines: string[]; listeners: () => number; emit: (e: "SIGTERM" | "exit") => void; children: number[] } {
  let listener: ParentListener | undefined;
  const procListeners = new Map<string, Set<() => void>>();
  const exits: number[] = [];
  const lines: string[] = [];
  const children: number[] = [];
  const entry = runPtyEntry({
    parentPort: { on: (_e, l) => void (listener = l), removeListener: () => void (listener = undefined) },
    process: {
      exit: (c) => void exits.push(c ?? 0),
      on: (e, l) => void (procListeners.get(e) ?? procListeners.set(e, new Set()).get(e)!).add(l),
      removeListener: (e, l) => void procListeners.get(e)?.delete(l),
    },
    env: {},
    execArgv: [],
    spawn: pipeSpawn(children),
    stderr: (l) => void lines.push(l),
    ...over,
  });
  return {
    entry,
    send: (data, ports = []) => listener?.({ data, ports }),
    exits,
    lines,
    listeners: () => (listener === undefined ? 0 : 1) + [...procListeners.values()].reduce((n, s) => n + s.size, 0),
    emit: (e) => procListeners.get(e)?.forEach((l) => l()),
    children,
  };
}

const posix = process.platform === "win32" ? "POSIX process groups" : false;
const alive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
};

/** Brokers a control port and a data port the way main would, over real MessageChannels. */
async function wire(h: ReturnType<typeof harness>, conn = "c1"): Promise<{ host: ReturnType<typeof createPtyProcessPort>; data: ReturnType<typeof adaptMessagePort>; replies: DataReply[]; dataPeer: ReturnType<typeof nodePair> }> {
  const control = nodePair();
  h.send({ type: "pty-control" }, [electronShaped(control.b)]);
  const host = createPtyProcessPort({ channel: adaptMessagePort(nodeShaped(control.a), { shape: "node" }) });
  const dataPeer = nodePair();
  h.send({ type: "pty-data", conn }, [electronShaped(dataPeer.b)]);
  const data = adaptMessagePort(nodeShaped(dataPeer.a), { shape: "node" });
  const replies: DataReply[] = [];
  data.onMessage((m) => void replies.push(m as DataReply));
  return { host, data, replies, dataPeer };
}

test("a real child runs behind real MessagePorts: grant, attach, output arrives, input reaches the child", { skip: posix }, async () => {
  const h = harness();
  const { host, data, replies } = await wire(h);
  try {
    const t = await host.spawn({ ...SPEC, argv: ["/bin/sh", "-c", 'read line; echo "got:$line"; sleep 30'], cwd: "/", env: { PATH: "/usr/bin:/bin" } });
    host.grant(t.terminalId, "c1");
    await settle();
    data.send({ t: "attach", term: t.terminalId });
    await until(() => replies.some((r) => r.t === "attached"));
    data.send({ t: "write", term: t.terminalId, data: "hello\n" });
    await until(() => replies.some((r) => r.t === "data" && r.chunk.includes("got:hello")));
    assert.equal(t.groupAlive(), true);
  } finally {
    h.entry.dispose();
    host.dispose();
    data.close();
  }
});

test("G-2 over real ports: a connection named c2 cannot attach to a terminal granted to c1", { skip: posix }, async () => {
  const h = harness();
  const { host, data, replies } = await wire(h, "c2");
  try {
    const t = await host.spawn({ ...SPEC, argv: ["/bin/sh", "-c", "sleep 30"], cwd: "/", env: { PATH: "/usr/bin:/bin" } });
    host.grant(t.terminalId, "c1");
    await settle();
    data.send({ t: "attach", term: t.terminalId });
    await until(() => replies.length > 0);
    assert.deepEqual(replies, [{ t: "refused", term: null, code: "foreign_terminal" }]);
  } finally {
    h.entry.dispose();
    host.dispose();
    data.close();
  }
});

test("closing the control port kills the real child's whole group and discards the terminal", { skip: posix }, async () => {
  const h = harness();
  const { host, data } = await wire(h);
  await host.spawn({ ...SPEC, argv: ["/bin/sh", "-c", "sleep 30 & sleep 30"], cwd: "/", env: { PATH: "/usr/bin:/bin" } });
  const pgid = h.children[0] as number;
  assert.equal(alive(pgid), true);
  host.dispose(); // closes the host's end; the service's end sees `close`
  try {
    await until(() => !alive(pgid));
  } finally {
    h.entry.dispose();
    data.close();
    if (alive(pgid)) process.kill(-pgid, "SIGKILL");
  }
});

test("a data port is closed by the entry when its peer closes: the terminal's grant dies with it", { skip: posix }, async () => {
  const h = harness();
  const { host, data, replies, dataPeer } = await wire(h);
  try {
    const t = await host.spawn({ ...SPEC, argv: ["/bin/sh", "-c", "sleep 30"], cwd: "/", env: { PATH: "/usr/bin:/bin" } });
    host.grant(t.terminalId, "c1");
    await settle();
    data.send({ t: "attach", term: t.terminalId });
    await until(() => replies.some((r) => r.t === "attached"));
    data.close();
    await settle();
    // a new connection with the same name is not granted anything until a new grant
    const second = nodePair();
    h.send({ type: "pty-data", conn: "c1" }, [electronShaped(second.b)]);
    const again = adaptMessagePort(nodeShaped(second.a), { shape: "node" });
    const got: DataReply[] = [];
    again.onMessage((m) => void got.push(m as DataReply));
    again.send({ t: "attach", term: t.terminalId });
    await until(() => got.length > 0);
    assert.deepEqual(got, [{ t: "refused", term: null, code: "foreign_terminal" }]);
    again.close();
  } finally {
    void dataPeer;
    h.entry.dispose();
    host.dispose();
  }
});

test("dispose kills every terminal, closes every served port and removes every listener", { skip: posix }, async () => {
  const h = harness();
  const { host, data } = await wire(h);
  await host.spawn({ ...SPEC, argv: ["/bin/sh", "-c", "sleep 30"], cwd: "/", env: { PATH: "/usr/bin:/bin" } });
  const pgid = h.children[0] as number;
  assert.ok(h.listeners() > 0);
  h.entry.dispose();
  h.entry.dispose();
  try {
    await until(() => !alive(pgid));
    assert.equal(h.listeners(), 0);
  } finally {
    host.dispose();
    data.close();
    if (alive(pgid)) process.kill(-pgid, "SIGKILL");
  }
});

test("SIGTERM and process exit end every terminal; SIGTERM also exits 0", { skip: posix }, async () => {
  for (const signal of ["SIGTERM", "exit"] as const) {
    const h = harness();
    const { host, data } = await wire(h);
    await host.spawn({ ...SPEC, argv: ["/bin/sh", "-c", "sleep 30"], cwd: "/", env: { PATH: "/usr/bin:/bin" } });
    const pgid = h.children[0] as number;
    h.emit(signal);
    try {
      await until(() => !alive(pgid));
      assert.deepEqual(h.exits, signal === "SIGTERM" ? [0] : []);
    } finally {
      host.dispose();
      data.close();
      if (alive(pgid)) process.kill(-pgid, "SIGKILL");
    }
  }
});

test("every malformed hand-over is dropped and every port in it closed", () => {
  const h = harness();
  const mk = (): { port: RecordingPort; counters: { closed: number } } => ({ port: new RecordingPort(), counters: { closed: 0 } });
  const cases: Array<[unknown, number]> = [
    [{ type: "pty-control" }, 0], // no port
    [{ type: "pty-control" }, 2], // two ports
    [{ type: "pty-control", extra: 1 }, 1],
    [{ type: "pty-data" }, 1], // no conn
    [{ type: "pty-data", conn: "" }, 1],
    [{ type: "pty-data", conn: "x".repeat(129) }, 1],
    [{ type: "pty-data", conn: 5 }, 1],
    [{ type: "pty-data", conn: "c", extra: 1 }, 1],
    [{ type: "pty-data", conn: "c" }, 3],
    [{ type: "spawn", argv: ["/bin/sh"] }, 1],
    ["pty-control", 1],
    [null, 1],
  ];
  for (const [data, n] of cases) {
    const ports = Array.from({ length: n }, mk);
    h.send(data, ports.map((p) => p.port));
    assert.deepEqual(ports.map((p) => p.port.closes), ports.map(() => 1), JSON.stringify(data));
    assert.equal(ports.every((p) => p.port.message.size === 0), true, "no listener was attached to a refused port");
  }
  h.entry.dispose();
});

test("a second control port is closed by the service and the first keeps working", { skip: posix }, async () => {
  const h = harness();
  const { host, data } = await wire(h);
  try {
    const intruder = nodePair();
    let closed = false;
    intruder.a.on("close", () => void (closed = true));
    h.send({ type: "pty-control" }, [electronShaped(intruder.b)]);
    await until(() => closed);
    const t = await host.spawn({ ...SPEC, argv: ["/bin/sh", "-c", "sleep 30"], cwd: "/", env: { PATH: "/usr/bin:/bin" } });
    assert.equal(typeof t.terminalId, "string");
  } finally {
    h.entry.dispose();
    host.dispose();
    data.close();
  }
});

test("the entry refuses to start without a parent port, with debugger flags, exec args or NODE_OPTIONS (exit 78), and serves nothing", () => {
  const cases: Array<[Partial<PtyEntryDeps>, string]> = [
    [{ parentPort: undefined }, "not_utility_process"],
    [{ execArgv: ["--inspect=0"] }, "debug_flag_refused"],
    [{ execArgv: ["--remote-debugging-port=1"] }, "debug_flag_refused"],
    [{ execArgv: ["--require", "x.js"] }, "exec_args_refused"],
    [{ env: { NODE_OPTIONS: "--require x" } }, "node_options_refused"],
  ];
  for (const [over, reason] of cases) {
    const h = harness(over);
    assert.deepEqual(h.exits, [78], reason);
    assert.deepEqual(h.lines, [`axis.pty refused to start: ${reason}`]);
    assert.equal(h.entry.service, undefined);
    assert.equal(h.listeners(), 0);
  }
  assert.deepEqual(harness({ env: { NODE_OPTIONS: "" } }).exits, []);
});
