// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BYPASS_FLAGS, BYPASS_WORDS, MAX_WARNINGS, cliOf, decideCliMessaging } from "../src/messages/enable-rule.js";

// PV-M7 slice 1: the CLI messaging enable rule (endpoint design section 6, M-3). Literal argv, never read from the tables,
// so removing a row or a word fails a test by name.

const none = (): boolean => false;
const decide = (argv: string[], o: { marked?: boolean; exists?: (s: readonly string[]) => boolean } = {}) =>
  decideCliMessaging({ argv, bypassesPrompts: o.marked === true, exists: o.exists ?? none });
const refusedBy = (argv: string[]): string => {
  const d = decide(argv);
  return d.allowed ? "allowed" : d.rule;
};

test("the user's marking refuses first, whatever the argv", () => {
  assert.deepEqual(decide(["claude", "--model", "x"], { marked: true }), { allowed: false, rule: "user_marked" });
});

test("every known flag refuses, in both forms, short and long, case-folded values, Codex -c values with TOML quotes", () => {
  const cases: [string[], string][] = [
    [["claude", "--dangerously-skip-permissions"], "claude.dangerously-skip-permissions"],
    [["/usr/local/bin/claude", "--allow-dangerously-skip-permissions"], "claude.allow-dangerously-skip-permissions"],
    [["claude", "--permission-mode", "bypassPermissions"], "claude.permission-mode.bypassPermissions"],
    [["claude", "--permission-mode=BYPASSPERMISSIONS"], "claude.permission-mode.bypassPermissions"],
    [["claude", "--permission-mode", "auto"], "claude.permission-mode.auto"],
    [["claude", "--permission-mode", "acceptEdits"], "claude.permission-mode.acceptEdits"],
    [["codex", "--dangerously-bypass-approvals-and-sandbox"], "codex.dangerously-bypass-approvals-and-sandbox"],
    [["codex", "--ask-for-approval", "never"], "codex.ask-for-approval.never"],
    [["codex", "-a", "never"], "codex.ask-for-approval.never"],
    [["codex", "--ask-for-approval=never"], "codex.ask-for-approval.never"],
    [["codex", "--sandbox", "danger-full-access"], "codex.sandbox.danger-full-access"],
    [["codex", "-s", "danger-full-access"], "codex.sandbox.danger-full-access"],
    [["codex", "--approve-for-me"], "codex.approve-for-me"],
    [["codex", "-c", 'approval_policy="never"'], "codex.config.approval_policy"],
    [["codex", "--config", "approval_policy = 'never'"], "codex.config.approval_policy"],
    [["codex", "-c", 'sandbox_mode="danger-full-access"'], "codex.config.sandbox_mode"],
    [["C:\\tools\\codex.exe", "-a", "NEVER"], "codex.ask-for-approval.never"],
  ];
  for (const [argv, rule] of cases) assert.equal(refusedBy(argv), rule, argv.join(" "));
  assert.equal(new Set(BYPASS_FLAGS.map((r) => r.id)).size, BYPASS_FLAGS.length, "row ids are unique");
  for (const r of BYPASS_FLAGS) assert.ok(/^(Claude Code 2\.1\.332|codex-cli 0\.166\.0) --help$/.test(r.source), `${r.id} names the help it came from`);
});

test("the pattern rule refuses an unknown bypass-like argument for any CLI, a wrapper included (fail closed)", () => {
  for (const arg of ["--yolo", "--Dangerously-Anything", "--bypass-x", "--skip-permissions", "--no-confirm", "--auto_approve", "--full-auto", "--approval-mode=yolo", "--no-sandbox", "sandbox=false", "danger-full-access"]) {
    assert.equal(refusedBy(["gemini", arg]), "bypass_pattern", arg);
  }
  assert.equal(refusedBy(["mywrapper", "--yolo"]), "bypass_pattern", "a wrapper: the pattern applies to every argument");
  assert.deepEqual([...BYPASS_WORDS].sort(), ["approval-mode", "auto-approve", "bypass", "danger-full-access", "dangerously", "full-auto", "no-confirm", "no-sandbox", "sandbox=false", "skip-permissions", "yolo"]);
});

test("an ordinary launch is allowed: other permission modes, other sandboxes, other flags", () => {
  for (const argv of [["claude"], ["claude", "--model", "opus"], ["claude", "-p", "--output-format", "json", "summarise"], ["codex", "-a", "on-request"], ["codex", "-s", "workspace-write"], ["codex", "-c", 'model="o3"']]) {
    assert.deepEqual(decide(argv), { allowed: true, warnings: [] }, argv.join(" "));
  }
});

test("the executable's CLI: base name, Windows extensions dropped, case-folded", () => {
  assert.deepEqual([cliOf("/opt/x/Claude"), cliOf("C:\\a\\codex.CMD"), cliOf("codex.js"), cliOf("node")], ["claude", "codex", "codex", "node"]);
});

test("repository configuration: a warning per present file of that CLI (all CLIs' rows for an unknown executable); a refuse row refuses", () => {
  const has = (...paths: string[]) => (s: readonly string[]) => paths.includes(s.join("/"));
  assert.deepEqual(decide(["claude"], { exists: has(".claude/settings.json", ".codex/config.toml") }), { allowed: true, warnings: [{ code: "repo_config", path: ".claude/settings.json", cli: "claude" }] });
  assert.deepEqual(decide(["codex"], { exists: has(".claude/settings.json", ".codex/config.toml") }), { allowed: true, warnings: [{ code: "repo_config", path: ".codex/config.toml", cli: "codex" }] });
  const both = decide(["mycli"], { exists: has(".claude/hooks", ".codex/hooks") });
  assert.deepEqual(both.allowed ? both.warnings.map((w) => w.path) : both.rule, [".claude/hooks", ".codex/hooks"], "an unknown executable: every row");
  const strict = [{ cli: "claude" as const, segments: [".claude", "settings.json"], severity: "refuse" as const, source: "test" }];
  assert.deepEqual(decideCliMessaging({ argv: ["claude"], bypassesPrompts: false, exists: has(".claude/settings.json") }, strict), { allowed: false, rule: "repo_config" }, "the rule id names no path (it goes to the audit row)");
});

test("review 1 SF1: a short flag with its value attached is the same flag (-anever, -sdanger-full-access, -capproval_policy=never, -pname)", () => {
  for (const [argv, rule] of [
    [["codex", "-anever"], "codex.ask-for-approval.never"],
    [["codex", "-aNEVER"], "codex.ask-for-approval.never"],
    [["codex", "-sdanger-full-access"], "codex.sandbox.danger-full-access"],
    [["codex", "-capproval_policy=never"], "codex.config.approval_policy"],
    [["codex", '-csandbox_mode="danger-full-access"'], "codex.config.sandbox_mode"],
    [["codex", "-pfast"], "codex.profile"],
  ] as [string[], string][]) assert.equal(refusedBy(argv), rule, argv.join(" "));
  assert.deepEqual(decide(["codex", "-aon-request"]), { allowed: true, warnings: [] }, "another value of the same flag is allowed");
});

test("review 1 decided rows: Claude's --settings and Codex's -p/--profile refuse, whatever their value; Claude's -p (print) does not", () => {
  for (const [argv, rule] of [
    [["claude", "--settings", "/tmp/s.json"], "claude.settings"],
    [["claude", '--settings={"permissions":{}}'], "claude.settings"],
    [["codex", "--profile", "x"], "codex.profile"],
    [["codex", "-p", "x"], "codex.profile"],
  ] as [string[], string][]) assert.equal(refusedBy(argv), rule, argv.join(" "));
  assert.deepEqual(decide(["claude", "-p", "summarise"]), { allowed: true, warnings: [] }, "-p is print in Claude Code");
});

test("review 1 SF2: a wrapper cannot hide a row (every CLI's rows over all its arguments), and the real path names the CLI", () => {
  for (const [argv, rule] of [
    [["env", "claude", "--permission-mode", "auto"], "claude.permission-mode.auto"],
    [["npx", "@openai/codex", "-a", "never"], "codex.ask-for-approval.never"],
    [["/usr/bin/node", "cli.js", "--permission-mode=bypassPermissions"], "claude.permission-mode.bypassPermissions"],
  ] as [string[], string][]) assert.equal(refusedBy(argv), rule, argv.join(" "));
  const viaLink = decideCliMessaging({ argv: ["/home/u/.local/share/claude/versions/2.1.330", "--permission-mode", "auto"], executableReal: "/home/u/.local/share/claude/versions/2.1.330", bypassesPrompts: false, exists: none });
  assert.deepEqual(viaLink, { allowed: false, rule: "claude.permission-mode.auto" }, "a versioned binary is unknown by name: every row applies");
  const linked = decideCliMessaging({ argv: ["/opt/bin/x", "-p", "summarise"], executableReal: "/opt/claude", bypassesPrompts: false, exists: none });
  assert.deepEqual(linked, { allowed: true, warnings: [] }, "the real path names Claude: Codex's -p row does not apply");
});

test("review 1 SF2 b: a shell or interpreter running inline code is refused outright (wrapper_unparsed); without inline code it is a wrapper", () => {
  for (const argv of [["sh", "-c", "claude --permission-mode auto"], ["bash", "-lc", "x"], ["/bin/zsh", "-c", "x"], ["cmd.exe", "/C", "x"], ["pwsh", "-Command", "x"], ["powershell", "-enc", "eA=="], ["python3", "-c", "x"], ["node", "-e", "x"], ["node", "--eval=x"], ["env", "-S", "claude --x"], ["perl", "-e", "x"]]) {
    assert.equal(refusedBy(argv), "wrapper_unparsed", argv.join(" "));
  }
  assert.deepEqual(decide(["bash", "run-claude.sh"]), { allowed: true, warnings: [] }, "a script file is not inline code (its content is a residual)");
});

test("review 1 nits: an empty argv refuses; .com and trailing dots or spaces leave the executable's name", () => {
  assert.deepEqual(decideCliMessaging({ argv: [], bypassesPrompts: false, exists: none }), { allowed: false, rule: "empty_argv" });
  assert.deepEqual(decideCliMessaging({ argv: [""], bypassesPrompts: false, exists: none }), { allowed: false, rule: "empty_argv" });
  assert.deepEqual([cliOf("CODEX.COM"), cliOf("claude. "), cliOf("C:\\x\\codex.exe..")], ["codex", "claude", "codex"]);
});

test("review 2 SF7: a Codex security key takes only a sourced safe value after unquoting; an escape, a non-ASCII value or a quoted key is unparsed", () => {
  for (const [argv, rule] of [
    [["codex", "-c", 'approval_policy="nev\\u0065r"'], "config_unparsed"],
    [["codex", "-c", "approval_policy=nevér"], "config_unparsed"],
    [["codex", "-c", '"approval_policy"=never'], "config_unparsed"],
    [["codex", "-c", "approval_policy='never\""], "config_unparsed"], // mismatched quotes: not a value it parses
    [["codex", "-c", "approval_policy=untrusted"], "codex.config.approval_policy"],
    [["codex", "-c", "profiles.fast.approval_policy=never"], "config_unparsed"], // a dotted key is outside the allowlist (SF10)
    [["codex", "-c", "sandbox_mode=danger-full-access"], "codex.config.sandbox_mode"],
    [["codex", "--config=sandbox_mode='x'"], "codex.config.sandbox_mode"],
  ] as [string[], string][]) assert.equal(refusedBy(argv), rule, argv.join(" "));
  for (const argv of [["codex", "-c", "approval_policy=on-request"], ["codex", "-c", 'approval_policy="on-request"'], ["codex", "-c", "sandbox_mode=read-only"], ["codex", "-c", "sandbox_mode='workspace-write'"], ["codex", "-c", "model=o3"]]) {
    assert.deepEqual(decide(argv), { allowed: true, warnings: [] }, argv.join(" "));
  }
});

test("review 2 SF8: behind a wrapper, any interpreter named or any inline-code argument in any position is wrapper_unparsed; versioned interpreter names match", () => {
  for (const argv of [
    ["env", "bash", "-c", "codex -a never"], ["nice", "sh", "x.sh"], ["timeout", "9", "python3", "x.py"], ["sudo", "-u", "me", "zsh"], ["xargs", "node"],
    ["npx", "-c", "codex -a never"], ["python3.12", "-c", "x"], ["/usr/bin/ruby3.2", "-e", "x"], ["bash", "-cX"], ["fish", "--command=x"], ["php", "-r", "x"], ["lua5.4", "-e", "x"],
    ["awk", "BEGIN{}"], ["deno", "eval", "x"], ["Rscript", "-e", "x"], ["osascript", "-e", "x"], ["pwsh", "-EncodedCommand", "eA=="], ["mywrapper", "--eval=x"],
  ]) assert.equal(refusedBy(argv), "wrapper_unparsed", argv.join(" "));
  assert.equal(refusedBy(["claude", "-c"]), "unknown_flag", "a known CLI's own -c is not inline code; it is simply not on the safe list");
});

test("review 2 SF9: when the name and the real path name different CLIs, the rows of both apply", () => {
  const both = decideCliMessaging({ argv: ["/opt/bin/claude", "-a", "never"], executableReal: "/opt/lib/codex.js", bypassesPrompts: false, exists: none });
  assert.deepEqual(both, { allowed: false, rule: "codex.ask-for-approval.never" });
  const files = decideCliMessaging({ argv: ["/opt/bin/claude"], executableReal: "/opt/lib/codex", bypassesPrompts: false, exists: (s) => s.join("/") === ".codex/config.toml" });
  assert.deepEqual(files, { allowed: true, warnings: [{ code: "repo_config", path: ".codex/config.toml", cli: "codex" }] }, "and both CLIs' project files");
});

test("review 2 SF6: more warnings than an answer carries refuse (too_many_repo_files), never a truncated list", () => {
  const rows = [...Array(9).keys()].map((i) => ({ cli: (i < 8 ? "claude" : "codex") as "claude" | "codex", segments: [i < 8 ? `.c${i}` : ".codex-x"], severity: "warn" as const, source: "test" }));
  const all = (): boolean => true;
  assert.deepEqual(decideCliMessaging({ argv: ["wrapper"], bypassesPrompts: false, exists: all }, rows), { allowed: false, rule: "too_many_repo_files" }, "8 of one CLI and 1 of the other");
  assert.equal(MAX_WARNINGS, 8);
  const eight = decideCliMessaging({ argv: ["wrapper"], bypassesPrompts: false, exists: all }, rows.slice(0, 8));
  assert.equal(eight.allowed ? eight.warnings.length : -1, 8, "exactly the bound is carried");
});

test("review 3 SF10: Codex -c is an allowlist: model and model_reasoning_effort with a plain scalar, the two security keys with their safe values; anything else is unparsed", () => {
  for (const argv of [["codex", "-c", "model=o3"], ["codex", "-c", 'model="gpt-5"'], ["codex", "-c", "model_reasoning_effort=high"], ["codex", "--config=model_reasoning_effort='low'"], ["codex", "-c", "approval_policy=on-request"], ["codex", "-c", "sandbox_mode=workspace-write"]]) {
    assert.deepEqual(decide(argv), { allowed: true, warnings: [] }, argv.join(" "));
  }
  for (const kv of ["approvals_reviewer=auto_review", "approvals_reviewer=guardian_subagent", "default_permissions=x", "permissions={x={filesystem={\":root\"=\"write\"}}}", "sandbox_permissions=[\"disk-full-read-access\"]", "shell_environment_policy.inherit=all", "model.x=y", "model=a b", "model={x=1}", "model=[1]", "model", "features.x=true"]) {
    assert.equal(refusedBy(["codex", "-c", kv]), "config_unparsed", kv);
  }
  assert.equal(refusedBy(["codex", "-c", "approval_policy=never"]), "codex.config.approval_policy", "a security key keeps its own rule id");
});

test("review 3 N12: a known name whose real path is a wrapper or an interpreter is judged as a wrapper", () => {
  const viaEnv = decideCliMessaging({ argv: ["/r/codex", "claude", "--permission-mode", "auto"], executableReal: "/usr/bin/env", bypassesPrompts: false, exists: none });
  assert.deepEqual(viaEnv, { allowed: false, rule: "claude.permission-mode.auto" }, "every CLI's rows over all arguments");
  const viaBash = decideCliMessaging({ argv: ["/r/claude", "-c", "x"], executableReal: "/usr/bin/bash", bypassesPrompts: false, exists: none });
  assert.deepEqual(viaBash, { allowed: false, rule: "wrapper_unparsed" }, "the real path is an interpreter with inline code");
  const viaPython = decideCliMessaging({ argv: ["/r/mycli", "-c", "x"], executableReal: "/usr/bin/python3.12", bypassesPrompts: false, exists: none });
  assert.deepEqual(viaPython, { allowed: false, rule: "wrapper_unparsed" }, "review 3 N18: the real path is scanned for interpreters too");
  const versioned = decideCliMessaging({ argv: ["/r/claude", "--verbose"], executableReal: "/home/u/.local/share/claude/versions/2.1.332", bypassesPrompts: false, exists: none });
  assert.deepEqual(versioned, { allowed: true, warnings: [] }, "an unknown real-path name (a versioned binary) still trusts the name");
});

test("review 3 N17: flags that change what configuration, tools or plugins load refuse; a configuration home set in the arguments refuses", () => {
  for (const [argv, rule] of [
    [["claude", "--mcp-config", "m.json"], "claude.mcp-config"],
    [["claude", "--setting-sources=user"], "claude.setting-sources"],
    [["claude", ["--age", "nts"].join(""), "{}"], "claude.subagents"],
    [["claude", "--plugin-dir", "p"], "claude.plugin-dir"],
    [["env", "CODEX_HOME=/tmp/x", "codex"], "config_home"],
    [["env", "CLAUDE_CONFIG_DIR=/tmp/x", "claude"], "config_home"],
  ] as [string[], string][]) assert.equal(refusedBy(argv), rule, argv.join(" "));
});

test("review 3 N18: the Codex configuration rule also applies behind a wrapper (long form, which is not inline code)", () => {
  assert.equal(refusedBy(["env", "codex", "--config", "approval_policy=never"]), "codex.config.approval_policy");
  assert.equal(refusedBy(["env", "codex", "--config=approvals_reviewer=auto_review"]), "config_unparsed");
  assert.deepEqual(decide(["env", "codex", "--config", "model=o3"]), { allowed: true, warnings: [] });
});

test("review 3 N12: a known name whose real path is an interpreter gets every CLI's rows, even without inline code", () => {
  const viaNode = decideCliMessaging({ argv: ["/r/claude", "-a", "never"], executableReal: "/usr/bin/node", bypassesPrompts: false, exists: none });
  assert.deepEqual(viaNode, { allowed: false, rule: "codex.ask-for-approval.never" }, "not only Claude's rows: the real program is an interpreter");
});

test("review 4 SF11: a known CLI's launch may carry only its safe flags; every other flag is unknown_flag, values bounded", () => {
  for (const argv of [
    ["claude", "--model", "opus", "-p", "--output-format=stream-json", "--verbose", "hi"], ["claude", "-v"], ["claude", "--help"],
    ["codex", "-m", "o3", "-c", "model_reasoning_effort=high", "-a", "on-request", "-s", "read-only", "exec", "do it"], ["codex", "-V"],
  ]) assert.deepEqual(decide(argv), { allowed: true, warnings: [] }, argv.join(" "));
  for (const argv of [
    ["claude", "--permission-mode", "plan"], ["claude", "--debug"], ["claude", "--include-partial-messages"], ["claude", "--from-pr", "1"], ["claude", "--"],
    ["claude", "--output-format", "xml"], ["claude", "-pX"], ["claude", "--model", "x".repeat(65)], ["claude", "--model"],
    ["codex", "--search"], ["codex", "-C", "/elsewhere"], ["codex", "--remote", "h:1"], ["codex", "-a", "untrusted"], ["codex", "-i", "x.png"], ["codex", "--oss"],
  ]) assert.equal(refusedBy(argv), "unknown_flag", argv.join(" "));
  assert.deepEqual(decide(["claude", "--model", "m".repeat(64)]), { allowed: true, warnings: [] }, "review 4 N21: a model value of exactly 64 characters");
});

test("review 4 SF11: the close relatives refuse by name: --plugin-url, and the feature switches", () => {
  for (const [argv, rule] of [
    [["claude", "--plugin-url", "https://x/p.zip"], "claude.plugin-url"], [["npx", "claude", "--plugin-url=https://x/p.zip"], "claude.plugin-url"],
    [["codex", "--enable", "x"], "codex.feature"], [["codex", "--disable", "write_stdin_approval"], "codex.feature"],
  ] as [string[], string][]) assert.equal(refusedBy(argv), rule, argv.join(" "));
});

test("review 4 SF11: a wrapper's environment prefix is an allowlist: configuration homes are config_home, other names env_assignment", () => {
  for (const [argv, rule] of [
    [["env", "HOME=/x", "codex"], "config_home"], [["env", "XDG_CONFIG_HOME=/x", "claude"], "config_home"], [["env", "XDG_DATA_HOME=/x", "claude"], "config_home"],
    [["env", "CODEX_HOME=/x", "codex"], "config_home"], [["env", "CLAUDE_CONFIG_DIR=/x", "claude"], "config_home"], [["env", "CODEX_SANDBOX=0", "codex"], "config_home"],
    [["env", "PATH=/x", "claude"], "env_assignment"], [["env", "LD_PRELOAD=/x.so", "claude"], "env_assignment"],
  ] as [string[], string][]) assert.equal(refusedBy(argv), rule, argv.join(" "));
  for (const argv of [["env", "LANG=C.UTF-8", "TERM=xterm", "NO_COLOR=1", "TZ=UTC", "LC_ALL=C", "claude"]]) assert.deepEqual(decide(argv), { allowed: true, warnings: [] }, argv.join(" "));
  assert.deepEqual(decide(["claude", "-p", "HOME=x"]), { allowed: true, warnings: [] }, "for a known CLI an A=b token is the prompt, not an assignment");
  assert.deepEqual(decide(["env", "codex", "--config", "model=o3"]), { allowed: true, warnings: [] }, "a safe flag's value is not an assignment");
});

test("review 4 N19 and N20: the added wrappers are wrappers; an awk real path is always refused", () => {
  for (const w of ["setsid", "chrt", "ionice", "flock"]) {
    const d = decideCliMessaging({ argv: ["/r/claude", "-a", "never"], executableReal: `/usr/bin/${w}`, bypassesPrompts: false, exists: none });
    assert.deepEqual(d, { allowed: false, rule: "codex.ask-for-approval.never" }, w);
  }
  const awk = decideCliMessaging({ argv: ["/r/claude", 'BEGIN{system("codex -a never")}'], executableReal: "/usr/bin/awk", bypassesPrompts: false, exists: none });
  assert.deepEqual(awk, { allowed: false, rule: "wrapper_unparsed" });
});
