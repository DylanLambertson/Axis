// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-D2 slice 2: the pty entry's `forge-list` wiring. With `AXIS_PTY_GH` and `AXIS_PTY_SCRATCH` the gh runs through its own
// production exec function (`createNodeExec(new Set([ghPath]))`); gh without a scratch refuses the start; no gh is
// `spawn_missing`; Windows is `unsupported_platform` and creates nothing.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { adaptMessagePort, createPtyProcessPort, readPtyExecConfig, runPtyEntry, type MessagePortLike, type PtyEntryDeps } from "../src/index.js";
import { writeFakeGh } from "../testing/forge.js";
import { pipeSpawn } from "../testing/helpers.js";
import { electronShaped, nodePair, nodeShaped } from "../testing/ports.js";

const SKIP = process.platform === "win32" ? "POSIX shebang scripts and process groups" : false;
type ParentListener = (event: { data: unknown; ports?: readonly MessagePortLike[] }) => void;
const REQ = { t: "forge-list" as const, host: "github.com" as const, owner: "acme", repo: "app" };

function box(t: TestContext): { root: string; scratch: string; gh: string; log: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "axis-entry-forge-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scratch = join(root, "scratch");
  mkdirSync(scratch, { mode: 0o700 });
  chmodSync(scratch, 0o700);
  const bin = join(root, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const log = join(root, "gh.log");
  writeFileSync(log, "");
  const gh = writeFakeGh(bin, log, 'process.stdout.write("[]");');
  return { root, scratch, gh, log };
}

function start(t: TestContext, env: Record<string, string>, over: Partial<PtyEntryDeps> = {}) {
  let listener: ParentListener | undefined;
  const exits: number[] = [];
  const lines: string[] = [];
  const entry = runPtyEntry({
    parentPort: { on: (_e, l) => void (listener = l), removeListener: () => void (listener = undefined) },
    process: { exit: (c) => void exits.push(c ?? 0), on: () => undefined, removeListener: () => undefined },
    env,
    execArgv: [],
    spawn: pipeSpawn([]),
    stderr: (l) => void lines.push(l),
    ...over,
  });
  t.after(() => entry.dispose());
  const control = (): ReturnType<typeof createPtyProcessPort> => {
    const pair = nodePair();
    listener?.({ data: { type: "pty-control" }, ports: [electronShaped(pair.b)] });
    const port = createPtyProcessPort({ channel: adaptMessagePort(nodeShaped(pair.a), { shape: "node" }) });
    t.after(() => port.dispose());
    return port;
  };
  return { exits, lines, control };
}

test("with AXIS_PTY_GH and a scratch, forge-list runs that gh in a call directory under the scratch, through the production exec", { skip: SKIP }, async (t) => {
  const { root, scratch, gh, log } = box(t);
  const s = start(t, { PATH: "/usr/bin:/bin", HOME: root, AXIS_PTY_GH: gh, AXIS_PTY_SCRATCH: scratch, AXIS_CANARY: "x" });
  assert.deepEqual(s.exits, [], s.lines.join("\n"));
  const port = s.control();
  assert.deepEqual(await port.forgeList({ ...REQ, req: "e1" }), { t: "forge-result", req: "e1", exit: 0, class: "none", stdout: "[]", truncated: false });
  const runs = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; cwd: string });
  assert.deepEqual(runs.map((r) => r.args[0]), ["--version", "pr"]);
  assert.equal(dirname(dirname(runs[1]?.cwd as string)), join(scratch, "forge-calls"));
  assert.deepEqual(readPtyExecConfig({ AXIS_PTY_GH: gh, AXIS_PTY_SCRATCH: scratch }), { ghPath: gh, scratchParent: scratch });
});

test("gh without a scratch refuses the start before any port is served; no gh is spawn_missing", { skip: SKIP }, async (t) => {
  const { gh } = box(t);
  const refused = start(t, { AXIS_PTY_GH: gh });
  assert.deepEqual(refused.exits, [78]);
  assert.deepEqual(refused.lines, ["axis.pty refused to start: scratch_refused"]);
  const none = start(t, { PATH: "/usr/bin:/bin" });
  assert.deepEqual(none.exits, []);
  assert.deepEqual(await none.control().forgeList({ ...REQ, req: "e2" }), { t: "forge-failed", req: "e2", code: "spawn_missing" });
});

test("Windows: every forge-list is unsupported_platform, and nothing is created or run", { skip: SKIP }, async (t) => {
  const { scratch, gh, log } = box(t);
  const s = start(t, { AXIS_PTY_GH: gh, AXIS_PTY_SCRATCH: scratch }, { platform: "win32" });
  assert.deepEqual(s.exits, []);
  assert.deepEqual(await s.control().forgeList({ ...REQ, req: "e3" }), { t: "forge-failed", req: "e3", code: "unsupported_platform" });
  assert.deepEqual(readdirSync(scratch), []);
  assert.equal(readFileSync(log, "utf8"), "");
  assert.equal(existsSync(join(scratch, "forge-calls")), false);
});
