// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// createPtyGitRunner (H9-hooks §4.1): git-ops' exact pty prefix is mapped onto `exec` fields, anything else is refused, and a
// missing or failing pty process is E_UNAVAILABLE. Real git and the real pty service: pty-git-runner-real.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { GitOpsError, prefix, type GitOpsDeps, type GitRunRequest } from "@axis/git-ops";
import { createPtyGitRunner, PUSH_NOT_AVAILABLE } from "../src/bindings/pty-git.js";
import type { PtyExecCall, PtyExecOutcome, PtyExecPort } from "../src/ports/pty.js";

const GIT = "/usr/bin/git";
const W = { workTree: "/repo/w", gitDir: "/repo/main/.git/worktrees/w" };
const P = "1".repeat(40);
const T = "2".repeat(40);
const OK: PtyExecOutcome = { code: 0, signal: null, stdout: `${"3".repeat(40)}\n`, stderr: "", truncated: false };

/** git-ops' own prefix (args.ts), so a change there that this adapter does not map fails here. */
const gitOpsPrefix = (hooks: boolean): string[] => prefix(W, { platform: "linux" } as unknown as GitOpsDeps, { context: "pty", hooks, filters: [] });
const commitTree = (hooks = false): string[] => [...gitOpsPrefix(hooks), "-c", "i18n.commitEncoding=utf-8", "commit-tree", "-p", P, "-F", "-", T];
const gpgsign = (hooks = false): string[] => [...gitOpsPrefix(hooks), "config", "--type=bool", "--get", "commit.gpgsign"];
const ENV = { PATH: "/usr/bin", HOME: "/home/u", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "A", LC_ALL: "C", GIT_DIR: "/elsewhere", GIT_CONFIG_GLOBAL: "/tmp/x", SSH_AUTH_SOCK: "/run/a" };
const req = (argv: readonly string[], extra: Partial<GitRunRequest> = {}): GitRunRequest => ({ argv, cwd: W.workTree, env: ENV, context: "pty", ...extra });

function recording(answer: () => Promise<PtyExecOutcome> = async () => OK): PtyExecPort & { calls: PtyExecCall[] } {
  const calls: PtyExecCall[] = [];
  return { calls, exec: (c) => (calls.push(c), answer()) };
}
const runner = (port: PtyExecPort | undefined) => createPtyGitRunner(port, { gitPath: GIT, platform: "linux", hooksOffPath: "/dev/null" });
const isCode = (code: string) => (e: unknown): boolean => e instanceof GitOpsError && e.code === code && !e.message.includes("/repo") && !e.message.includes(P);

test("git-ops' commit-tree maps onto exec: git path, subcommand, repo from --git-dir/--work-tree, stdin, and no global option", async () => {
  for (const hooks of [false, true]) {
    const port = recording();
    const r = await runner(port).run(req(commitTree(hooks), { stdin: "msg\n" }));
    assert.deepEqual(r, { code: 0, stdout: OK.stdout, stderr: "" });
    const c = port.calls[0] as PtyExecCall;
    assert.deepEqual(c.argv, [GIT, "commit-tree", "-p", P, "-F", "-", T]);
    assert.deepEqual(c.repo, { gitDir: W.gitDir, workTree: W.workTree }, "the journal's explicit directories are kept (GIT-4)");
    assert.equal(c.stdin, "msg\n");
    assert.equal(c.cwd, W.workTree);
    assert.ok(c.timeoutMs > 0 && c.maxOutput > 0);
  }
});

test("git-ops' commit.gpgsign read maps onto exec; signed commit-tree keeps -S", async () => {
  const port = recording();
  await runner(port).run(req(gpgsign()));
  assert.deepEqual(port.calls[0]?.argv, [GIT, "config", "--type=bool", "--get", "commit.gpgsign"]);
  const signed = commitTree();
  signed.splice(signed.indexOf("commit-tree") + 1, 0, "-S");
  await runner(port).run(req(signed));
  assert.deepEqual(port.calls[1]?.argv, [GIT, "commit-tree", "-S", "-p", P, "-F", "-", T]);
});

test("only the service's allow-listed names leave the host; redirectors, config locations and the rest are not sent", async () => {
  const port = recording();
  await runner(port).run(req(commitTree()));
  assert.deepEqual(port.calls[0]?.env, { GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "A", LC_ALL: "C" });
  // The name check is case-insensitive, as the service's is (and Windows names are): neither list drops what the other keeps.
  await runner(port).run(req(commitTree(), { env: { Lang: "C", git_author_email: "a@example.invalid", Lc_Ctype: "C", Git_Dir: "/x", home: "/h" } }));
  assert.deepEqual(port.calls[1]?.env, { Lang: "C", git_author_email: "a@example.invalid", Lc_Ctype: "C" });
  await assert.rejects(runner(port).run(req(commitTree(), { env: { GIT_AUTHOR_NAME: "a\0b" } })), isCode("E_INTERNAL"));
  assert.equal(port.calls.length, 2);
});

/** Every leading sequence that is not exactly git-ops' is refused before anything is sent. */
test("a command whose global options differ from git-ops' prefix is refused (closed error, nothing sent)", async () => {
  const base = commitTree();
  const at = (tok: string): number => base.indexOf(tok);
  const without = (i: number, n = 1): string[] => base.filter((_, k) => k < i || k >= i + n);
  const insert = (i: number, ...tok: string[]): string[] => [...base.slice(0, i), ...tok, ...base.slice(i)];
  const swap = (from: string, to: string): string[] => base.map((a) => (a === from ? to : a));
  const cases: Array<[string, string[]]> = [
    ["no --no-pager", without(at("--no-pager"))],
    ["no --no-replace-objects", without(at("--no-replace-objects"))],
    ["lost --git-dir", without(at(`--git-dir=${W.gitDir}`))],
    ["lost --work-tree", without(at(`--work-tree=${W.workTree}`))],
    ["relative --git-dir", swap(`--git-dir=${W.gitDir}`, "--git-dir=repo/.git")],
    ["unnormalised --work-tree", swap(`--work-tree=${W.workTree}`, "--work-tree=/repo/x/../w")],
    ["empty --git-dir", swap(`--git-dir=${W.gitDir}`, "--git-dir=")],
    ["-C instead of --work-tree", swap(`--work-tree=${W.workTree}`, "-C")],
    ["lost encoding pin", without(at("i18n.commitEncoding=utf-8") - 1, 2)],
    ["encoding latin1", swap("i18n.commitEncoding=utf-8", "i18n.commitEncoding=latin1")],
    ["fsmonitor on", swap("core.fsmonitor=false", "core.fsmonitor=true")],
    ["lost fsmonitor pin", without(at("core.fsmonitor=false") - 1, 2)],
    ["lost protocol.ext pin", without(at("protocol.ext.allow=never") - 1, 2)],
    ["another hooks path", swap("core.hooksPath=/dev/null", "core.hooksPath=/repo/hooks")],
    ["an unknown -c before the subcommand", insert(at("commit-tree"), "-c", "core.editor=/bin/x")],
    ["an unknown -c inside the prefix", insert(at("-c"), "-c", "core.sshCommand=/bin/x")],
    ["--exec-path", insert(at("commit-tree"), "--exec-path=/tmp")],
    ["--namespace", insert(at("commit-tree"), "--namespace=x")],
    ["order changed", [base[1] as string, base[0] as string, ...base.slice(2)]],
    ["prefix only", base.slice(0, at("commit-tree"))],
    ["an unknown -c between the hooks pin and the encoding pin", insert(at("i18n.commitEncoding=utf-8") - 1, "-c", "core.editor=/bin/x")],
    ["an unknown -c between the protocol.ext pin and the hooks pin", insert(at("core.hooksPath=/dev/null") - 1, "-c", "core.editor=/bin/x")],
  ];
  // The runHooks form (no hooks pin): an unknown -c where the hooks pin would be.
  const on = commitTree(true);
  cases.push(["hooks on: an unknown -c before the encoding pin", [...on.slice(0, on.indexOf("i18n.commitEncoding=utf-8") - 1), "-c", "core.editor=/bin/x", ...on.slice(on.indexOf("i18n.commitEncoding=utf-8") - 1)]]);
  for (const [what, argv] of cases) {
    const port = recording();
    await assert.rejects(runner(port).run(req(argv)), isCode("E_INTERNAL"), what);
    assert.equal(port.calls.length, 0, what);
  }
});

test("an unmappable subcommand or option is refused: closed list, exact tokens", async () => {
  const pre = gitOpsPrefix(false);
  const enc = ["-c", "i18n.commitEncoding=utf-8"];
  const cases: Array<[string, string[]]> = [
    ["push without git-ops' transport pins", [...pre, "push", "origin", "HEAD:refs/heads/axis/x"]],
    ["update-ref", [...pre, "update-ref", "refs/heads/axis/x", T]],
    ["an alias name", [...pre, "ci"]],
    ["commit-tree with -m", [...pre, ...enc, "commit-tree", "-p", P, "-m", "x", T]],
    ["commit-tree with a ref, not an id", [...pre, ...enc, "commit-tree", "-p", "HEAD", "-F", "-", T]],
    ["commit-tree reading a file", [...pre, ...enc, "commit-tree", "-p", P, "-F", "/etc/passwd", T]],
    ["commit-tree with a second parent", [...pre, ...enc, "commit-tree", "-p", P, "-p", P, "-F", "-", T]],
    ["config --get-all", [...pre, "config", "--get-all", "commit.gpgsign"]],
    ["config of another key", [...pre, "config", "--type=bool", "--get", "credential.helper"]],
    ["config --list", [...pre, "config", "--list"]],
    ["config with the encoding pin", [...pre, ...enc, "config", "--type=bool", "--get", "commit.gpgsign"]],
    ["config set", [...pre, "config", "core.sshCommand", "/bin/x"]],
  ];
  for (const [what, argv] of cases) {
    const port = recording();
    await assert.rejects(runner(port).run(req(argv)), isCode("E_INTERNAL"), what);
    assert.equal(port.calls.length, 0, what);
  }
  const port = recording();
  await assert.rejects(runner(port).run(req(commitTree(), { context: "daemon" })), isCode("E_INTERNAL"), "daemon context");
  await assert.rejects(runner(port).run(req(commitTree(), { raw: true })), isCode("E_INTERNAL"), "raw output cannot be honoured");
  await assert.rejects(runner(port).run(req(commitTree(), { cwd: "w" })), isCode("E_INTERNAL"), "relative cwd");
  assert.equal(port.calls.length, 0);
});

test("a hooks pin is refused when the host knows no hooks-off path", async () => {
  const port = recording();
  const r = createPtyGitRunner(port, { gitPath: GIT, platform: "linux" });
  await assert.rejects(r.run(req(commitTree(false))), isCode("E_INTERNAL"));
  await r.run(req(commitTree(true)));
  assert.equal(port.calls.length, 1, "git-ops' runHooks form carries no hooks pin; the service pins hooks off itself");
});

test("pty unavailable: no port, a port without exec, a closed channel, a timeout or no control is E_UNAVAILABLE", async () => {
  await assert.rejects(runner(undefined).run(req(commitTree())), isCode("E_UNAVAILABLE"));
  await assert.rejects(runner({} as PtyExecPort).run(req(commitTree())), isCode("E_UNAVAILABLE"));
  for (const code of ["channel_closed", "timeout", "no_control", "capacity", "spawn_failed", undefined]) {
    const port = recording(() => Promise.reject(Object.assign(new Error("x /repo/secret"), { code })));
    await assert.rejects(runner(port).run(req(commitTree())), isCode("E_UNAVAILABLE"), String(code));
  }
  const killed = recording(async () => ({ ...OK, code: null, signal: "SIGKILL" }));
  await assert.rejects(runner(killed).run(req(commitTree())), isCode("E_UNAVAILABLE"), "killed by a signal");
});

test("a service refusal of the mapped form is a wiring fault (E_INTERNAL); a git exit status and truncation are passed on", async () => {
  for (const code of ["bad_argv", "env_denied", "bad_bind"]) {
    const port = recording(() => Promise.reject(Object.assign(new Error("x"), { code })));
    await assert.rejects(runner(port).run(req(commitTree())), isCode("E_INTERNAL"), code);
  }
  const one = recording(async () => ({ ...OK, code: 1, stdout: "", truncated: true }));
  assert.deepEqual(await runner(one).run(req(gpgsign())), { code: 1, stdout: "", stderr: "", truncated: true });
});

test("the runner needs an absolute git path", () => {
  assert.throws(() => createPtyGitRunner(undefined, { gitPath: "git", platform: "linux" }), TypeError);
  assert.throws(() => createPtyGitRunner(undefined, { gitPath: "", platform: "linux" }), TypeError);
});

test("the composition's choice: a pty port with exec gets the strict runner over it; a second source or none is refused", async () => {
  const { selectPtyGitRunner } = await import("../src/bindings/pty-git.js");
  const port = recording();
  const explicit = { run: () => Promise.reject(new Error("unused")) };
  const viaExec = selectPtyGitRunner(port, undefined, "linux");
  assert.equal(typeof viaExec, "function");
  await (viaExec as (g: string) => ReturnType<typeof runner>)(GIT).run(req(commitTree()));
  assert.deepEqual(port.calls[0]?.argv, [GIT, "commit-tree", "-p", P, "-F", "-", T], "the host's git path, git-ops' request mapped");
  await assert.rejects((viaExec as (g: string) => ReturnType<typeof runner>)(GIT).run(req(["push"])), isCode("E_INTERNAL"), "the strict mapping, not a pass-through");
  // Windows: real Windows paths, so only the hooks pin decides. No hooks-off path is wired there: the pinned form is refused
  // and the runHooks form (no pin; the service pins hooks off itself) is sent.
  const ww = { workTree: "C:\\r", gitDir: "C:\\r\\.git" };
  const winArgv = (hooks: boolean): string[] => [...prefix(ww, { platform: "linux" } as unknown as GitOpsDeps, { context: "pty", hooks, filters: [] }), "-c", "i18n.commitEncoding=utf-8", "commit-tree", "-p", P, "-F", "-", T];
  const winPort = recording();
  const win = selectPtyGitRunner(winPort, undefined, "win32") as (g: string) => ReturnType<typeof runner>;
  await assert.rejects(win("C:\\git\\git.exe").run(req(winArgv(false), { cwd: ww.workTree })), isCode("E_INTERNAL"), "a pinned request is refused on Windows");
  assert.equal(winPort.calls.length, 0);
  await win("C:\\git\\git.exe").run(req(winArgv(true), { cwd: ww.workTree }));
  assert.deepEqual(winPort.calls[0]?.repo, ww, "the unpinned form with Windows paths is sent");
  assert.equal(selectPtyGitRunner(port, explicit, "linux"), "pty_git_runner_conflict");
  assert.equal(selectPtyGitRunner({}, undefined, "linux"), "pty_git_runner_required");
  assert.equal(selectPtyGitRunner(undefined, {} as never, "linux"), "pty_git_runner_required");
  const fake = selectPtyGitRunner({}, explicit, "linux") as (g: string) => unknown;
  assert.equal(fake(GIT), explicit, "a pty port without exec (a test fake) keeps the caller's runner");
});

/** git-ops' push (`push.ts`): its prefix, its transport allow-list (`protocolAllowList()`), then `push`. */
const gitOpsPush = (hooks: boolean, protocols: readonly string[] = ["https", "ssh", "file"]): string[] => [
  ...gitOpsPrefix(hooks), "-c", "protocol.allow=never", ...protocols.flatMap((p) => ["-c", `protocol.${p}.allow=always`]),
  "push", "--no-follow-tags", "--no-recurse-submodules", ...(hooks ? [] : ["--no-verify"]), "--", "origin", "refs/heads/axis/x:refs/heads/axis/x",
];

test("git-ops' push is answered E_UNAVAILABLE with a fixed reason until H9-hooks S4 builds it, never as an internal fault, and nothing is sent", async () => {
  for (const hooks of [false, true]) {
    const port = recording();
    await assert.rejects(runner(port).run(req(gitOpsPush(hooks))), (e: unknown) => isCode("E_UNAVAILABLE")(e) && (e as GitOpsError).details?.["reason"] === PUSH_NOT_AVAILABLE, `hooks ${hooks}`);
    await assert.rejects(runner(undefined).run(req(gitOpsPush(hooks))), (e: unknown) => (e as GitOpsError).details?.["reason"] === PUSH_NOT_AVAILABLE);
    assert.equal(port.calls.length, 0);
  }
  // Only git-ops' own form is recognised: anything else around a push stays a refused, unmapped form.
  const base = gitOpsPush(false);
  const at = base.indexOf("push");
  for (const [what, argv] of [
    ["an unknown -c among the transport pins", [...base.slice(0, at), "-c", "core.sshCommand=/bin/x", ...base.slice(at)]],
    ["a transport pin set to never", base.map((a) => (a === "protocol.ssh.allow=always" ? "protocol.ssh.allow=never" : a))],
    ["no protocol.allow=never first", base.filter((_, k) => k !== base.indexOf("protocol.allow=never") && k !== base.indexOf("protocol.allow=never") - 1)],
    ["a lost --git-dir", base.filter((a) => !a.startsWith("--git-dir="))],
  ] as const) {
    await assert.rejects(runner(recording()).run(req(argv)), isCode("E_INTERNAL"), what);
  }
});
