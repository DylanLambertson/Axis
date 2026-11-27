// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BYPASS_FLAGS, BYPASS_WORDS, cliOf, decideCliMessaging } from "../src/messages/enable-rule.js";

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
    [["codex", "-c", 'approval_policy="never"'], "codex.config.approval_policy.never"],
    [["codex", "--config", "approval_policy = 'never'"], "codex.config.approval_policy.never"],
    [["codex", "-c", 'sandbox_mode="danger-full-access"'], "codex.config.sandbox_mode.danger-full-access"],
    [["C:\\tools\\codex.exe", "-a", "NEVER"], "codex.ask-for-approval.never"],
  ];
  for (const [argv, rule] of cases) assert.equal(refusedBy(argv), rule, argv.join(" "));
  assert.equal(new Set(BYPASS_FLAGS.map((r) => r.id)).size, BYPASS_FLAGS.length, "row ids are unique");
  for (const r of BYPASS_FLAGS) assert.ok(/^(Claude Code 2\.1\.330|codex-cli 0\.166\.0) --help$/.test(r.source), `${r.id} names the help it came from`);
});

test("the pattern rule refuses an unknown bypass-like argument for any CLI, a wrapper included (fail closed)", () => {
  for (const arg of ["--yolo", "--Dangerously-Anything", "--bypass-x", "--skip-permissions", "--no-confirm", "--auto_approve", "--full-auto", "--approval-mode=yolo", "--no-sandbox", "sandbox=false", "danger-full-access"]) {
    assert.equal(refusedBy(["gemini", arg]), "bypass_pattern", arg);
  }
  assert.equal(refusedBy(["mywrapper", "--yolo"]), "bypass_pattern", "a wrapper: the pattern applies to every argument");
  assert.deepEqual([...BYPASS_WORDS].sort(), ["approval-mode", "auto-approve", "bypass", "danger-full-access", "dangerously", "full-auto", "no-confirm", "no-sandbox", "sandbox=false", "skip-permissions", "yolo"]);
});

test("an ordinary launch is allowed: other permission modes, other sandboxes, other flags", () => {
  for (const argv of [["claude"], ["claude", "--model", "opus"], ["claude", "--permission-mode", "plan"], ["claude", "--permission-mode", "manual"], ["codex", "-a", "on-request"], ["codex", "-s", "workspace-write"], ["codex", "-c", 'model="o3"']]) {
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
    [["codex", "-capproval_policy=never"], "codex.config.approval_policy.never"],
    [["codex", '-csandbox_mode="danger-full-access"'], "codex.config.sandbox_mode.danger-full-access"],
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
