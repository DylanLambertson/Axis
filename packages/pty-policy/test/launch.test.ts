// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveExecutable, resolveLaunch, type ExecFs } from "../src/index.js";

const fsOf = (files: string[]): ExecFs => ({ isExecutableFile: (p) => files.includes(p) });
const WT = "/data/wt/proj-1/feat";
const agent = { id: "a", label: "A", command: ["agentcli", "run"], args: ["--x"], envPassthrough: ["MY_KEY"] };
const parentEnv = { PATH: "/usr/local/bin:/usr/bin", HOME: "/h", SSH_AUTH_SOCK: "/s", VSCODE_NONCE: "n", GIT_ASKPASS: "g", MY_KEY: "k" };
const base = { agent, worktreeRoot: WT, trusted: true, parentEnv, platform: "linux" as const, fs: fsOf(["/usr/bin/agentcli"]) };

test("trusted launch returns the resolved absolute argv, cwd, env and no shell integration", () => {
  const r = resolveLaunch(base);
  assert.ok(r.ok);
  assert.deepEqual(r.argv, ["/usr/bin/agentcli", "run", "--x"]);
  assert.equal(r.cwd, WT);
  assert.deepEqual(r.env, { PATH: parentEnv.PATH, HOME: "/h", SSH_AUTH_SOCK: "/s", MY_KEY: "k" });
  assert.equal(r.shellIntegration, false);
  assert.ok(r.removed.some((x) => x.name === "VSCODE_NONCE"));
});

test("an untrusted workspace is refused, for anything other than exactly true", () => {
  for (const trusted of [false, undefined, null, 0, "true", 1] as unknown[]) {
    const r = resolveLaunch({ ...base, trusted: trusted as boolean });
    assert.ok(!r.ok && r.code === "UNTRUSTED");
  }
  const r = resolveLaunch({ ...base, trusted: false, agent: "garbage", worktreeRoot: "rel" });
  assert.ok(!r.ok && r.code === "UNTRUSTED", "refused before any other work");
});

test("an invalid agent is refused, including a shell string or relative path command", () => {
  for (const a of ["x", null, { ...agent, command: "sh -c x" }, { ...agent, command: ["./sh"] }, { ...agent, envPassthrough: ["GIT_ASKPASS"] }, { ...agent, shell: true }]) {
    const r = resolveLaunch({ ...base, agent: a });
    assert.ok(!r.ok && r.code === "INVALID_AGENT");
  }
});

test("the worktree root must be an absolute, normalised path", () => {
  for (const w of ["", "relative", "/a/../b", "/a/./b", "/a//b", "/a\0b", "."]) {
    const r = resolveLaunch({ ...base, worktreeRoot: w });
    assert.ok(!r.ok && r.code === "BAD_WORKTREE", JSON.stringify(w));
  }
  assert.ok(resolveLaunch({ ...base, worktreeRoot: "/a/b/" }).ok);
});

test("Windows: UNC, device and root-relative executables are refused (proof from the review)", () => {
  for (const c of ["\\\\evil\\share\\a.exe", "//evil/share/a.exe", "\\rooted\\a.exe", "/rooted/a.exe", "\\\\?\\C:\\a.exe", "\\\\.\\pipe\\x", "a/b.exe", "..\\a.exe"]) {
    const r = resolveLaunch({ ...base, platform: "win32", worktreeRoot: "C:\\w\\wt", agent: { ...agent, command: [c] }, parentEnv: {} });
    assert.ok(!r.ok && r.code === "INVALID_AGENT", c);
  }
});

test("Windows: .bat and .cmd are refused in every spelling, with a clear reason", () => {
  for (const c of ["C:\\t\\a.cmd", "C:\\t\\a.BAT", "C:\\t\\a.cmd.", "C:\\t\\a.cmd  ", "C:\\t\\a.Cmd. .", "examplecli.cmd", "x.bat"]) {
    const r = resolveLaunch({ ...base, platform: "win32", worktreeRoot: "C:\\w\\wt", agent: { ...agent, command: [c], args: ["x&calc", "%PATH%", "\"&calc"] }, parentEnv: {} });
    assert.ok(!r.ok && r.code === "INVALID_AGENT", c);
    if (!r.ok) assert.match(r.message, /\.exe/);
  }
});

test("Windows: a drive-letter executable and root work; roots must be drive-letter, not UNC", () => {
  const ok = resolveLaunch({ ...base, platform: "win32", worktreeRoot: "C:\\w\\wt", agent: { ...agent, command: ["C:\\Tools\\agent.exe"] }, parentEnv: {}, fs: fsOf(["C:\\Tools\\agent.exe"]) });
  assert.ok(ok.ok);
  for (const w of ["\\\\server\\share\\wt", "\\\\?\\C:\\wt", "\\wt", "C:wt", "C:\\a\\..\\b"]) {
    const r = resolveLaunch({ ...base, platform: "win32", worktreeRoot: w, agent: { ...agent, command: ["C:\\Tools\\agent.exe"] }, parentEnv: {}, fs: fsOf(["C:\\Tools\\agent.exe"]) });
    assert.ok(!r.ok && r.code === "BAD_WORKTREE", w);
  }
});

test("Windows: roots and env names are matched with Windows rules", () => {
  const r = resolveLaunch({
    ...base, platform: "win32", worktreeRoot: "C:\\wt\\p\\feat", agent: { ...agent, command: ["agentcli"], args: [], envPassthrough: [] },
    parentEnv: { Path: "C:\\Tools", PathExt: ".COM;.EXE;.CMD", Vscode_Nonce: "n", Electron_Run_As_Node: "1" }, fs: fsOf(["C:\\Tools\\agentcli.EXE"]),
  });
  assert.ok(r.ok);
  assert.deepEqual(r.argv, ["C:\\Tools\\agentcli.EXE"]);
  assert.deepEqual(Object.keys(r.env).sort(), ["Path", "PathExt"]);
});

test("bare names resolve against PATH outside the worktree: a planted executable in the cwd must not win", () => {
  const planted = `${WT}/agentcli`;
  const r = resolveLaunch({ ...base, parentEnv: { ...parentEnv, PATH: `:.:relative/bin:${WT}:/usr/bin` }, fs: fsOf([planted, `${WT}/relative/bin/agentcli`, "./agentcli", "relative/bin/agentcli", "agentcli", "/usr/bin/agentcli"]) });
  assert.ok(r.ok);
  assert.deepEqual(r.argv.slice(0, 1), ["/usr/bin/agentcli"]);
  const only = resolveLaunch({ ...base, fs: fsOf([planted]), parentEnv: { PATH: `:.:${WT}` } });
  assert.ok(!only.ok && only.code === "EXECUTABLE_NOT_FOUND");
  const sub = resolveLaunch({ ...base, fs: fsOf([`${WT}/node_modules/.bin/agentcli`]), parentEnv: { PATH: `${WT}/node_modules/.bin` } });
  assert.ok(!sub.ok && sub.code === "EXECUTABLE_NOT_FOUND", "a PATH entry inside the worktree is ignored");
});

test("Windows: a planted executable in the worktree must not win, and PATHEXT excludes .cmd and .bat", () => {
  const env = { PATH: "C:\\wt\\p\\feat;;.;rel;C:\\Tools", PATHEXT: ".BAT;.CMD;.EXE" };
  const fs = fsOf(["C:\\wt\\p\\feat\\agentcli.EXE", "C:\\Tools\\agentcli.CMD", "C:\\Tools\\agentcli.BAT"]);
  assert.equal(resolveExecutable("agentcli", env, "win32", fs, { excludeDirs: ["C:\\wt\\p\\feat"] }), undefined);
  assert.equal(resolveExecutable("agentcli", env, "win32", fsOf(["C:\\Tools\\agentcli.EXE"]), { excludeDirs: ["C:\\wt\\p\\feat"] }), "C:\\Tools\\agentcli.EXE");
  assert.equal(resolveExecutable("AgentCli", { Path: "C:\\Tools" }, "win32", fsOf(["C:\\Tools\\AgentCli.EXE"])), "C:\\Tools\\AgentCli.EXE", "default PATHEXT");
});

test("an absolute command must exist and must not lie inside the worktree", () => {
  const abs = (c: string, files: string[]) => resolveLaunch({ ...base, agent: { ...agent, command: [c] }, fs: fsOf(files) });
  assert.ok(abs("/opt/nvm/bin/agentcli", ["/opt/nvm/bin/agentcli"]).ok);
  const missing = abs("/opt/nvm/bin/agentcli", []);
  assert.ok(!missing.ok && missing.code === "EXECUTABLE_NOT_FOUND");
  const inside = abs(`${WT}/bin/agentcli`, [`${WT}/bin/agentcli`]);
  assert.ok(!inside.ok && inside.code === "EXECUTABLE_NOT_FOUND");
});

test("resolveExecutable refuses names that are not plain", () => {
  for (const n of ["", ".", "..", "a/b", "a b", "../x", "a;b"]) assert.equal(resolveExecutable(n, { PATH: "/usr/bin" }, "linux", fsOf(["/usr/bin/" + n])), undefined, n);
});

test("extension collection names and the shell-integration directory are removed from the launch env", () => {
  const r = resolveLaunch({ ...base, extensionVariableNames: ["MY_KEY"], shellIntegrationDir: "/app/si", parentEnv: { ...parentEnv, ZDOTDIR: "/app/si/zsh", USER_ZDOTDIR: "/u" } });
  assert.ok(r.ok);
  assert.equal("MY_KEY" in r.env, false);
  assert.equal("ZDOTDIR" in r.env, false);
  assert.equal("USER_ZDOTDIR" in r.env, false);
});

test("the platform defaults to process.platform", () => {
  const r = resolveLaunch({ ...base, platform: undefined as unknown as NodeJS.Platform });
  assert.ok(r.ok || r.code === "EXECUTABLE_NOT_FOUND" || r.code === "INVALID_AGENT");
});
