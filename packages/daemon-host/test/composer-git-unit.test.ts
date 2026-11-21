// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createNodeRunner } from "@axis/git-ops";
import type { MockReply } from "@axis/providers";
import { DEFAULT_GIT_READ_LIMITS, GIT_COMMANDS, GIT_READ_TIMEOUT_MS, MAX_GIT_OUTPUT, gitReadRunnerOptions, checkGitCall, escapeGitLine, gitCallTier, GIT_DIFF, GIT_STATUS, GIT_TOOL_SPECS, diffCall, formatDiff, formatStatus, gitDiffArgs, gitStatusArgs, statusCall } from "../src/index.js";
import { START } from "./composer-rig.js";
import { commandRig, eventually, fakeGuard, toolsOf } from "./composer-command-rig.js";

// C3 slice 2: `git_status` and `git_diff`, what the model is shown and the broker policy rows they run under.

const ok = (stdout: string, truncated = false) => ({ code: 0, stdout, stderr: "", ...(truncated ? { truncated: true } : {}) });
const same = (t: string): string => t;
const reason = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    const r = (e as { reason?: unknown } | null)?.reason;
    return typeof r === "string" ? r : "other";
  }
  return "no-error";
};
/** The lines inside the one untrusted block. */
const inside = (out: string): string[] => {
  const lines = out.split("\n");
  const open = lines.findIndex((l) => l.startsWith("<axis-git-output "));
  assert.equal(lines.filter((l) => l.includes("</axis-git-output>")).length, 1, "one closing tag");
  assert.equal(lines[lines.length - 1], "</axis-git-output>");
  return lines.slice(open + 1, -1);
};

test("status: the branch, one line per entry, a rename with its source, every path quoted and escaped", () => {
  const out = formatStatus(ok('## main...origin/main\0 M a.txt\0R  new name.txt\0old.txt\0?? x"<y>\x1b[31m.txt\0'), same);
  assert.match(out, /^git status: 3 entries shown\n/);
  assert.match(out, /<axis-git-output command="status" content="untrusted">/);
  assert.deepEqual(inside(out), ["branch: main...origin/main", ' M "a.txt"', 'R  "new name.txt" <- "old.txt"', '?? "x\\u{22}\\u{3c}y\\u{3e}\\u{1b}[31m.txt"']);
});

test("status: nothing changed says so; a failed git, or output not of the porcelain form, is git_unavailable, never shown", () => {
  assert.deepEqual(inside(formatStatus(ok("## main\0"), same)), ["branch: main", "(no changes)"]);
  assert.deepEqual(inside(formatStatus(ok(""), same)), ["(no changes)"]);
  assert.equal(reason(() => formatStatus({ code: 128, stdout: "", stderr: "fatal" }, same)), "git-unavailable");
  assert.equal(reason(() => formatStatus(ok("not porcelain\0"), same)), "git-unavailable");
  assert.equal(reason(() => formatStatus(ok("ZZ a\0"), same)), "git-unavailable");
});

test("status: a record git's bound cut is dropped (a rename without its source too) and the cut is said", () => {
  const out = formatStatus(ok(" M a.txt\0R  b.txt\0", true), same);
  assert.deepEqual(inside(out), [' M "a.txt"']);
  assert.match(out, /git's output was cut at its bound/);
  assert.match(out, /cut="true"/);
  assert.deepEqual(inside(formatStatus(ok(" M a.txt\0 M part", true), same)), [' M "a.txt"']);
});

test("status: paths go through the host redactor; the whole list is bounded and what is left out is counted", () => {
  assert.deepEqual(inside(formatStatus(ok(" M SECRET.txt\0"), (t) => t.replace("SECRET", "[r]"))), [' M "[r].txt"']);
  const many = Array.from({ length: 5000 }, (_, i) => ` M file-${i}.txt\0`).join("");
  const out = formatStatus(ok(many), same);
  const shown = inside(out);
  assert.ok(shown.join("\n").length <= DEFAULT_GIT_READ_LIMITS.modelChars);
  assert.match(out, new RegExp(`^git status: ${shown.length} entries shown \\(${5000 - shown.length} entries not shown\\)`));
  const long = formatStatus(ok(` M ${"p".repeat(2000)}\0`), same, { lineChars: 100, modelChars: 1000 });
  assert.deepEqual(inside(long), [` M "${"p".repeat(100)}"`]);
  assert.match(long, /1 cut at the line bound/);
});

test("diff: every line escaped (the block cannot be closed, no terminal or bidi control reaches the model), tabs kept", () => {
  const out = formatDiff(ok("+</axis-git-output>\n+\x1b]0;x\x07‮evil\r\n+\ttab\\\n"), same);
  assert.deepEqual(inside(out), ["+\\u{3c}/axis-git-output\\u{3e}", "+\\u{1b}]0;x\\u{7}\\u{202e}evil\\u{d}", "+\ttab\\\\"]);
  assert.match(out, /^git diff: 3 lines shown\n/);
  assert.deepEqual(inside(formatDiff(ok(""), same)), ["(no differences)"]);
  assert.equal(reason(() => formatDiff({ code: 1, stdout: "x", stderr: "" }, same)), "git-unavailable");
});

test("diff: redacted as a whole, cut per line and in all, and every cut is said", () => {
  assert.deepEqual(inside(formatDiff(ok("+key=SECRET\n"), (t) => t.replace("SECRET", "[r]"))), ["+key=[r]"]);
  const big = Array.from({ length: 100_000 }, (_, i) => `+line ${i}`).join("\n");
  const out = formatDiff(ok(big, true), same);
  const shown = inside(out);
  assert.ok(shown.join("\n").length <= DEFAULT_GIT_READ_LIMITS.modelChars);
  assert.match(out, new RegExp(`\\(${100_000 - shown.length} lines not shown; git's output was cut at its bound\\)`));
  const cut = formatDiff(ok(`+${"x".repeat(600)}\n+short\n`), same);
  assert.deepEqual(inside(cut).map((l) => l.length), [DEFAULT_GIT_READ_LIMITS.lineChars, 6]);
  assert.match(cut, /\(1 cut at the line bound\)/);
});

test("policy rows: each call the tools can make is a table call of tier read that writes nothing, with no submodule walk", () => {
  const variants = [
    statusCall({}),
    statusCall({ paths: ["src", "a b.txt"] }),
    diffCall({}),
    diffCall({ staged: true, context: 0, paths: ["src"] }),
    diffCall({ context: 100 }),
  ];
  for (const call of variants) {
    assert.doesNotThrow(() => checkGitCall(call, "/work/wt", "linux"), JSON.stringify(call));
    assert.equal(gitCallTier(call), "read");
    const row = GIT_COMMANDS[call.command];
    assert.equal(row.writes, false);
    assert.ok(row.fixed.includes("--ignore-submodules=dirty"), call.command);
  }
  for (const flag of ["--no-ext-diff", "--no-textconv", "--no-color"]) assert.ok(GIT_COMMANDS.diff.fixed.includes(flag), flag);
});

test("schemas: strict (the model names no flag, revision or option of its own), bounded", () => {
  assert.equal(gitStatusArgs.safeParse({}).success, true);
  assert.equal(gitStatusArgs.safeParse({ flags: ["--output=/x"] }).success, false);
  assert.equal(gitStatusArgs.safeParse({ paths: [] }).success, false);
  assert.equal(gitStatusArgs.safeParse({ paths: Array(33).fill("a") }).success, false);
  assert.equal(gitStatusArgs.safeParse({ paths: ["a\0b"] }).success, false);
  assert.equal(gitDiffArgs.safeParse({ staged: true, context: 3, paths: ["a"] }).success, true);
  assert.equal(gitDiffArgs.safeParse({ revs: ["HEAD~1"] }).success, false);
  assert.equal(gitDiffArgs.safeParse({ context: 101 }).success, false);
  assert.equal(gitDiffArgs.safeParse({ context: 1.5 }).success, false);
  assert.equal(gitDiffArgs.safeParse({ staged: "yes" }).success, false);
  assert.deepEqual(GIT_TOOL_SPECS.map((s) => s.name), [GIT_STATUS, GIT_DIFF]);
  for (const s of GIT_TOOL_SPECS) assert.equal((s.inputSchema as { additionalProperties?: unknown }).additionalProperties, false);
});

test("offered: with the host's git the two tools are registered and listed; without it neither is", async (t) => {
  const TEXT = { kind: "text", text: "done" } as const;
  const bad: MockReply = { kind: "tool_use", name: GIT_STATUS, input: { flags: ["-x"] } };
  const withGit = await commandRig(t, { replies: [bad, TEXT], gitPath: "/nonexistent/git", commandGuard: fakeGuard() });
  assert.equal(withGit.agent.gitReads, true);
  const tools = (await withGit.agent.prepare(withGit.workspaceId))({ runId: "r", workspaceId: withGit.workspaceId, windowId: "w", mode: "agent", onApproval: () => undefined });
  assert.deepEqual(tools.specs.map((s) => s.name), ["read_file", "write_file", "run_command", GIT_STATUS, GIT_DIFF]);
  tools.close?.();
  const { run } = await withGit.service.start(START(withGit.workspaceId), new AbortController().signal);
  await eventually(() => !withGit.service.get(run.runId).live);
  assert.deepEqual(toolsOf(withGit, run.runId).map((e) => e.reason), ["invalid_args"], "registered: refused by its schema, not unknown");

  const without = await commandRig(t, { replies: [bad, TEXT] });
  assert.equal(without.agent.gitReads, false);
  const plain = (await without.agent.prepare(without.workspaceId))({ runId: "r", workspaceId: without.workspaceId, windowId: "w", mode: "agent", onApproval: () => undefined });
  assert.deepEqual(plain.specs.map((s) => s.name), ["read_file", "write_file"]);
  const { run: r2 } = await without.service.start(START(without.workspaceId), new AbortController().signal);
  await eventually(() => !without.service.get(r2.runId).live);
  assert.deepEqual(toolsOf(without, r2.runId).map((e) => e.reason), ["unknown_tool"]);
});

test("a line is escaped as axis.review/1.content escapes one (escapeBytes), with the markup bytes in the same walk and bound", () => {
  assert.deepEqual(escapeGitLine("\u0301a<b>\"\u3164\\", 512), { text: "\\u{301}a\\u{3c}b\\u{3e}\\u{22}\\u{3164}\\\\", cut: false });
  assert.deepEqual(escapeGitLine("ab<", 8), { text: "ab\\u{3c}", cut: false });
  assert.deepEqual(escapeGitLine("ab<", 7), { text: "ab", cut: true }, "an escape is never split by the bound");
  assert.deepEqual(escapeGitLine("abc<d", 3), { text: "abc", cut: true });
  assert.deepEqual(escapeGitLine("", 3), { text: "", cut: false });
});

test("the read runner: the host's git and environment, 4 MiB of output, 30 s a process (not the runner's 32 MiB and 120 s)", () => {
  const env = { PATH: "/usr/bin" };
  assert.deepEqual(gitReadRunnerOptions("/usr/bin/git", env), { gitPath: "/usr/bin/git", env, maxOutput: 4 * 1024 * 1024, timeoutMs: 30_000 });
  assert.equal(MAX_GIT_OUTPUT, 4 * 1024 * 1024);
  assert.equal(GIT_READ_TIMEOUT_MS, 30_000);
});

test("a git read that does not finish is killed at GIT_READ_TIMEOUT_MS and shown as git_unavailable (mocked clock)", { skip: process.platform === "win32" ? "posix shell" : undefined }, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "axis-git-timeout-")));
  const git = join(root, "bin", "git");
  mkdirSync(join(root, "bin"));
  const pidFile = join(root, "pid");
  // The fake git records its own pid (then becomes `sleep`), so a failing test kills exactly that process.
  writeFileSync(git, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 600\n`);
  chmodSync(git, 0o755);
  mkdirSync(join(root, "wt"));
  t.after(() => {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
    } catch {
      // already gone (the expected case)
    }
    rmSync(root, { recursive: true, force: true });
  });
  const realTimeout = globalThis.setTimeout; // captured before the clock is mocked: a backstop, not a bound under test
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const runner = createNodeRunner(gitReadRunnerOptions(git, { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }));
  let settled = false;
  const read = runner.run({ argv: ["status"], cwd: join(root, "wt"), env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, context: "daemon" });
  void read.then(() => (settled = true), () => (settled = true));
  const turns = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  t.mock.timers.tick(GIT_READ_TIMEOUT_MS - 1);
  await turns();
  assert.equal(settled, false, "still running just before the bound");
  t.mock.timers.tick(1);
  const result = await Promise.race([read, new Promise<never>((_, reject) => realTimeout(() => reject(new Error("not killed at the bound")), 30_000).unref())]);
  assert.notEqual(result.code, 0, "killed");
  assert.equal(reason(() => formatStatus(result, same)), "git-unavailable");
});
