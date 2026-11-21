// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// createPtyGitRunner, push (H9-hooks §5.2, S4 part 1): git-ops' exact push form becomes a terminal-bound `push` run carrying the
// repository, the remote and the one pinned refspec; only its exit status comes back. Real git and the real pty service:
// pty-git-push-real.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { GitOpsError, prefix, type GitOpsDeps, type GitRunRequest } from "@axis/git-ops";
import { gitMethods } from "@axis/protocol";
import { createPtyGitRunner, DEFAULT_PUSH_TIMEOUT_MS, PUSH_HOOKS_UNAVAILABLE, selectPtyGitRunner } from "../src/bindings/pty-git.js";
import type { PtyExecPort, PtyExit, PtyHandle, PtyPushCall, PtyPushPort } from "../src/ports/pty.js";

const GIT = "/usr/bin/git";
const W = { workTree: "/repo/w", gitDir: "/repo/main/.git/worktrees/w" };
const TIP = "4".repeat(40);
const SPEC = `${TIP}:refs/heads/axis/feat`;
const ENV = { PATH: "/usr/bin", HOME: "/home/u", GIT_TERMINAL_PROMPT: "0", LANG: "C", GIT_DIR: "/elsewhere", SSH_AUTH_SOCK: "/run/a" };

/** git-ops' push (`push.ts` `check`): its pty prefix, `protocolAllowList()` (`PUSH_PROTOCOLS` order), then `push`. */
const gitOpsPush = (hooks: boolean, remote = "origin", refspec = SPEC): string[] => [
  ...prefix(W, { platform: "linux" } as unknown as GitOpsDeps, { context: "pty", hooks, filters: [] }),
  "-c", "protocol.allow=never", ...["https", "ssh", "git", "file"].flatMap((p) => ["-c", `protocol.${p}.allow=always`]),
  "push", "--no-follow-tags", "--no-recurse-submodules", ...(hooks ? [] : ["--no-verify"]), "--", remote, refspec,
];
const URLS = "5".repeat(64);
const req = (argv: readonly string[], extra: Partial<GitRunRequest> = {}): GitRunRequest => ({ argv, cwd: W.workTree, env: ENV, context: "pty", pushUrls: URLS, ...extra });
const isCode = (code: string, reason?: string) => (e: unknown): boolean =>
  e instanceof GitOpsError && e.code === code && (reason === undefined || e.details?.["reason"] === reason) && !e.message.includes("/repo") && !e.message.includes(TIP);

interface FakeTerm extends PtyHandle {
  readonly killed: string[];
  exit(e: PtyExit): void;
  alive: boolean | "throw";
}
function term(): FakeTerm {
  const ls = new Set<(e: PtyExit) => void>();
  const t: FakeTerm = {
    killed: [],
    alive: false,
    exit: (e) => ls.forEach((l) => l(e)),
    write: () => undefined,
    resize: () => undefined,
    kill: (s) => void t.killed.push(s),
    groupAlive: () => {
      if (t.alive === "throw") throw new Error("unknown");
      return t.alive;
    },
    onData: () => ({ dispose: () => undefined }),
    onExit: (l) => (ls.add(l), { dispose: () => void ls.delete(l) }),
  };
  return t;
}
/** A push port whose terminal exits with `exit` on the next turn (or never, for "hang"). */
function pushPort(exit: PtyExit | "hang" | Error = { exitCode: 0, signal: null }): PtyExecPort & PtyPushPort & { calls: PtyPushCall[]; terms: FakeTerm[]; execs: number } {
  const p = {
    calls: [] as PtyPushCall[],
    terms: [] as FakeTerm[],
    execs: 0,
    exec: () => (p.execs++, Promise.reject(new Error("no exec for a push"))),
    push: async (c: PtyPushCall): Promise<PtyHandle> => {
      p.calls.push(c);
      if (exit instanceof Error) throw exit;
      const t = term();
      p.terms.push(t);
      if (exit !== "hang") setImmediate(() => t.exit(exit));
      return t;
    },
  };
  return p;
}
const runner = (port: (PtyExecPort & Partial<PtyPushPort>) | undefined, pushTimeoutMs?: number) =>
  createPtyGitRunner(port, { gitPath: GIT, platform: "linux", hooksOffPath: "/dev/null", ...(pushTimeoutMs === undefined ? {} : { pushTimeoutMs }) });

test("git-ops' push maps onto the push run: repository, remote and pinned refspec only, the allow-listed environment, the exit status back", async () => {
  const port = pushPort({ exitCode: 0, signal: null });
  const r = await runner(port).run(req(gitOpsPush(false)));
  assert.deepEqual(r, { code: 0, stdout: "", stderr: "" }, "no output comes back (H-7)");
  assert.equal(port.calls.length, 1);
  const c = port.calls[0] as PtyPushCall;
  assert.deepEqual({ repo: c.repo, remote: c.remote, refspec: c.refspec }, { repo: W, remote: "origin", refspec: SPEC });
  assert.deepEqual(c.env, { GIT_TERMINAL_PROMPT: "0", LANG: "C" }, "redirectors, HOME, PATH and the agent socket are never sent");
  assert.equal(c.pushUrls, URLS, "git-ops' digest of the push URLs it read, for the pty process to compare");
  assert.deepEqual(c.expectEnv, { HOME: "/home/u", XDG_CONFIG_HOME: null, GIT_CONFIG: null, GIT_CONFIG_GLOBAL: null, GIT_CONFIG_SYSTEM: null, GIT_CONFIG_NOSYSTEM: null, GIT_SSH: null, GIT_SSH_COMMAND: null, GIT_SSH_VARIANT: null, GIT_PROXY_COMMAND: null }, "the configuration and ssh variables git-ops checked, for the pty process to compare");
  assert.ok(c.runId.length > 0 && c.cols > 0 && c.rows > 0);
  assert.equal(port.execs, 0, "a push is never an exec");
  const failed = await runner(pushPort({ exitCode: 1, signal: null })).run(req(gitOpsPush(false)));
  assert.equal(failed.code, 1, "a rejected push (non-fast-forward, auth) is its exit status");
});

test("a push with repository hooks on (no hooks pin, no --no-verify) is refused E_UNAVAILABLE hooks_unavailable: pre-push is part 2", async () => {
  const port = pushPort();
  await assert.rejects(runner(port).run(req(gitOpsPush(true))), isCode("E_UNAVAILABLE", PUSH_HOOKS_UNAVAILABLE));
  await assert.rejects(runner(undefined).run(req(gitOpsPush(true))), isCode("E_UNAVAILABLE", PUSH_HOOKS_UNAVAILABLE));
  assert.equal(port.calls.length, 0, "nothing was started");
});

test("only git-ops' exact push form maps: a force, another ref, a URL, a second refspec or an unknown pin is refused and nothing starts", async () => {
  const base = gitOpsPush(false);
  const at = base.indexOf("push");
  const without = (tok: string): string[] => base.filter((a) => a !== tok);
  const cases: Array<[string, string[]]> = [
    ["a forced refspec", gitOpsPush(false, "origin", `+${SPEC}`)],
    ["a branch outside axis/", gitOpsPush(false, "origin", `${TIP}:refs/heads/main`)],
    ["a tag", gitOpsPush(false, "origin", `${TIP}:refs/tags/v1`)],
    ["a delete", gitOpsPush(false, "origin", ":refs/heads/axis/feat")],
    ["a symbolic source", gitOpsPush(false, "origin", "HEAD:refs/heads/axis/feat")],
    ["a URL for the remote", gitOpsPush(false, "https://example.invalid/r.git")],
    ["a path for the remote", gitOpsPush(false, "/tmp/r.git")],
    ["an option for the remote", gitOpsPush(false, "--receive-pack=/bin/x")],
    ["--force added", [...base.slice(0, at + 1), "--force", ...base.slice(at + 1)]],
    ["a second refspec", [...base, `${TIP}:refs/heads/axis/other`]],
    ["--no-verify missing with the hooks pin", without("--no-verify")],
    ["--no-follow-tags missing", without("--no-follow-tags")],
    ["no -- before the remote", without("--")],
    ["an unknown -c among the transport pins", [...base.slice(0, at), "-c", "core.sshCommand=/bin/x", ...base.slice(at)]],
    ["a transport pin set to never", base.map((a) => (a === "protocol.ssh.allow=always" ? "protocol.ssh.allow=never" : a))],
    ["the ext transport allowed", base.map((a) => (a === "protocol.git.allow=always" ? "protocol.ext.allow=always" : a))],
    ["a lost --git-dir", base.filter((a) => !a.startsWith("--git-dir="))],
  ];
  for (const [what, argv] of cases) {
    const port = pushPort();
    await assert.rejects(runner(port).run(req(argv)), isCode("E_INTERNAL"), what);
    assert.equal(port.calls.length, 0, what);
  }
  const port = pushPort();
  await assert.rejects(runner(port).run(req(base, { stdin: "x" })), isCode("E_INTERNAL"), "stdin is not git-ops' push");
  for (const pushUrls of [undefined, "", "x".repeat(64), "5".repeat(63)]) {
    const r = req(base);
    const { pushUrls: _drop, ...rest } = r;
    await assert.rejects(runner(port).run(pushUrls === undefined ? rest : { ...rest, pushUrls }), isCode("E_INTERNAL"), `push URL digest ${String(pushUrls)}`);
  }
  await assert.rejects(runner(port).run(req(base, { env: { GIT_TERMINAL_PROMPT: "0\0x" } })), isCode("E_INTERNAL"), "a NUL in a kept value");
  assert.equal(port.calls.length, 0);
});

test("unavailable: no port, a port without push, a closed channel or a busy pty process is E_UNAVAILABLE; a form refusal is E_INTERNAL", async () => {
  await assert.rejects(runner(undefined).run(req(gitOpsPush(false))), isCode("E_UNAVAILABLE"));
  await assert.rejects(runner({ exec: () => Promise.reject(new Error("x")) }).run(req(gitOpsPush(false))), isCode("E_UNAVAILABLE"), "an exec-only port cannot push");
  for (const code of ["channel_closed", "timeout", "capacity", "spawn_failed", "no_control", undefined]) {
    await assert.rejects(runner(pushPort(Object.assign(new Error("x /repo"), { code }))).run(req(gitOpsPush(false))), isCode("E_UNAVAILABLE"), String(code));
  }
  for (const code of ["bad_argv", "env_denied", "bad_bind"]) {
    await assert.rejects(runner(pushPort(Object.assign(new Error("x"), { code }))).run(req(gitOpsPush(false))), isCode("E_INTERNAL"), code);
  }
  await assert.rejects(runner(pushPort({ exitCode: null, signal: "SIGKILL" })).run(req(gitOpsPush(false))), isCode("E_UNAVAILABLE"), "no exit status");
});

test("a push past its bound is killed and refused; a survivor in the group after git exits is killed; an unknown group counts as alive", async () => {
  const hang = pushPort("hang");
  await assert.rejects(runner(hang, 30).run(req(gitOpsPush(false))), isCode("E_UNAVAILABLE"));
  assert.deepEqual(hang.terms[0]?.killed, ["SIGKILL"]);
  const survivor = pushPort({ exitCode: 0, signal: null });
  const real = survivor.push.bind(survivor);
  survivor.push = async (c) => {
    const h = (await real(c)) as FakeTerm;
    h.alive = true;
    return h;
  };
  assert.equal((await runner(survivor).run(req(gitOpsPush(false)))).code, 0, "the exit status decides");
  assert.deepEqual(survivor.terms[0]?.killed, ["SIGKILL"]);
  const unknown = pushPort({ exitCode: 0, signal: null });
  const realU = unknown.push.bind(unknown);
  unknown.push = async (c) => {
    const h = (await realU(c)) as FakeTerm;
    h.alive = "throw";
    return h;
  };
  await runner(unknown).run(req(gitOpsPush(false)));
  assert.deepEqual(unknown.terms[0]?.killed, ["SIGKILL"]);
  const clean = pushPort({ exitCode: 0, signal: null });
  await runner(clean).run(req(gitOpsPush(false)));
  assert.deepEqual(clean.terms[0]?.killed, [], "a group that is gone is not signalled");
});

test("the composition passes the port's push to the runner it builds over exec", async () => {
  const port = pushPort();
  const make = selectPtyGitRunner(port, undefined, "linux") as (g: string) => ReturnType<typeof runner>;
  assert.equal((await make(GIT).run(req(gitOpsPush(false)))).code, 0);
  assert.equal(port.calls.length, 1);
  const execOnly = selectPtyGitRunner({ exec: port.exec }, undefined, "linux") as (g: string) => ReturnType<typeof runner>;
  await assert.rejects(execOnly(GIT).run(req(gitOpsPush(false))), isCode("E_UNAVAILABLE"));
});

test("the pty process's own refusal of the remote (remote_refused) is E_POLICY_DENIED; the variables git-ops saw are sent as they were", async () => {
  await assert.rejects(runner(pushPort(Object.assign(new Error("x"), { code: "remote_refused" }))).run(req(gitOpsPush(false))), isCode("E_POLICY_DENIED"));
  const port = pushPort();
  await runner(port).run(req(gitOpsPush(false), { env: { ...ENV, XDG_CONFIG_HOME: "/x", GIT_SSH_COMMAND: "ssh -i k" } }));
  assert.equal(port.calls[0]?.expectEnv.XDG_CONFIG_HOME, "/x");
  assert.equal(port.calls[0]?.expectEnv.GIT_SSH_COMMAND, "ssh -i k");
  assert.equal(port.calls[0]?.env["GIT_SSH_COMMAND"], undefined, "compared, never sent as environment");
});

test("S-1: the request's signal kills the push run (E_CANCELLED); aborted before, nothing starts; the default bound is under the method's 30 s", async () => {
  const hang = pushPort("hang");
  const ac = new AbortController();
  const p = runner(hang).run(req(gitOpsPush(false), { signal: ac.signal }));
  await new Promise((x) => setImmediate(x));
  ac.abort();
  await assert.rejects(p, isCode("E_CANCELLED"));
  assert.deepEqual(hang.terms[0]?.killed, ["SIGKILL"]);
  const none = pushPort();
  await assert.rejects(runner(none).run(req(gitOpsPush(false), { signal: ac.signal })), isCode("E_CANCELLED"));
  assert.equal(none.calls.length, 0);
  // The default bound is under the method's own timeout, so the run never outlives the request.
  assert.ok(DEFAULT_PUSH_TIMEOUT_MS < gitMethods.push.timeoutMs, `${DEFAULT_PUSH_TIMEOUT_MS} < ${gitMethods.push.timeoutMs}`);
});

test("review 2 N-2: a cancel while the spawn is pending (the pty process's remote check) answers at once, and the handle that still arrives is killed", { timeout: 10_000 }, async () => {
  let deliver: ((h: PtyHandle) => void) | undefined;
  const t = term();
  const port: PtyExecPort & PtyPushPort = { exec: () => Promise.reject(new Error("x")), push: () => new Promise<PtyHandle>((resolve) => (deliver = resolve)) };
  const ac = new AbortController();
  const p = runner(port).run(req(gitOpsPush(false), { signal: ac.signal }));
  await new Promise((x) => setImmediate(x));
  ac.abort();
  // The answer must come from the cancel, not from the spawn: race it against a short timer so a runner that waits on the
  // spawn fails this assertion in about a second instead of hanging the suite (review 3 SF-1).
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    p.then(() => "resolved", (e: unknown) => e),
    new Promise<string>((resolve) => (timer = setTimeout(() => resolve("still pending 1 s after the cancel"), 1_000))),
  ]);
  clearTimeout(timer);
  if (typeof outcome === "string") {
    deliver?.(t); // let a waiting runner go on, so nothing it holds keeps the test alive
    t.exit({ exitCode: 0, signal: null });
    assert.fail(`the run did not answer the cancel: ${outcome}`);
  }
  assert.ok(isCode("E_CANCELLED")(outcome), String(outcome));
  deliver?.(t);
  await new Promise((x) => setImmediate(x));
  assert.deepEqual(t.killed, ["SIGKILL"], "the late terminal is ended");
});
