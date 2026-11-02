// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLaunch } from "../src/index.js";

const agent = { id: "a", label: "A", command: ["agentcli", "run"], args: ["--x"], envPassthrough: ["MY_KEY"] };
const parentEnv = { PATH: "/b", HOME: "/h", SSH_AUTH_SOCK: "/s", VSCODE_NONCE: "n", GIT_ASKPASS: "g", MY_KEY: "k" };
const base = { agent, worktreeRoot: "/data/wt/proj-1/feat", trusted: true, parentEnv, platform: "linux" as const };

test("trusted launch returns argv, cwd, env and no shell integration", () => {
  const r = resolveLaunch(base);
  assert.ok(r.ok);
  assert.deepEqual(r.argv, ["agentcli", "run", "--x"]);
  assert.equal(r.cwd, "/data/wt/proj-1/feat");
  assert.deepEqual(r.env, { PATH: "/b", HOME: "/h", SSH_AUTH_SOCK: "/s", MY_KEY: "k" });
  assert.equal(r.shellIntegration, false);
  assert.ok(r.removed.some((x) => x.name === "VSCODE_NONCE"));
  assert.equal(typeof r.argv, "object");
});

test("an untrusted workspace is refused, for anything other than exactly true", () => {
  for (const trusted of [false, undefined, null, 0, "true", 1] as unknown[]) {
    const r = resolveLaunch({ ...base, trusted: trusted as boolean });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "UNTRUSTED");
  }
});

test("the untrusted refusal comes before any other work", () => {
  const r = resolveLaunch({ ...base, trusted: false, agent: "garbage", worktreeRoot: "rel" });
  assert.ok(!r.ok && r.code === "UNTRUSTED");
});

test("an invalid agent is refused, including a shell string or relative path command", () => {
  for (const a of ["x", null, { ...agent, command: "sh -c x" }, { ...agent, command: ["./sh"] }, { ...agent, envPassthrough: ["GIT_ASKPASS"] }]) {
    const r = resolveLaunch({ ...base, agent: a });
    assert.ok(!r.ok && r.code === "INVALID_AGENT");
  }
});

test("the worktree root must be an absolute, normalised path", () => {
  for (const w of ["", "relative", "/a/../b", "/a/./b", "/a//b", "/a\0b", "."]) {
    const r = resolveLaunch({ ...base, worktreeRoot: w });
    assert.ok(!r.ok && r.code === "BAD_WORKTREE", w);
  }
  assert.ok(resolveLaunch({ ...base, worktreeRoot: "/a/b/" }).ok);
});

test("Windows roots are checked with Windows rules, env names case-insensitively", () => {
  const r = resolveLaunch({ ...base, platform: "win32", worktreeRoot: "C:\\wt\\p\\feat", parentEnv: { Path: "p", Vscode_Nonce: "n", Electron_Run_As_Node: "1" } });
  assert.ok(r.ok);
  assert.deepEqual(r.env, { Path: "p" });
  assert.ok(!resolveLaunch({ ...base, platform: "win32", worktreeRoot: "C:\\wt\\..\\x" }).ok);
});

test("extension collection names are removed from the launch env", () => {
  const r = resolveLaunch({ ...base, extensionVariableNames: ["MY_KEY"] });
  assert.ok(r.ok);
  assert.equal("MY_KEY" in r.env, false);
});

test("the agent object is re-validated: extra keys such as a shell flag are refused", () => {
  const r = resolveLaunch({ ...base, agent: { ...agent, shell: true } });
  assert.ok(!r.ok && r.code === "INVALID_AGENT");
});
