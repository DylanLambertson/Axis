// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { composerRunsMethods } from "@axis/protocol";
import type { ValidRequest } from "@axis/providers";
import { START } from "./composer-rig.js";
import { ComposerRunHalt } from "../src/index.js";
import { NODE, answerPending, approveCommand, approvalsOf, command, commandRig, eventually, fakeSnapshotter, nodeRun, nodeScript, pending, posix, toolsOf } from "./composer-command-rig.js";

// Ticket C3: `run_command` through the composer (PTY-2, PTY-4, command identity on the approval and the native line).

const TEXT = { kind: "text", text: "done" } as const;
const ended = (c: { service: { get(id: string): { live: boolean } } }, runId: string) => () => !c.service.get(runId).live;
/** What the model got back as tool results, per provider request. */
function resultsSeen(): { seen: string[][]; onRequest: (n: number, req: ValidRequest) => void } {
  const seen: string[][] = [];
  return {
    seen,
    onRequest: (_n, req) => {
      const last = req.messages[req.messages.length - 1];
      const blocks = (Array.isArray(last?.content) ? last.content : []) as { type: string; content?: unknown }[];
      seen.push(blocks.flatMap((b) => (b.type === "tool_result" ? [String(b.content)] : [])));
    },
  };
}

test("C3: an approved command shows its whole line, real program and identity on the card and the native line; what runs is that line", async (t) => {
  const snap = fakeSnapshotter();
  const r = resultsSeen();
  const c = await commandRig(t, { replies: [nodeRun("process.stdout.write(process.argv[1] + '<b>')", "a b"), TEXT], commandSnapshotter: snap, onRequest: r.onRequest });
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  const { challenge, sent } = await approveCommand(c, run.runId);
  await eventually(ended(c, run.runId));
  assert.equal(c.service.get(run.runId).state, "REVIEWING");
  const [requested] = approvalsOf(c, run.runId);
  assert.ok(composerRunsMethods.events.response.safeParse(c.service.events(run.runId, 0, 200)).success, "the events reply passes the contract");
  const cmd = requested?.preview?.command;
  assert.ok(cmd, "the card shows the command");
  assert.equal(requested?.digest, challenge.digest);
  assert.deepEqual(cmd.argv, [NODE.replace(/\\/g, "\\\\"), "-e", "process.stdout.write(process.argv[1] + '<b>')", "a b"]);
  assert.equal(cmd.program, NODE.replace(/\\/g, "\\\\"));
  assert.deepEqual([cmd.interpreter, cmd.cwd, requested?.preview?.tier, requested?.preview?.content], [null, ".", "privileged", null]);
  const identity = createHash("sha256").update(JSON.stringify([NODE, null, [NODE, "-e", "process.stdout.write(process.argv[1] + '<b>')", "a b"], "."])).digest("hex");
  assert.equal(cmd.identity, identity);
  const base = NODE.split(/[\\/]/).pop() as string;
  assert.equal(sent["summary"], `axis.runs/1.toolCall: run_command (privileged), program ${base}, identity ${identity.slice(0, 16)}`);
  // The model got the output escaped inside the untrusted block (`<` cannot close it).
  const out = r.seen[1]?.[0] ?? "";
  assert.match(out, /^exit: 0, ended: exit\n/);
  assert.ok(out.includes('<axis-command-output stream="stdout" content="untrusted">\na b\\u{3c}b\\u{3e}\n</axis-command-output>'), out);
  assert.deepEqual(snap.calls, [`before:${run.runId}.command.1`, `after:${run.runId}.command.1`], "WT-2: one snapshot before and one after");
  const rows = c.audit.verify();
  assert.equal(rows.ok, true);
});

test("C3 PTY-2: the child sees only the allow-list, whatever the host environment holds", async (t) => {
  const r = resultsSeen();
  const c = await commandRig(t, {
    replies: [nodeRun("process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))"), TEXT],
    commandSnapshotter: fakeSnapshotter(),
    onRequest: r.onRequest,
    env: ({ base }) => ({
      PATH: "/usr/bin:/bin", HOME: base, LANG: "C", TERM: "dumb",
      AXIS_DAEMON_SECRET: "x", SERVICE_TOKEN: "x", VSCODE_IPC_HOOK_CLI: "/tmp/x", ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "--require /nonexistent/axis-injected.js", LD_PRELOAD: "/nonexistent/axis.so", GIT_DIR: "/tmp/elsewhere", SSH_AUTH_SOCK: "/tmp/agent",
    }),
  });
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await approveCommand(c, run.runId);
  await eventually(ended(c, run.runId));
  const out = r.seen[1]?.[0] ?? "";
  assert.match(out, /^exit: 0, ended: exit\n/, out);
  const keys = JSON.parse(/stream="stdout" content="untrusted">\n(.*)\n<\/axis-command-output>/.exec(out)?.[1] ?? "null") as string[];
  assert.deepEqual(keys.filter((k) => !["PATH", "HOME", "LANG", "TERM"].includes(k)), [], "nothing but the allow-list reaches the child");
  assert.ok(keys.includes("HOME") && keys.includes("PATH"));
});

test("C3: the model cannot name an environment, a shell string or a working directory outside the tree (refused before any approval)", async (t) => {
  const c = await commandRig(t, {
    replies: [
      command([NODE, "-v"], { env: { NODE_OPTIONS: "--require x" } }),
      { kind: "tool_use", name: "run_command", input: { argv: `${NODE} -v` } },
      command([NODE, "-v"], { cwd: "../outside" }),
      command([NODE, "-v"], { cwd: "/" }),
      command(["./bin/tool"]),
      command([""]),
      TEXT,
    ],
    commandSnapshotter: fakeSnapshotter(),
  });
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await eventually(ended(c, run.runId));
  assert.deepEqual(toolsOf(c, run.runId).map((e) => e.reason), Array(6).fill("invalid_args"));
  assert.deepEqual(approvalsOf(c, run.runId), [], "nothing was put to the user");
});

test("C3: a name planted on PATH inside the worktree, or on an empty or relative entry, is never found; an outside entry is pinned by real path", { skip: !posix }, async (t) => {
  const c = await commandRig(t, {
    script: () => [command(["axis-planted"]), command(["axis-tool"]), TEXT],
    commandSnapshotter: fakeSnapshotter(),
    env: ({ root, outside, base }) => ({ PATH: `${join(root, "bin")}::.:bin:${join(outside, "bin")}`, HOME: base }),
  });
  mkdirSync(join(c.root, "bin"));
  mkdirSync(join(c.outside, "bin"));
  const marker = join(c.outside, "planted-ran");
  if (!nodeScript(join(c.root, "bin", "axis-planted"), `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`)) return t.skip("no #! scripts here");
  nodeScript(join(c.root, "axis-planted"), `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`);
  nodeScript(join(c.root, "bin", "axis-tool"), `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`);
  nodeScript(join(c.outside, "bin", "axis-tool"), `process.stdout.write("outside tool")`);
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await approveCommand(c, run.runId);
  await eventually(ended(c, run.runId));
  assert.equal(toolsOf(c, run.runId)[0]?.reason, "unresolved_command", "a planted name is refused before any approval");
  const [requested] = approvalsOf(c, run.runId);
  assert.equal(requested?.preview?.command?.program, join(c.outside, "bin", "axis-tool"), "the outside entry, by its real path");
  assert.equal(requested?.preview?.command?.interpreter, NODE, "the #! interpreter is pinned and shown");
  assert.equal(toolsOf(c, run.runId)[1]?.outcome, "ok");
  assert.equal(existsSync(marker), false, "no planted program ever ran");
});

test("C3: a program swapped after the approval was asked is refused at run time (program_changed); nothing runs", { skip: !posix }, async (t) => {
  const c = await commandRig(t, { script: ({ outside }) => [command([join(outside, "prog")]), TEXT], commandSnapshotter: fakeSnapshotter() });
  const marker = join(c.outside, "swapped-ran");
  if (!nodeScript(join(c.outside, "prog"), `process.stdout.write("approved")`)) return t.skip("no #! scripts here");
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await eventually(() => c.service.get(run.runId).awaitingApproval);
  // Same name, other file: renamed over the approved one while the user looks at the card.
  nodeScript(join(c.outside, "prog.new"), `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`);
  renameSync(join(c.outside, "prog.new"), join(c.outside, "prog"));
  await approveCommand(c, run.runId);
  await eventually(ended(c, run.runId));
  assert.equal(toolsOf(c, run.runId)[0]?.reason, "program_changed");
  assert.equal(existsSync(marker), false);
});

test("C3: a working directory that is a symlink out of the tree is refused at run time; nothing runs", { skip: !posix }, async (t) => {
  const marker = "cwd-ran";
  const c = await commandRig(t, { replies: [command([NODE, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`], { cwd: "out" }), TEXT], commandSnapshotter: fakeSnapshotter() });
  symlinkSync(c.outside, join(c.root, "out"), "dir");
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await approveCommand(c, run.runId);
  await eventually(ended(c, run.runId));
  assert.equal(toolsOf(c, run.runId)[0]?.outcome, "error");
  assert.equal(existsSync(join(c.outside, marker)), false, "the command did not run outside the tree");
});

test("C3 PTY-4: output over the cap stops the command; the model gets a bounded, escaped head", async (t) => {
  const r = resultsSeen();
  const c = await commandRig(t, {
    replies: [nodeRun("const b = Buffer.alloc(65536, 0x41); for (let i = 0; i < 64; i++) process.stdout.write(b); process.stdout.write('\\u0007\\u202e')"), TEXT],
    commandSnapshotter: fakeSnapshotter(),
    commandLimits: { maxOutputBytes: 8192, modelChars: 1000 },
    onRequest: r.onRequest,
  });
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await approveCommand(c, run.runId);
  await eventually(ended(c, run.runId));
  const out = r.seen[1]?.[0] ?? "";
  assert.match(out, /ended: output-cap \(output over the cap; the command was stopped\)/);
  assert.ok(out.includes('stream="stdout" content="untrusted" cut="true"'));
  assert.ok(out.length < 1600, `bounded: ${out.length}`);
});

test("C3 PTY-4: a command past its timeout is killed with its process group", { skip: !posix }, async (t) => {
  const r = resultsSeen();
  const pidFile = "grandchild.pid";
  const code = `const { spawn } = require("child_process"); const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); setInterval(() => {}, 1000);`;
  const c = await commandRig(t, { replies: [nodeRun(code), TEXT], commandSnapshotter: fakeSnapshotter(), commandLimits: { timeoutMs: 1500 }, onRequest: r.onRequest });
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await approveCommand(c, run.runId);
  await eventually(ended(c, run.runId));
  assert.match(r.seen[1]?.[0] ?? "", /^exit: none, ended: timeout\n/);
  const pid = Number(readFileSync(join(c.root, pidFile), "utf8"));
  const alive = (): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  await eventually(() => !alive(), 500);
});

test("C3 WT-2: drift after a command, or a check that cannot judge, halts the run (GIT_DRIFT); a later call never runs", async (t) => {
  for (const verdict of [() => true, () => "throw" as const]) {
    const marker = "second-ran";
    const c = await commandRig(t, { replies: [nodeRun("1"), nodeRun(`require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`), TEXT], commandSnapshotter: fakeSnapshotter({ verdict }) });
    const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
    await approveCommand(c, run.runId);
    await eventually(ended(c, run.runId));
    assert.deepEqual([c.service.get(run.runId).state, c.service.get(run.runId).reason], ["FAILED", "GIT_DRIFT"]);
    assert.equal(existsSync(join(c.root, marker)), false);
    assert.equal(c.wire(), 1, "the run halts at the drifting call: the model is never asked again");
    assert.deepEqual(toolsOf(c, run.runId), [], "and the drifting call reports nothing back");
    assert.equal(approvalsOf(c, run.runId).filter((e) => e.state === "requested").length, 1);
  }
});

test("C3 WT-2: no baseline before the command refuses the call with nothing started; the run goes on", async (t) => {
  const marker = "ran";
  const c = await commandRig(t, { replies: [nodeRun(`require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`), TEXT], commandSnapshotter: fakeSnapshotter({ failBefore: true }) });
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await approveCommand(c, run.runId);
  await eventually(ended(c, run.runId));
  assert.equal(toolsOf(c, run.runId)[0]?.reason, "git_drift");
  assert.equal(c.service.get(run.runId).state, "REVIEWING");
  assert.equal(existsSync(join(c.root, marker)), false);
});

test("C3: without the WT-2 snapshotter run_command is not offered and a call to it is refused", async (t) => {
  const c = await commandRig(t, { replies: [nodeRun("1"), TEXT] });
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await eventually(ended(c, run.runId));
  assert.equal(toolsOf(c, run.runId)[0]?.reason, "unknown_tool");
  assert.deepEqual(await pending(c), []);
});

test("C3: a dialog cancel declines the command; nothing runs", async (t) => {
  const marker = "declined-ran";
  const c = await commandRig(t, { replies: [nodeRun(`require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`), TEXT], commandSnapshotter: fakeSnapshotter() });
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await approveCommand(c, run.runId, false);
  await eventually(ended(c, run.runId));
  assert.equal(toolsOf(c, run.runId)[0]?.reason, "approval_declined");
  assert.equal(existsSync(join(c.root, marker)), false);
});

test("C3 WT-2: once a command drifted, the call halts the run and every later call of the run halts it too", async (t) => {
  const c = await commandRig(t, { commandSnapshotter: fakeSnapshotter({ verdict: () => true }) });
  const tools = (await c.agent.prepare(c.workspaceId))({ runId: "run-direct", workspaceId: c.workspaceId, windowId: "win-1", mode: "agent", onApproval: () => undefined });
  const signal = new AbortController().signal;
  const first = tools.invoke("run_command", { argv: [NODE, "-e", "1"] }, signal);
  await answerPending(c);
  const halt = (e: unknown): boolean => e instanceof ComposerRunHalt && e.reason === "GIT_DRIFT";
  await assert.rejects(first, halt);
  const brokerRows = (): number => c.audit.list({ limit: 200 }).filter((e) => e.action.startsWith("broker.")).length;
  const before = brokerRows();
  await assert.rejects(tools.invoke("read_file", { path: "x" }, signal), halt);
  assert.equal(brokerRows(), before, "nothing else of the run reaches the broker");
  assert.equal(c.audit.verify().ok, true);
});
