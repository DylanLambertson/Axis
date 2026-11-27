// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-M7 slice 2, part 2: the production pty entry configures the CLI endpoint listener on Unix (the runtime directory, the
// platform and this process's uid), so a spawn the daemon minted an endpoint for gets its socket. Nothing is created until the
// daemon asks for one endpoint (while the user's switch is off it never does); Windows configures none.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { adaptMessagePort, createPtyProcessPort, defaultEndpointDir, PtySpawnError, runPtyEntry, type MessagePortLike, type PtyEntryDeps } from "../src/index.js";
import { pipeSpawn } from "../testing/helpers.js";
import { electronShaped, nodePair, nodeShaped } from "../testing/ports.js";

const SKIP = process.platform === "win32" ? "Unix sockets and process groups" : false;
type ParentListener = (event: { data: unknown; ports?: readonly MessagePortLike[] }) => void;
const EP = `ep_${"A".repeat(43)}`;
const TOKEN = "T".repeat(43);

function start(t: TestContext, runtime: string, over: Partial<PtyEntryDeps> = {}) {
  let listener: ParentListener | undefined;
  const exits: number[] = [];
  const children: number[] = [];
  const entry = runPtyEntry({
    parentPort: { on: (_e, l) => void (listener = l), removeListener: () => void (listener = undefined) },
    process: { exit: (c) => void exits.push(c ?? 0), on: () => undefined, removeListener: () => undefined },
    env: { PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: runtime },
    execArgv: [],
    spawn: pipeSpawn(children),
    platform: "linux",
    stderr: () => undefined,
    ...over,
  });
  t.after(() => entry.dispose());
  const pair = nodePair();
  listener?.({ data: { type: "pty-control" }, ports: [electronShaped(pair.b)] });
  const port = createPtyProcessPort({ channel: adaptMessagePort(nodeShaped(pair.a), { shape: "node" }) });
  t.after(() => port.dispose());
  return { exits, port, children };
}
function runtimeDir(t: TestContext): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "axis-entry-ep-")));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
const spec = (cwd: string) => ({ runId: "run1", argv: ["/bin/sleep", "5"], cwd, env: { PATH: "/usr/bin:/bin" }, cols: 80, rows: 24 });

test("Unix: a spawn with a minted endpoint gets its socket in the runtime directory, owner-only; the run's environment names it", { skip: SKIP }, async (t) => {
  const runtime = runtimeDir(t);
  const s = start(t, runtime);
  assert.deepEqual(s.exits, []);
  assert.deepEqual(readdirSync(runtime), [], "nothing is created at start: the listener opens only when the daemon asks");
  const handle = await s.port.spawn({ ...spec(runtime), messagesEndpoint: { endpoint: EP, token: TOKEN } });
  const dir = defaultEndpointDir({ XDG_RUNTIME_DIR: runtime }, "linux", process.getuid?.() ?? -1) as string;
  assert.equal(dir, join(runtime, "axis"));
  const st = lstatSync(dir);
  assert.equal(st.isDirectory(), true);
  assert.equal(st.mode & 0o777, 0o700, "owner-only");
  assert.equal(st.uid, process.getuid?.());
  assert.equal(readdirSync(dir).length, 1, "one socket, for the one endpoint");
  assert.ok(existsSync(join(dir, readdirSync(dir)[0] as string)));
  handle.kill("SIGKILL");
});

test("Unix: a spawn without an endpoint creates nothing (the user's switch off: the daemon never asks)", { skip: SKIP }, async (t) => {
  const runtime = runtimeDir(t);
  const s = start(t, runtime);
  const handle = await s.port.spawn(spec(runtime));
  assert.deepEqual(readdirSync(runtime), []);
  handle.kill("SIGKILL");
});

test("Windows: no listener is configured, so a spawn asking for an endpoint is refused endpoint_unavailable", { skip: SKIP }, async (t) => {
  const runtime = runtimeDir(t);
  const s = start(t, runtime, { platform: "win32" });
  // Windows-shaped paths pass the absolute-path check; the refusal comes before anything is started.
  const win = { ...spec(runtime), argv: ["C:\\tools\\cli.exe"], cwd: "C:\\work" };
  await assert.rejects(s.port.spawn({ ...win, messagesEndpoint: { endpoint: EP, token: TOKEN } }), (e: unknown) => e instanceof PtySpawnError && e.code === "endpoint_unavailable");
  assert.deepEqual(s.children, [], "nothing was started");
  assert.deepEqual(readdirSync(runtime), []);
});
