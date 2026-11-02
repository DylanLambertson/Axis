// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCliEnv, buildGitEnv, buildPlainTerminalEnv, classifyDeniedName, gitConfigFileWarnings } from "../src/index.js";

const KEPT = { PATH: "/usr/bin", HOME: "/home/u", LANG: "en_US.UTF-8", TERM: "xterm-256color", SSH_AUTH_SOCK: "/tmp/agent.sock", LC_ALL: "C", FOO: "bar" };

const DENIED = [
  "VSCODE_GIT_ASKPASS_NODE", "VSCODE_GIT_ASKPASS_MAIN", "VSCODE_GIT_IPC_HANDLE", "VSCODE_IPC_HOOK_CLI", "VSCODE_GIT_EDITOR_NODE",
  "VSCODE_NONCE", "VSCODE_INJECTION", "VSCODE_NODE_OPTIONS",
  "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE",
  "GIT_ASKPASS", "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "GIT_EDITOR",
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_EXEC_PATH", "GIT_OBJECT_DIRECTORY",
  "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_12", "GIT_CONFIG_PARAMETERS", "GIT_NAMESPACE", "GIT_TEMPLATE_DIR", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "USER_ZDOTDIR",
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

test("GIT_CONFIG narrowing: injectors are removed in any case, the user's own config locations stay", () => {
  const { env, removed } = buildCliEnv(
    {
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.x", GIT_CONFIG_VALUE_0: "y", GIT_CONFIG_PARAMETERS: "'a=b'", git_config_key_0: "k", Git_Config_Value_9: "v",
      GIT_CONFIG_GLOBAL: "/home/u/.gitconfig-work", GIT_CONFIG_SYSTEM: "/etc/gitconfig-x", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIGURATION: "kept", PATH: "/b",
    },
    { platform: "linux" },
  );
  assert.deepEqual(Object.keys(env).sort(), ["GIT_CONFIGURATION", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM", "PATH"]);
  assert.deepEqual(removed.map((r) => r.reason), Array(6).fill("git-config"));
  assert.equal(classifyDeniedName("git_config_global"), undefined);
  assert.equal(classifyDeniedName("GIT_CONFIG_COUNT"), "git-config");
});

test("GIT-ENV-1 still drops every GIT_CONFIG variable, including the kept-for-CLI ones", () => {
  const { env } = buildGitEnv({ PATH: "/b", GIT_CONFIG_GLOBAL: "/g", GIT_CONFIG_SYSTEM: "/s", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "k", GIT_CONFIG_PARAMETERS: "p" }, { platform: "linux" });
  assert.deepEqual(Object.keys(env).sort(), ["GIT_TERMINAL_PROMPT", "PATH"]);
});

test("gitConfigFileWarnings warns for a config file inside a managed worktree, and only then", () => {
  const roots = ["/data/wt/p-1/feat", "/data/wt/p-1/other"];
  assert.deepEqual(gitConfigFileWarnings({ GIT_CONFIG_GLOBAL: "/home/u/.gitconfig", GIT_CONFIG_SYSTEM: "/etc/gitconfig" }, roots, "linux"), []);
  const w = gitConfigFileWarnings({ GIT_CONFIG_GLOBAL: "/data/wt/p-1/feat/sub/.gitconfig", git_config_system: "/data/wt/p-1/other" }, roots, "linux");
  assert.deepEqual(w.map((x) => [x.name, x.worktreeRoot]), [["GIT_CONFIG_GLOBAL", "/data/wt/p-1/feat"], ["GIT_CONFIG_SYSTEM", "/data/wt/p-1/other"]]);
  assert.equal(gitConfigFileWarnings({ GIT_CONFIG_GLOBAL: "/data/wt/p-1/feature/.gitconfig" }, roots, "linux").length, 0, "prefix siblings are not inside");
  assert.equal(gitConfigFileWarnings({ GIT_CONFIG_GLOBAL: "rel/.gitconfig" }, roots, "linux").length, 1, "a relative path resolves against the cwd, a worktree");
  assert.equal(gitConfigFileWarnings({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "" }, roots, "linux").length, 0);
  assert.equal(gitConfigFileWarnings({ GIT_CONFIG_GLOBAL: "C:\\DATA\\WT\\P-1\\Feat\\.gitconfig" }, ["c:\\data\\wt\\p-1\\feat"], "win32").length, 1);
});

test("non-string values are dropped as invalid by every builder and never throw", () => {
  const bad = { A: 1, B: null, C: { x: 1 }, D: ["a"], E: true, GOOD: "ok" } as unknown as Record<string, string>;
  const cli = buildCliEnv(bad, { platform: "linux" });
  assert.deepEqual(cli.env, { GOOD: "ok" });
  assert.deepEqual(cli.removed.map((r) => r.name).sort(), ["A", "B", "C", "D", "E"]);
  assert.ok(cli.removed.every((r) => r.reason === "invalid"));
  const git = buildGitEnv({ PATH: 1, HOME: "/h" } as unknown as Record<string, string>, { platform: "linux" });
  assert.deepEqual(git.env, { HOME: "/h", GIT_TERMINAL_PROMPT: "0" });
  assert.deepEqual(git.removed, [{ name: "PATH", reason: "invalid" }]);
  const plain = buildPlainTerminalEnv({ PATH: "/b" }, { platform: "linux", userEnv: bad, shellIntegration: { VSCODE_NONCE: 5, VSCODE_INJECTION: "1" } as unknown as Record<string, string> });
  assert.deepEqual(plain.env, { PATH: "/b", GOOD: "ok", VSCODE_INJECTION: "1" });
  assert.ok(plain.removed.some((r) => r.name === "VSCODE_NONCE" && r.reason === "invalid"));
});

test("USER_ZDOTDIR is always removed; ZDOTDIR only when it points inside Axis's shell-integration directory", () => {
  const parent = { PATH: "/b", USER_ZDOTDIR: "/home/u", ZDOTDIR: "/app/shell-integration/zsh" };
  const a = buildCliEnv(parent, { platform: "linux", shellIntegrationDir: "/app/shell-integration" });
  assert.deepEqual(a.env, { PATH: "/b" });
  assert.deepEqual(a.removed.map((r) => r.reason), ["shell-integration", "shell-integration"]);
  const b = buildCliEnv({ PATH: "/b", ZDOTDIR: "/home/u/.zsh", USER_ZDOTDIR: "x" }, { platform: "linux", shellIntegrationDir: "/app/shell-integration" });
  assert.deepEqual(b.env, { PATH: "/b", ZDOTDIR: "/home/u/.zsh" });
  assert.equal(buildCliEnv({ ZDOTDIR: "/app/shell-integration/zsh" }, { platform: "linux" }).env["ZDOTDIR"], "/app/shell-integration/zsh", "no directory given: kept");
  assert.equal(buildCliEnv({ ZDOTDIR: "/app/shell-integration-evil/zsh" }, { platform: "linux", shellIntegrationDir: "/app/shell-integration" }).env["ZDOTDIR"], "/app/shell-integration-evil/zsh");
  // Plain terminals: an inherited USER_ZDOTDIR is removed, Axis's own SI-ENV value is added after.
  const p = buildPlainTerminalEnv({ USER_ZDOTDIR: "/inherited" }, { platform: "linux", shellIntegration: { USER_ZDOTDIR: "/real", ZDOTDIR: "/z" } });
  assert.deepEqual(p.env, { USER_ZDOTDIR: "/real", ZDOTDIR: "/z" });
});

test("user pass-through: LD_PRELOAD, DYLD_*, NODE_OPTIONS, GIT_SSH_COMMAND are the user's own environment and stay", () => {
  const parent = { LD_PRELOAD: "/lib/x.so", DYLD_INSERT_LIBRARIES: "/lib/y.dylib", NODE_OPTIONS: "--max-old-space-size=2048", GIT_SSH_COMMAND: "ssh -i k", PATH: "/b" };
  assert.deepEqual(buildCliEnv(parent, { platform: "linux" }).env, parent);
});

test("Windows: a case variant of a denied name in userEnv is removed and case duplicates in userEnv are reported", () => {
  const r = buildPlainTerminalEnv({ Path: "p" }, { platform: "win32", userEnv: { vscode_nonce: "forged", PATH: "q", Path: "r", Foo: "1", FOO: "2" } });
  assert.equal("vscode_nonce" in r.env, false);
  assert.deepEqual(r.env, { Path: "r", Foo: "2" });
  assert.ok(r.removed.some((x) => x.reason === "duplicate-case" && x.name === "Path"));
  assert.ok(r.removed.some((x) => x.reason === "duplicate-case" && x.name === "FOO"));
});

test("prototype-polluting keys never reach the output", () => {
  const parent = JSON.parse('{"__proto__":"x","constructor":"y","prototype":"z","OK":"1"}') as Record<string, string>;
  const { env, removed } = buildCliEnv(parent, { platform: "linux" });
  assert.deepEqual(Object.keys(env), ["OK"]);
  assert.equal(Object.getPrototypeOf(env), Object.prototype);
  assert.equal(({} as Record<string, unknown>)["x"], undefined);
  assert.deepEqual(removed.map((r) => r.reason), ["unsafe-key", "unsafe-key", "unsafe-key"]);
  assert.deepEqual(removed.map((r) => r.name).sort(), ["__proto__", "constructor", "prototype"]);
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
  const { env, removed } = buildGitEnv(parent, { platform: "linux" });
  assert.deepEqual(Object.keys(env).sort(), ["GIT_TERMINAL_PROMPT", "PATH"]);
  assert.deepEqual(removed, [{ name: "__proto__", reason: "unsafe-key" }]);
});
