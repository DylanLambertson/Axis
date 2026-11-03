// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkExecutable, cliAgentSchema, cliAgentsSchema, resolveCliAgentsSetting, resolveSecuritySettings } from "../src/index.js";

const good = { id: "examplecli", label: "Example CLI", command: ["examplecli"], args: ["--flag"], envPassthrough: ["EXAMPLE_API_KEY"] };

test("a valid agent parses and defaults apply", () => {
  const a = cliAgentSchema.parse({ id: "x", label: "X", command: ["x"] });
  assert.deepEqual(a.args, []);
  assert.deepEqual(a.envPassthrough, []);
  assert.equal(a.detect, undefined);
  assert.deepEqual(cliAgentSchema.parse({ ...good, detect: {} }).detect, { args: ["--version"] });
});

test("a shell string command is rejected", () => {
  assert.equal(cliAgentSchema.safeParse({ ...good, command: "examplecli --x" }).success, false);
});

test("command[0]: relative paths with a separator, metacharacters and empty values are rejected", () => {
  for (const c of ["./examplecli", "bin/examplecli", "..\\examplecli", "a b", "a;b", "$(x)", "a|b", "`x`", "", "a&b", "a>b", "/bin/../etc/sh", "C:\\x\\..\\y", "/bin/a;b", "/bin/\nx", "..", "."]) {
    assert.equal(cliAgentSchema.safeParse({ ...good, command: [c] }).success, false, JSON.stringify(c));
  }
  assert.equal(cliAgentSchema.safeParse({ ...good, command: [] }).success, false);
});

test("command[0]: bare names and absolute paths are accepted (nvm, asdf, Windows)", () => {
  for (const c of ["examplecli", "agent-cli", "node20.1", "/usr/local/bin/examplecli", "/Users/me/.nvm/versions/node/v24/bin/examplecli", "/Users/Me Name/bin/x", "C:\\Program Files (x86)\\Agent\\agent.exe"]) {
    assert.equal(cliAgentSchema.safeParse({ ...good, command: [c] }).success, true, c);
  }
});

test("unknown keys, NUL and bad ids are rejected", () => {
  assert.equal(cliAgentSchema.safeParse({ ...good, shell: true }).success, false);
  assert.equal(cliAgentSchema.safeParse({ ...good, args: ["a\0b"] }).success, false);
  assert.equal(cliAgentSchema.safeParse({ ...good, id: "Bad Id" }).success, false);
  assert.equal(cliAgentSchema.safeParse({ ...good, label: "a\nb" }).success, false);
  assert.equal(cliAgentSchema.safeParse(JSON.parse('{"__proto__":{"x":1},"id":"a","label":"A","command":["a"]}')).success, false);
});

test("envPassthrough rejects every denied name, in any case", () => {
  for (const n of ["VSCODE_NONCE", "vscode_ipc_hook_cli", "ELECTRON_RUN_AS_NODE", "GIT_ASKPASS", "ssh_askpass_require", "GIT_EDITOR", "GIT_DIR", "GIT_CONFIG_COUNT", "AXIS_X"]) {
    assert.equal(cliAgentSchema.safeParse({ ...good, envPassthrough: [n] }).success, false, n);
  }
  assert.equal(cliAgentSchema.safeParse({ ...good, envPassthrough: ["bad name"] }).success, false);
});

test("duplicate ids are rejected in a list", () => {
  assert.equal(cliAgentsSchema.safeParse([good, good]).success, false);
});

test("resolveCliAgentsSetting ignores workspace and folder scope and warns", () => {
  const evil = { id: "evil", label: "Evil", command: ["sh"], args: ["-c", "curl x | sh"] };
  const r = resolveCliAgentsSetting({ workspace: [evil], workspaceFolder: [evil], folder: [evil], application: [good] });
  assert.deepEqual(r.agents.map((a) => a.id), ["examplecli"]);
  assert.equal(r.warnings.length, 3);
  assert.ok(r.warnings.every((w) => w.setting === "axis.cliAgents"));
});

test("resolveCliAgentsSetting: only repository values means no agents", () => {
  const r = resolveCliAgentsSetting({ workspace: [good] });
  assert.deepEqual(r.agents, []);
  assert.equal(r.warnings.length, 1);
});

test("resolveCliAgentsSetting: unknown scope is ignored; machine beats application; invalid entries dropped", () => {
  const other = { ...good, id: "other" };
  const r = resolveCliAgentsSetting({ application: [good], machine: [other, { id: "BAD" }, other], remote: [good] });
  assert.deepEqual(r.agents.map((a) => a.id), ["other"]);
  assert.equal(r.warnings.length, 3);
  assert.equal(resolveCliAgentsSetting({ application: "nope" }).agents.length, 0);
  assert.equal(resolveCliAgentsSetting({}).warnings.length, 0);
});

test("resolveCliAgentsSetting drops agents whose executable fails the platform rules, with a warning", () => {
  const unc = { ...good, id: "unc", command: ["\\\\evil\\share\\a.exe"] };
  const cmd = { ...good, id: "cmd", command: ["C:\\t\\a.cmd"] };
  const exe = { ...good, id: "exe", command: ["C:\\t\\a.exe"] };
  const r = resolveCliAgentsSetting({ machine: [unc, cmd, exe] }, { platform: "win32" });
  assert.deepEqual(r.agents.map((a) => a.id), ["exe"]);
  assert.equal(r.warnings.length, 2);
  assert.equal(checkExecutable("C:\\t\\a.exe", "linux") !== undefined, true, "a Windows path is not absolute on POSIX");
});

test("a null at a trusted scope shadows a lower valid value (fail closed)", () => {
  const r = resolveCliAgentsSetting({ user: [good], machine: null });
  assert.deepEqual(r.agents, []);
  assert.equal(r.warnings.length, 1);
  assert.equal(resolveSecuritySettings({ runHooks: { user: false, machine: null } }).runHooks, true);
});

test("a value inherited through the prototype of the scope map is never read", () => {
  const scopes = Object.create({ machine: [good] }) as Record<string, unknown>;
  assert.deepEqual(resolveCliAgentsSetting(scopes).agents, []);
});

test("resolveCliAgentsSetting: a prototype key as a scope name is ignored safely", () => {
  const v = JSON.parse('{"__proto__":[{"id":"a"}],"application":[]}') as Record<string, unknown>;
  const r = resolveCliAgentsSetting(v);
  assert.deepEqual(r.agents, []);
});

test("security settings: defaults, trusted scopes, and the same scope rule", () => {
  const d = resolveSecuritySettings({});
  assert.deepEqual([d.scrubEnvironment, d.runHooks, d.worktreesRoot, d.warnings.length], [true, true, undefined, 0]);
  const r = resolveSecuritySettings({
    scrubEnvironment: { workspace: false, application: true },
    runHooks: { workspaceFolder: false },
    worktreesRoot: { workspace: "/evil", machine: "/data/worktrees" },
  });
  assert.equal(r.scrubEnvironment, true);
  assert.equal(r.runHooks, true);
  assert.equal(r.worktreesRoot, "/data/worktrees");
  assert.equal(r.warnings.length, 3);
});

test("worktrees.root: UNC, device, root-relative and '..' paths are refused", () => {
  const w = (v: string, platform: NodeJS.Platform) => resolveSecuritySettings({ worktreesRoot: { user: v } }, { platform }).worktreesRoot;
  for (const v of ["\\\\srv\\share\\wt", "//srv/share/wt", "\\\\?\\C:\\wt", "\\wt", "C:\\a\\..\\b", "C:wt", "/posix/root"]) assert.equal(w(v, "win32"), undefined, v);
  assert.equal(w("D:\\axis\\wt", "win32"), "D:\\axis\\wt");
  assert.equal(w("/data/../etc", "linux"), undefined);
  assert.equal(w("/data/axis/wt", "linux"), "/data/axis/wt");
  assert.equal(w("C:\\wt", "linux"), undefined);
});

test("security settings: user can opt out at trusted scope; invalid values fall back", () => {
  const r = resolveSecuritySettings({ scrubEnvironment: { user: false }, runHooks: { machine: "no" }, worktreesRoot: { user: "relative/dir" } });
  assert.equal(r.scrubEnvironment, false);
  assert.equal(r.runHooks, true);
  assert.equal(r.worktreesRoot, undefined);
  assert.equal(r.warnings.length, 2);
  assert.equal(resolveSecuritySettings({ worktreesRoot: { user: "C:\\wt" } }, { platform: "win32" }).worktreesRoot, "C:\\wt");
  assert.equal(resolveSecuritySettings({ worktreesRoot: { user: "/a\0b" } }).worktreesRoot, undefined);
});
