// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildToolEnv, sanitizePath, assertEnv, type EnvGrant } from "../src/index.js";

const parent = {
  PATH: "/usr/bin:/bin:relative/bin::/app/wt/node_modules/.bin:/usr/bin",
  HOME: "/home/u", LANG: "en_US.UTF-8", TERM: "xterm-256color", USER: "u", SHELL: "/bin/zsh",
  VSCODE_GIT_ASKPASS_NODE: "/x", VSCODE_NONCE: "n", ELECTRON_RUN_AS_NODE: "1", GIT_ASKPASS: "/a", SSH_ASKPASS: "/s",
  SSH_AUTH_SOCK: "/tmp/agent.sock", GITHUB_TOKEN: "gh-canary", AWS_SECRET_ACCESS_KEY: "aws-canary", STRIPE_API_KEY: "k",
  NODE_OPTIONS: "--require /evil", LD_PRELOAD: "/evil.so", GIT_DIR: "/x", AXIS_INTERNAL: "1", CARGO_HOME: "/c", MY_TOOL_FLAG: "on",
} as const;
const spec = { tool: "run_tests", worktreeId: "wt1" };
const now = 1_000_000;

test("only PATH, HOME, LANG, TERM survive by default", () => {
  const { env } = buildToolEnv(parent, spec, { now, excludeDirs: ["/app/wt"] });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH", "TERM"]);
  assert.equal(env["PATH"], "/usr/bin:/bin", "relative, empty, duplicate and in-worktree entries dropped");
});

test("declared additions come from the parent; sensitive and injection names do not, even when declared", () => {
  const { env, removed } = buildToolEnv(parent, {
    ...spec,
    additions: ["CARGO_HOME", "MY_TOOL_FLAG", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "STRIPE_API_KEY", "SSH_AUTH_SOCK", "GIT_ASKPASS", "VSCODE_NONCE", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "LD_PRELOAD", "GIT_DIR", "AXIS_INTERNAL", "__proto__", "A=B"],
  }, { now });
  assert.equal(env["CARGO_HOME"], "/c");
  assert.equal(env["MY_TOOL_FLAG"], "on");
  for (const n of ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "STRIPE_API_KEY", "SSH_AUTH_SOCK", "GIT_ASKPASS", "VSCODE_NONCE", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "LD_PRELOAD", "GIT_DIR", "AXIS_INTERNAL", "USER", "SHELL"]) {
    assert.equal(Object.hasOwn(env, n), false, n);
  }
  assert.ok(removed.length >= 11);
  assert.equal(JSON.stringify(removed).includes("canary"), false, "values are never reported");
});

test("a scoped grant is the only way a sensitive name appears, and only for its tool, worktree and time", () => {
  const g = (o: Partial<EnvGrant>): EnvGrant => ({ tool: "run_tests", worktreeId: "wt1", name: "NPM_TOKEN", value: "granted-value", expiresAt: now + 1000, ...o });
  const build = (grants: EnvGrant[]) => buildToolEnv(parent, spec, { now, grants }).env;
  assert.equal(build([g({})])["NPM_TOKEN"], "granted-value");
  assert.equal(build([g({ name: "SSH_AUTH_SOCK", value: "/granted.sock" })])["SSH_AUTH_SOCK"], "/granted.sock");
  assert.equal(Object.hasOwn(build([g({ tool: "other" })]), "NPM_TOKEN"), false);
  assert.equal(Object.hasOwn(build([g({ worktreeId: "wt2" })]), "NPM_TOKEN"), false);
  assert.equal(Object.hasOwn(build([g({ expiresAt: now })]), "NPM_TOKEN"), false);
  assert.equal(Object.hasOwn(build([g({ expiresAt: NaN })]), "NPM_TOKEN"), false);
  // Names that load code or reach the editor stay refused even with a grant.
  for (const name of ["VSCODE_GIT_IPC_HANDLE", "ELECTRON_RUN_AS_NODE", "AXIS_X", "LD_PRELOAD", "NODE_OPTIONS", "GIT_DIR", "GIT_CONFIG_COUNT", "__proto__"]) {
    const { env, removed } = buildToolEnv(parent, spec, { now, grants: [g({ name })] });
    assert.equal(Object.hasOwn(env, name), false, name);
    assert.ok(removed.some((r) => r.reason === "grant-refused"), name);
  }
});

test("win32 matches names case-insensitively and does not duplicate them", () => {
  const { env } = buildToolEnv({ Path: "C:\\Windows;relative", HOME: "C:\\Users\\u", Lang: "C" }, spec, { now, platform: "win32" });
  assert.deepEqual(env, { PATH: "C:\\Windows", HOME: "C:\\Users\\u", LANG: "C" });
});

test("hostile values and the helpers", () => {
  const { env } = buildToolEnv({ PATH: "/bin", HOME: "relative", LANG: "a\0b", TERM: "x".repeat(100) }, spec, { now });
  assert.deepEqual(env, { PATH: "/bin" });
  assert.equal(sanitizePath("/a:/b:/a/inner", "linux", ["/a"]), "/b");
  assert.throws(() => assertEnv({ A: 1 }));
  assert.throws(() => assertEnv({ "A=B": "x" }));
  assert.throws(() => assertEnv({ A: "x\0" }));
  assert.throws(() => assertEnv(null));
  assertEnv({ A: "ok" });
});
