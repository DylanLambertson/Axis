// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCliEnv, buildGitEnv, buildPlainTerminalEnv } from "../src/index.js";

const KEPT = { PATH: "/usr/bin", HOME: "/home/u", LANG: "en_US.UTF-8", TERM: "xterm-256color", SSH_AUTH_SOCK: "/tmp/agent.sock", LC_ALL: "C", FOO: "bar" };

const DENIED = [
  "VSCODE_GIT_ASKPASS_NODE", "VSCODE_GIT_ASKPASS_MAIN", "VSCODE_GIT_IPC_HANDLE", "VSCODE_IPC_HOOK_CLI", "VSCODE_GIT_EDITOR_NODE",
  "VSCODE_NONCE", "VSCODE_INJECTION", "VSCODE_NODE_OPTIONS",
  "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE",
  "GIT_ASKPASS", "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "GIT_EDITOR",
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_EXEC_PATH", "GIT_OBJECT_DIRECTORY",
  "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_GLOBAL",
  "AXIS_VAULT_KEY", "AXIS_DAEMON_PORT",
];

test("every deny-list entry is removed and reported by name only", () => {
  const parent = { ...KEPT, ...Object.fromEntries(DENIED.map((n) => [n, "secret-value"])) };
  const { env, removed } = buildCliEnv(parent, { platform: "linux" });
  for (const n of DENIED) {
    assert.equal(n in env, false, n);
    assert.ok(removed.some((r) => r.name === n), `${n} reported`);
  }
  assert.ok(!JSON.stringify(removed).includes("secret-value"));
});

test("kept variables survive, SSH_AUTH_SOCK included", () => {
  const { env, removed } = buildCliEnv(KEPT, { platform: "linux" });
  assert.deepEqual(env, KEPT);
  assert.deepEqual(removed, []);
});

test("SSH_AUTH_SOCK is not confused with SSH_ASKPASS*", () => {
  assert.equal(buildCliEnv({ SSH_AUTH_SOCK: "x" }, { platform: "linux" }).env["SSH_AUTH_SOCK"], "x");
});

test("deny-list is case-insensitive on every platform", () => {
  for (const platform of ["win32", "linux", "darwin"] as const) {
    const { env } = buildCliEnv(
      { Path: "C:\\x", vscode_nonce: "n", Vscode_Git_Ipc_Handle: "h", electron_run_as_node: "1", git_askpass: "a", Ssh_Askpass: "b", Git_Editor: "e", git_dir: "d", Git_Config_Count: "1" },
      { platform },
    );
    assert.deepEqual(Object.keys(env), ["Path"], platform);
  }
});

test("Windows: case variants of one name collapse and are reported", () => {
  const { env, removed } = buildCliEnv({ Path: "a", PATH: "b" }, { platform: "win32" });
  assert.deepEqual(Object.keys(env), ["Path"]);
  assert.equal(env["Path"], "b");
  assert.ok(removed.some((r) => r.reason === "duplicate-case"));
});

test("POSIX: case variants of one name stay distinct", () => {
  const { env } = buildCliEnv({ foo: "1", FOO: "2" }, { platform: "linux" });
  assert.deepEqual(env, { foo: "1", FOO: "2" });
});

test("prototype-polluting keys never reach the output", () => {
  const parent = JSON.parse('{"__proto__":"x","constructor":"y","prototype":"z","OK":"1"}') as Record<string, string>;
  const { env, removed } = buildCliEnv(parent, { platform: "linux" });
  assert.deepEqual(Object.keys(env), ["OK"]);
  assert.equal(Object.getPrototypeOf(env), Object.prototype);
  assert.equal(({} as Record<string, unknown>)["x"], undefined);
  assert.deepEqual(removed.map((r) => r.reason), ["unsafe-key", "unsafe-key", "unsafe-key"]);
});

test("invalid names and values are dropped", () => {
  const { env, removed } = buildCliEnv({ "A=B": "1", "": "2", GOOD: "ok", BAD: "a\0b", "=C:": "C:\\" }, { platform: "win32" });
  assert.deepEqual(env, { GOOD: "ok" });
  assert.equal(removed.length, 4);
});

test("undefined values are skipped", () => {
  assert.deepEqual(buildCliEnv({ A: undefined, B: "1" }, { platform: "linux" }).env, { B: "1" });
});

test("extension collection names are removed, but essentials are protected", () => {
  const { env, removed } = buildCliEnv(
    { PATH: "/bin", HOME: "/h", MY_EXT_VAR: "v", LC_ALL: "C", KEEP: "1" },
    { platform: "linux", extensionVariableNames: ["my_ext_var", "PATH", "LC_ALL"] },
  );
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", LC_ALL: "C", KEEP: "1" });
  assert.deepEqual(removed, [{ name: "MY_EXT_VAR", reason: "extension-collection" }]);
});

test("envPassthrough cannot re-add a denied name", () => {
  const { env } = buildCliEnv({ GIT_ASKPASS: "a", VSCODE_X: "b", WANTED: "1" }, { platform: "linux", envPassthrough: ["GIT_ASKPASS", "VSCODE_X", "WANTED"] });
  assert.deepEqual(env, { WANTED: "1" });
});

test("secret-looking names are kept by default and stripped on request, passthrough exempts", () => {
  const parent = { ANTHROPIC_API_KEY: "k", GITHUB_TOKEN: "t", DB_PASSWORD: "p", MONKEY: "m", PATH: "/b" };
  assert.deepEqual(Object.keys(buildCliEnv(parent, { platform: "linux" }).env).sort(), Object.keys(parent).sort());
  const r = buildCliEnv(parent, { platform: "linux", stripSecretNames: true, envPassthrough: ["ANTHROPIC_API_KEY"] });
  assert.deepEqual(Object.keys(r.env).sort(), ["ANTHROPIC_API_KEY", "MONKEY", "PATH"]);
  assert.deepEqual(r.removed.map((x) => x.name).sort(), ["DB_PASSWORD", "GITHUB_TOKEN"]);
});

test("NODE_OPTIONS is restored from VSCODE_NODE_OPTIONS", () => {
  const r = buildCliEnv({ VSCODE_NODE_OPTIONS: "--max-old-space-size=4096", NODE_OPTIONS: "--inspect" }, { platform: "linux" });
  assert.equal(r.env["NODE_OPTIONS"], "--max-old-space-size=4096");
  assert.equal("VSCODE_NODE_OPTIONS" in r.env, false);
  assert.equal(buildCliEnv({ NODE_OPTIONS: "--a" }, { platform: "linux" }).env["NODE_OPTIONS"], "--a");
});

test("the input is not mutated", () => {
  const parent = Object.freeze({ VSCODE_NONCE: "n", A: "1" });
  buildCliEnv(parent, { platform: "linux" });
  assert.deepEqual({ ...parent }, { VSCODE_NONCE: "n", A: "1" });
});

test("a CLI env never carries the shell-integration set", () => {
  const si = { VSCODE_INJECTION: "1", VSCODE_NONCE: "n", VSCODE_SHELL_ENV_REPORTING: "1", VSCODE_A11Y_MODE: "0", VSCODE_STABLE: "1", VSCODE_SHELL_LOGIN: "1", VSCODE_PATH_PREFIX: "x" };
  const { env } = buildCliEnv({ ...KEPT, ...si }, { platform: "linux" });
  for (const n of Object.keys(si)) assert.equal(n in env, false);
});

test("plain terminal: SI-ENV is added after the deny-list, only the allowed names", () => {
  const { env, removed } = buildPlainTerminalEnv(KEPT, {
    platform: "linux",
    shellIntegration: { VSCODE_INJECTION: "1", VSCODE_NONCE: "abc", ZDOTDIR: "/z", USER_ZDOTDIR: "/u", GIT_ASKPASS: "x", EVIL: "1", __proto__: "p" } as Record<string, string>,
  });
  assert.equal(env["VSCODE_NONCE"], "abc");
  assert.equal(env["VSCODE_INJECTION"], "1");
  assert.equal(env["ZDOTDIR"], "/z");
  assert.equal("GIT_ASKPASS" in env, false);
  assert.equal("EVIL" in env, false);
  assert.ok(removed.some((r) => r.name === "EVIL" && r.reason === "si-env-not-allowed"));
  assert.ok(removed.some((r) => r.name === "GIT_ASKPASS" && r.reason === "si-env-not-allowed"));
});

test("plain terminal: user env cannot re-add a denied name or a nonce", () => {
  const { env } = buildPlainTerminalEnv(KEPT, {
    platform: "linux",
    userEnv: { VSCODE_NONCE: "forged", GIT_ASKPASS: "x", MY_VAR: "1", FOO: "override" },
  });
  assert.equal("VSCODE_NONCE" in env, false);
  assert.equal("GIT_ASKPASS" in env, false);
  assert.equal(env["MY_VAR"], "1");
  assert.equal(env["FOO"], "override");
});

test("plain terminal: SI-ENV names are matched case-insensitively and stored canonically", () => {
  const { env } = buildPlainTerminalEnv({}, { platform: "win32", shellIntegration: { vscode_nonce: "n" } });
  assert.deepEqual(env, { VSCODE_NONCE: "n" });
});

test("GIT-ENV-1: allow-list only, GIT_TERMINAL_PROMPT=0", () => {
  const { env, removed } = buildGitEnv(
    { PATH: "/b", HOME: "/h", USER: "u", LANG: "C", LC_ALL: "C", TMPDIR: "/t", GIT_DIR: "x", GIT_SSH_COMMAND: "y", GIT_TERMINAL_PROMPT: "1", SSH_AUTH_SOCK: "s", VSCODE_NONCE: "n", path: "z" },
    { platform: "linux" },
  );
  assert.deepEqual(env, { PATH: "/b", HOME: "/h", USER: "u", LANG: "C", LC_ALL: "C", TMPDIR: "/t", GIT_TERMINAL_PROMPT: "0" });
  assert.deepEqual(removed.map((r) => r.name).sort(), ["GIT_DIR", "GIT_SSH_COMMAND", "GIT_TERMINAL_PROMPT", "SSH_AUTH_SOCK", "VSCODE_NONCE", "path"]);
});

test("GIT-ENV-1 on Windows: case-insensitive allow-list and system variables", () => {
  const { env } = buildGitEnv({ Path: "C:\\b", SystemRoot: "C:\\Windows", git_dir: "x", Home: "h" }, { platform: "win32" });
  assert.deepEqual(env, { Path: "C:\\b", SystemRoot: "C:\\Windows", Home: "h", GIT_TERMINAL_PROMPT: "0" });
});

test("GIT-ENV-1 drops prototype-polluting keys", () => {
  const parent = JSON.parse('{"__proto__":"x","PATH":"/b"}') as Record<string, string>;
  const { env } = buildGitEnv(parent, { platform: "linux" });
  assert.deepEqual(Object.keys(env).sort(), ["GIT_TERMINAL_PROMPT", "PATH"]);
});
