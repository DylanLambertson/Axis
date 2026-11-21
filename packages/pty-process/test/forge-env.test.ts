// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-D2 slice 1b: what `gh` is given (docs/design/forge-pr-list.md §1, §4, §7), without a process.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildForgeEnv, classifyForgeStderr, FORGE_CONFIG_FILES, FORGE_CONFIG_YML, FORGE_HOSTS_YML, forgeListArgv, forgeVersionArgv, ghAtLeast, MIN_GH_VERSION, parseGhVersion } from "../src/index.js";

const JSON_FIELDS = "--json=number,title,headRefName,author,isDraft,isCrossRepository,headRepositoryOwner,reviewDecision,statusCheckRollup";

test("the closed templates: values joined to their flags, --author=@me unless the gate's fallback is configured", () => {
  assert.deepEqual(forgeListArgv("/opt/gh", "acme", "app", true), ["/opt/gh", "pr", "list", "--repo=github.com/acme/app", "--state=open", "--author=@me", "--limit=50", JSON_FIELDS]);
  assert.deepEqual(forgeListArgv("/opt/gh", "acme", "app", false), ["/opt/gh", "pr", "list", "--repo=github.com/acme/app", "--state=open", "--limit=50", JSON_FIELDS]);
  assert.deepEqual(forgeVersionArgv("/opt/gh"), ["/opt/gh", "--version"]);
});

test("the version line is parsed strictly: the whole first line, nothing before or after it", () => {
  assert.deepEqual(parseGhVersion("gh version 2.40.0 (2023-12-07)\nhttps://github.com/cli/cli/releases/tag/v2.40.0\n"), [2, 40, 0]);
  assert.deepEqual(parseGhVersion("gh version 2.62.1\n"), [2, 62, 1]);
  assert.deepEqual(parseGhVersion("gh version 3.0.10 (2026-01-01)\r\n"), [3, 0, 10]);
  for (const bad of ["", "\x1b[1mgh version 2.45.0\n", " gh version 2.45.0\n", "gh version 2.45.0 " + "x".repeat(5000), "gh version 2.45\n", "GH version 2.45.0\n", "gh version 2.45.0-rc1\n", "gh version 2.45.0 (yesterday)\n", "gh version v2.45.0\n", "gh  version 2.45.0\n", "gh version 12345.0.0\n", "warning\ngh version 2.45.0\n"]) {
    assert.equal(parseGhVersion(bad), undefined, JSON.stringify(bad.slice(0, 40)));
  }
});

test("the minimum is compared numerically, field by field", () => {
  assert.deepEqual(MIN_GH_VERSION, [2, 40, 0]);
  for (const ok of [[2, 40, 0], [2, 40, 1], [2, 41, 0], [3, 0, 0]] as const) assert.equal(ghAtLeast(ok, MIN_GH_VERSION), true, ok.join("."));
  for (const old of [[2, 39, 9], [2, 4, 0], [1, 99, 99], [2, 0, 40]] as const) assert.equal(ghAtLeast(old, MIN_GH_VERSION), false, old.join("."));
});

test("the generated configuration: version 1, no aliases, socket, user or token, nothing interactive", () => {
  assert.equal(FORGE_CONFIG_YML, 'version: "1"\ngit_protocol: https\nprompt: disabled\npager: ""\nbrowser: ""\neditor: ""\n');
  assert.equal(FORGE_HOSTS_YML, "github.com:\n    git_protocol: https\n");
  assert.deepEqual(Object.keys(FORGE_CONFIG_FILES).sort(), ["config.yml", "hosts.yml"]);
  const all = Object.values(FORGE_CONFIG_FILES).join("\n");
  for (const key of ["aliases", "http_unix_socket", "oauth_token", "user:", "users:"]) assert.ok(!all.includes(key), key);
});

const DIRS = { cwd: "/c/cwd", config: "/c/config", data: "/c/data", state: "/c/state", cache: "/c/cache" };
const SET = {
  GH_CONFIG_DIR: "/c/config", XDG_CONFIG_HOME: "/c/config", XDG_DATA_HOME: "/c/data", XDG_STATE_HOME: "/c/state", XDG_CACHE_HOME: "/c/cache",
  GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1", CLICOLOR: "0",
};
const HOSTILE: Record<string, string | undefined> = {
  PATH: "/usr/bin", HOME: "/home/u", USER: "u", LOGNAME: "u", TMPDIR: "/tmp/u", LANG: "C.UTF-8", LC_ALL: "C", LC_CTYPE: "C",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus", XDG_RUNTIME_DIR: "/run/user/1", HTTPS_PROXY: "http://p:1", https_proxy: "http://p:2", NO_PROXY: "x", SSL_CERT_FILE: "/etc/ca.pem", SSL_CERT_DIR: "/etc/ca",
  GH_TOKEN: "t", GITHUB_TOKEN: "t", GH_ENTERPRISE_TOKEN: "t", GITHUB_ENTERPRISE_TOKEN: "t", GH_REPO: "evil/x", GH_PATH: "/x", GH_HOST: "evil.example", GH_CONFIG_DIR: "/home/u/.config/gh",
  GH_PAGER: "x", PAGER: "x", GH_BROWSER: "x", BROWSER: "x", GH_EDITOR: "x", EDITOR: "x", VISUAL: "x", GIT_EDITOR: "x", GH_DEBUG: "api", DEBUG: "1", GH_FORCE_TTY: "1", CLICOLOR_FORCE: "1",
  GODEBUG: "x", GOFLAGS: "x", LD_PRELOAD: "/x.so", DYLD_INSERT_LIBRARIES: "/x", XDG_DATA_HOME: "/home/u/.local/share", NO_COLOR: "0", AXIS_CANARY_7: "c", path: "/lower", LC_bad: "x", LC_: "x",
  SYSTEMROOT: "C:\\Windows", APPDATA: "C:\\a", TEMP: "C:\\t", UNSET: undefined, SHELL: "/bin/zsh",
};

test("the environment is built from the allow-list: exact names, the pinned directories and switches, nothing else", () => {
  const linux = buildForgeEnv(HOSTILE, DIRS, "linux");
  assert.deepEqual({ ...linux }, {
    PATH: "/usr/bin", HOME: "/home/u", USER: "u", LOGNAME: "u", TMPDIR: "/tmp/u", LANG: "C.UTF-8", LC_ALL: "C", LC_CTYPE: "C",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus", XDG_RUNTIME_DIR: "/run/user/1", HTTPS_PROXY: "http://p:1", https_proxy: "http://p:2", NO_PROXY: "x", SSL_CERT_FILE: "/etc/ca.pem", SSL_CERT_DIR: "/etc/ca",
    ...SET,
  });
  assert.equal(Object.getPrototypeOf(linux), null, "a key planted on Object.prototype is not an entry");
  const mac = buildForgeEnv(HOSTILE, DIRS, "darwin");
  assert.equal(mac["DBUS_SESSION_BUS_ADDRESS"], undefined, "the keyring bus names are Linux only");
  assert.equal(mac["XDG_RUNTIME_DIR"], undefined);
  assert.equal(mac["SYSTEMROOT"], undefined, "the Windows names are Windows only");
  const win = buildForgeEnv(HOSTILE, DIRS, "win32");
  assert.deepEqual([win["SYSTEMROOT"], win["APPDATA"], win["TEMP"], win["DBUS_SESSION_BUS_ADDRESS"]], ["C:\\Windows", "C:\\a", "C:\\t", undefined]);
});

test("a value holding NUL is not copied; an inherited name is not copied", () => {
  const base = Object.create({ HTTPS_PROXY: "http://inherited:1" }) as Record<string, string>;
  base["PATH"] = "/usr/bin\0/evil";
  base["HOME"] = "/home/u";
  const env = buildForgeEnv(base, DIRS, "linux");
  assert.equal(env["PATH"], undefined);
  assert.equal(env["HTTPS_PROXY"], undefined);
  assert.equal(env["HOME"], "/home/u");
});

test("stderr is classified into a closed value; exit 0 is none whatever stderr says", () => {
  const cases: Array<[number | null, string, string]> = [
    [0, "HTTP 401: Bad credentials", "none"],
    [1, "HTTP 401: Bad credentials (https://api.github.com/graphql)", "auth_missing"],
    [4, "To get started with GitHub CLI, please run:  gh auth login", "auth_missing"],
    [1, "http 401 lower case is not the marker", "other"],
    [2, "HTTP 401", "other"],
    [4, "failed to get secret: The name org.freedesktop.secrets was not provided by any .service files", "keyring"],
    [1, "Secret Service: timeout while trying to get secret from keyring", "keyring"],
    [1, "couldn't find oauth token for github.com", "keyring"],
    [1, "failed to migrate config: cowardly refusing to continue", "keyring"],
    [1, "GraphQL: Could not resolve to a Repository with the name 'acme/app'. (repository)", "repo_missing"],
    [1, "Post \"https://api.github.com/graphql\": dial tcp: lookup api.github.com: no such host", "network"],
    [1, "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\nconnect: connection refused", "network"],
    [1, "net/http: TLS handshake timeout", "network"],
    [1, "something else entirely", "other"],
    [null, "", "other"],
  ];
  for (const [exit, stderr, want] of cases) assert.equal(classifyForgeStderr(exit, stderr), want, `${exit} ${stderr}`);
});
