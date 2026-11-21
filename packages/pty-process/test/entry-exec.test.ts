// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-X1a: the pty entry's exec configuration (`AXIS_PTY_GIT`, `AXIS_PTY_GH`, `AXIS_PTY_SCRATCH`): a wrong value refuses the start
// before any port is served; none leaves git off and terminals on; a good one runs git through the production exec function.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { adaptMessagePort, createPtyProcessPort, PtyExecError, readPtyExecConfig, runPtyEntry, type MessagePortLike, type PtyEntryDeps } from "../src/index.js";
import { findGit } from "../testing/exec.js";
import { pipeSpawn } from "../testing/helpers.js";
import { electronShaped, nodePair, nodeShaped } from "../testing/ports.js";

const GIT = findGit();
const SKIP = process.platform === "win32" ? "POSIX" : GIT === undefined ? "git not found" : false;
type ParentListener = (event: { data: unknown; ports?: readonly MessagePortLike[] }) => void;

function dirs(t: TestContext): { root: string; scratch: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "axis-entry-exec-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scratch = join(root, "scratch");
  mkdirSync(scratch, { mode: 0o700 });
  chmodSync(scratch, 0o700);
  return { root, scratch };
}

function start(env: Record<string, string>, over: Partial<PtyEntryDeps> = {}) {
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
  const control = (): ReturnType<typeof createPtyProcessPort> => {
    const pair = nodePair();
    listener?.({ data: { type: "pty-control" }, ports: [electronShaped(pair.b)] });
    return createPtyProcessPort({ channel: adaptMessagePort(nodeShaped(pair.a), { shape: "node" }) });
  };
  return { entry, exits, lines, control, listening: () => listener !== undefined };
}

test("a wrong hand-over value refuses the start before any port is served, with one closed line", { skip: SKIP }, (t) => {
  const { root, scratch } = dirs(t);
  const plain = join(root, "plain");
  writeFileSync(plain, "x");
  chmodSync(plain, 0o644);
  const open = join(root, "open");
  mkdirSync(open, { mode: 0o755 });
  chmodSync(open, 0o755);
  const link = join(root, "link");
  symlinkSync(scratch, link);
  const git = GIT as string;
  const cases: Array<[Record<string, string>, string]> = [
    [{ AXIS_PTY_GIT: "git", AXIS_PTY_SCRATCH: scratch }, "git_path_refused"],
    [{ AXIS_PTY_GIT: plain, AXIS_PTY_SCRATCH: scratch }, "git_path_refused"],
    [{ AXIS_PTY_GIT: root, AXIS_PTY_SCRATCH: scratch }, "git_path_refused"],
    [{ AXIS_PTY_GIT: join(root, "missing"), AXIS_PTY_SCRATCH: scratch }, "git_path_refused"],
    [{ AXIS_PTY_GIT: git, AXIS_PTY_GH: "gh", AXIS_PTY_SCRATCH: scratch }, "gh_path_refused"],
    [{ AXIS_PTY_GIT: git }, "scratch_refused"],
    [{ AXIS_PTY_GIT: git, AXIS_PTY_SCRATCH: join(root, "none") }, "scratch_refused"],
    [{ AXIS_PTY_GIT: git, AXIS_PTY_SCRATCH: open }, "scratch_refused"],
    [{ AXIS_PTY_GIT: git, AXIS_PTY_SCRATCH: link }, "scratch_refused"],
    [{ AXIS_PTY_GIT: git, AXIS_PTY_SCRATCH: plain }, "scratch_refused"],
    [{ AXIS_PTY_GIT: git, AXIS_PTY_SCRATCH: "scratch" }, "scratch_refused"],
  ];
  for (const [env, reason] of cases) {
    const s = start(env);
    assert.deepEqual(s.exits, [78], JSON.stringify(env));
    assert.deepEqual(s.lines, [`axis.pty refused to start: ${reason}`], JSON.stringify(env));
    assert.equal(s.listening(), false, "no port is served");
    assert.equal(s.lines.join("").includes(root), false, "no path in the line");
  }
  // The same values are good: no refusal.
  assert.deepEqual(readPtyExecConfig({ AXIS_PTY_GIT: git, AXIS_PTY_SCRATCH: scratch }), { gitPath: git, scratchParent: scratch });
  assert.deepEqual(readPtyExecConfig({}), {});
});

test("without a git hand-over terminals work and every exec is refused; Windows ignores the hand-over", { skip: SKIP }, async (t) => {
  const { scratch } = dirs(t);
  const s = start({});
  t.after(() => s.entry.dispose());
  assert.deepEqual(s.exits, []);
  const port = s.control();
  t.after(() => port.dispose());
  await assert.rejects(port.exec({ argv: [GIT as string, "write-tree"], cwd: scratch, env: {}, timeoutMs: 5000, maxOutput: 4096, repo: { gitDir: join(scratch, ".git"), workTree: scratch } }), (e: unknown) => e instanceof PtyExecError && e.code === "spawn_failed");
  const win = start({ AXIS_PTY_GIT: "relative-is-ignored" }, { platform: "win32" });
  t.after(() => win.entry.dispose());
  assert.deepEqual(win.exits, [], "not read on Windows");
});

test("with the hand-over, git runs through the production exec function and only the configured git", { skip: SKIP }, async (t) => {
  const { root, scratch } = dirs(t);
  const repo = join(root, "repo");
  execFileSync(GIT as string, ["init", "-q", repo]);
  const env = { PATH: "/usr/bin:/bin", HOME: root, AXIS_PTY_GIT: GIT as string, AXIS_PTY_SCRATCH: scratch, AXIS_CANARY: "x" };
  const s = start(env);
  t.after(() => s.entry.dispose());
  assert.deepEqual(s.exits, [], s.lines.join("\n"));
  const port = s.control();
  t.after(() => port.dispose());
  const r = await port.exec({ argv: [GIT as string, "write-tree"], cwd: repo, env: {}, timeoutMs: 10_000, maxOutput: 4096, repo: { gitDir: join(repo, ".git"), workTree: repo } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n");
  // Another program is refused inside the exec function (one instance per consumer); the service already refuses it first.
  await assert.rejects(port.exec({ argv: ["/bin/sh", "write-tree"], cwd: repo, env: {}, timeoutMs: 5000, maxOutput: 4096, repo: { gitDir: join(repo, ".git"), workTree: repo } }), (e: unknown) => e instanceof PtyExecError);
});
