// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cliEndpointPty, type PtyPort } from "../src/index.js";
import { hostEnableCheck, hostMintRecheck, type EnableCheckDeps } from "../src/messages/enable-check.js";
import { deliveryRig } from "./messages-delivery-rig.js";

// PV-M7 slice 1: where the enable rule runs. The settings service refuses without a decision (fail closed) and audits the
// rule; the host check reads the worker's entry from main and its home's files, and refuses on any gap; the mint re-checks
// the argv that actually runs.

const USER = { kind: "user" } as const;
/** The rig's CLI worker c1 as a real journal worker (the acknowledged-files table has a foreign key to it). */
function journalWorker(r: Awaited<ReturnType<typeof deliveryRig>>): void {
  const home = r.c.journal.createWorkspace({ projectId: "p", branch: "axis/c1-home", baseRef: "HEAD", baseSha: "c".repeat(40), createdBy: "user" }).value.id;
  r.c.journal.transitionWorkspace(home, "READY");
  r.c.journal.agents.create({ id: "c1", projectId: "p", name: "C1", launch: { kind: "cli", entryId: "e" }, homeWorkspaceId: home, groupId: null });
}
const endpointRows = (r: Awaited<ReturnType<typeof deliveryRig>>) => r.c.audit.list({ limit: 5000 }).filter((e) => e.action === "message.endpoint").map((e) => e.payload as Record<string, unknown>);

test("settings: enabling without a decision, or with a refusal, is bypass_entry and audited by rule; allowed, it is written with its warnings", async (t) => {
  const r = await deliveryRig(t, { noDelivery: true });
  journalWorker(r);
  const on = { setting: "cliMessaging", agentId: "c1", value: true } as const;
  assert.throws(() => r.m.settings.updateSettings(USER, on), (e: { reason?: string }) => e.reason === "bypass_entry", "no decision: fails closed");
  assert.throws(() => r.m.settings.updateSettings(USER, on, { allowed: false, rule: "claude.dangerously-skip-permissions" }), (e: { reason?: string }) => e.reason === "bypass_entry");
  assert.deepEqual(endpointRows(r).filter((p) => p["event"] === "enable_refused").map((p) => p["rule"]), ["no_check", "claude.dangerously-skip-permissions"], "audited by rule id, even though the write was refused");
  assert.equal(r.c.journal.messages.agentSettings("c1")?.cliMessaging ?? false, false, "nothing written");
  const warning = { code: "repo_config", path: ".claude/settings.json", cli: "claude" } as const;
  const ok = r.m.settings.updateSettings(USER, { ...on, acknowledged: [{ path: warning.path, cli: warning.cli }] }, { allowed: true, warnings: [warning] });
  assert.deepEqual([ok.changed, ok.warnings], [true, [warning]]);
  assert.equal(r.c.journal.messages.agentSettings("c1")?.cliMessaging, true);
  assert.ok(endpointRows(r).some((p) => p["event"] === "enable_allowed" && p["warnings"] === 1));
  assert.equal(r.m.settings.updateSettings(USER, on).changed, false, "already on: no new check needed");
  assert.equal(r.m.settings.updateSettings(USER, { ...on, value: false }).changed, true, "turning it off needs no decision");
});

function fakeDeps(over: Partial<{ agent: unknown; root: string | null; value: unknown; settingsThrows: boolean; files: string[] }> = {}): EnableCheckDeps {
  const agent = "agent" in over ? over.agent : { id: "w1", archived: false, homeWorkspaceId: "ws", launch: { kind: "cli", entryId: "e1" } };
  return {
    journal: { agents: { get: () => agent } as never, getWorkspace: (() => (over.root === null ? undefined : { worktreePath: over.root ?? "/wt" })) as never },
    settingsGet: async () => {
      if (over.settingsThrows === true) throw new Error("main is gone");
      return "value" in over ? over.value : [{ id: "e1", label: "E", command: ["claude"], args: ["--model", "x"] }];
    },
    platform: "linux",
    exists: (p) => (over.files ?? []).includes(p),
  };
}
const signal = new AbortController().signal;

test("host check: any gap refuses no_entry; a marked entry, a flag, or a sourced project file decide as the rule says", async () => {
  const check = (o: Parameters<typeof fakeDeps>[0]) => hostEnableCheck(fakeDeps(o))("w1", signal);
  for (const [name, o] of [
    ["no worker", { agent: undefined }],
    ["a composer worker", { agent: { id: "w1", archived: false, homeWorkspaceId: "ws", launch: { kind: "composer" } } }],
    ["an archived worker", { agent: { id: "w1", archived: true, homeWorkspaceId: "ws", launch: { kind: "cli", entryId: "e1" } } }],
    ["no live home", { root: null }],
    ["main does not answer", { settingsThrows: true }],
    ["the entry is gone", { value: [] }],
  ] as const) {
    assert.deepEqual(await check(o as never), { allowed: false, rule: "no_entry" }, name);
  }
  assert.deepEqual(await check({ value: [{ id: "e1", label: "E", command: ["claude"], args: [], bypassesPrompts: true }] }), { allowed: false, rule: "user_marked" });
  assert.deepEqual(await check({ value: [{ id: "e1", label: "E", command: ["claude"], args: ["--dangerously-skip-permissions"] }] }), { allowed: false, rule: "claude.dangerously-skip-permissions" });
  assert.deepEqual(await check({ files: ["/wt/.claude/settings.local.json"] }), { allowed: true, warnings: [{ code: "repo_config", path: ".claude/settings.local.json", cli: "claude" }] });
  assert.deepEqual(await check({}), { allowed: true, warnings: [] });
});

test("mint re-check: the argv that runs decides (an entry edited after enabling gets no endpoint), audited mint_refused; a run of no worker passes", async () => {
  const rows: unknown[] = [];
  const recheck = hostMintRecheck({ ...fakeDeps(), acknowledged: () => [], agentOfRun: (id) => (id === "worker-run" ? "w1" : undefined), audit: { append: (e) => void rows.push(e.payload) } });
  assert.equal(await recheck({ runId: "plain-run", argv: ["claude", "--dangerously-skip-permissions"] }), true, "no worker: the mint decides (and refuses)");
  assert.equal(await recheck({ runId: "worker-run", argv: ["claude", "--model", "x"] }), true);
  assert.equal(await recheck({ runId: "worker-run", argv: ["claude", "--permission-mode", "auto"] }), false, "the spawned argv, not the entry read at enable");
  assert.deepEqual(rows, [{ runId: "worker-run", agentId: "w1", event: "mint_refused", rule: "claude.permission-mode.auto" }]);
  const later: unknown[] = [];
  const gone = hostMintRecheck({ ...fakeDeps({ settingsThrows: true }), acknowledged: () => [], agentOfRun: () => "w1", audit: { append: (e) => void later.push(e.payload) } });
  assert.equal(await gone({ runId: "worker-run", argv: ["claude"] }), false, "no answer from main: no endpoint");
  assert.deepEqual(later, [{ runId: "worker-run", agentId: "w1", event: "mint_refused", rule: "no_entry" }]);
});

test("cliEndpointPty: a refused re-check spawns without an endpoint and mints nothing; allowed, it mints as before", async () => {
  const specs: unknown[] = [];
  const pty: PtyPort = { spawn: async (s) => (specs.push(s), { onExit: () => ({ dispose: () => undefined }) }) as never };
  let mints = 0;
  const endpoints = { mint: () => (mints++, { endpointId: "ep_x", token: "t" }), revoke: () => undefined };
  const spec = { runId: "r1", argv: ["claude"], cwd: "/w", env: {}, cols: 80, rows: 24 } as never;
  await cliEndpointPty(pty, () => endpoints, async () => false).spawn(spec);
  assert.deepEqual([mints, "messagesEndpoint" in (specs[0] as object)], [0, false]);
  await cliEndpointPty(pty, () => endpoints, async () => true).spawn(spec);
  assert.deepEqual([mints, (specs[1] as { messagesEndpoint?: unknown }).messagesEndpoint], [1, { endpoint: "ep_x", token: "t" }]);
});

test("handler: enabling asks the check first and passes its decision; other settings never ask", async (t) => {
  const { createMessagesHandlers } = await import("../src/handlers/messages.js");
  const r = await deliveryRig(t, { noDelivery: true });
  const asked: string[] = [];
  const h = createMessagesHandlers({ ...r.m, checkEnable: async (id) => (asked.push(id), id === "c1" ? { allowed: true, warnings: [] } : { allowed: false, rule: "no_entry" }) });
  const ctx = { identity: { actor: "user", clientKind: "desktop" }, signal: new AbortController().signal } as never;
  const out = (await h.updateSettings(ctx, { setting: "cliMessaging", agentId: "c1", value: true } as never)) as { changed: boolean };
  assert.equal(out.changed, true);
  await h.updateSettings(ctx, { setting: "muted", agentId: "c1", value: true } as never);
  await h.updateSettings(ctx, { setting: "cliMessaging", agentId: "c1", value: false } as never);
  assert.deepEqual(asked, ["c1"], "only an enable asks");
});

test("review 1 SF5: an entry the user marks as bypassing prompts after enabling gets no endpoint at the next mint", async () => {
  const rows: unknown[] = [];
  const marked = hostMintRecheck({ ...fakeDeps({ value: [{ id: "e1", label: "E", command: ["claude"], args: [], bypassesPrompts: true }] }), acknowledged: () => [], agentOfRun: () => "w1", audit: { append: (e) => void rows.push(e.payload) } });
  assert.equal(await marked({ runId: "r", argv: ["claude"] }), false);
  assert.deepEqual(rows, [{ runId: "r", agentId: "w1", event: "mint_refused", rule: "user_marked" }]);
});

test("review 1 SF4: an enable with warnings is two steps: the first answer writes nothing and names the files; the second, naming them all, writes and keeps them", async (t) => {
  const r = await deliveryRig(t, { noDelivery: true });
  journalWorker(r);
  const w1 = { code: "repo_config", path: ".claude/settings.json", cli: "claude" } as const;
  const w2 = { code: "repo_config", path: ".mcp.json", cli: "claude" } as const;
  const decision = { allowed: true, warnings: [w1, w2] } as const;
  const on = { setting: "cliMessaging", agentId: "c1", value: true } as const;
  const first = r.m.settings.updateSettings(USER, on, decision);
  assert.deepEqual([first.changed, first.warnings], [false, [w1, w2]]);
  assert.equal(r.c.journal.messages.agentSettings("c1")?.cliMessaging ?? false, false, "nothing written by the first step");
  const partial = r.m.settings.updateSettings(USER, { ...on, acknowledged: [{ path: w1.path, cli: "claude" }] }, decision);
  assert.equal(partial.changed, false, "naming only some of the files is not the second step");
  const wrongCli = r.m.settings.updateSettings(USER, { ...on, acknowledged: [{ path: w1.path, cli: "codex" }, { path: w2.path, cli: "claude" }] }, decision);
  assert.equal(wrongCli.changed, false, "a path with the wrong CLI does not count");
  // An extra path the user names that was NOT warned about is not stored, so a file added later is never pre-acknowledged.
  const second = r.m.settings.updateSettings(USER, { ...on, acknowledged: [{ path: w2.path, cli: "claude" }, { path: w1.path, cli: "claude" }, { path: ".codex/config.toml", cli: "codex" }] }, decision);
  assert.equal(second.changed, true);
  assert.deepEqual(r.c.journal.messages.cliAcknowledged("c1"), [".claude/settings.json", ".mcp.json"], "the freshly warned files are kept (not the caller's list), paths only");
  assert.deepEqual(endpointRows(r).filter((p) => p["event"] === "enable_needs_confirmation").map((p) => p["warnings"]), [2, 2, 2]);
  r.m.settings.updateSettings(USER, { ...on, value: false });
  assert.deepEqual(r.c.journal.messages.cliAcknowledged("c1"), [], "turning it off clears them");
  const plain = r.m.settings.updateSettings(USER, on, { allowed: true, warnings: [] });
  assert.equal(plain.changed, true, "no warnings: one step");
});

test("review 1 SF3: at mint, a project-configuration file present now that was not acknowledged gets no endpoint (audited with a count, no path); acknowledged ones pass", async () => {
  const rows: unknown[] = [];
  const deps = fakeDeps({ files: ["/wt/.claude/settings.json", "/wt/.claude/settings.local.json"] });
  const recheck = (acked: string[]) => hostMintRecheck({ ...deps, acknowledged: () => acked, agentOfRun: () => "w1", audit: { append: (e) => void rows.push(e.payload) } });
  assert.equal(await recheck([".claude/settings.json", ".claude/settings.local.json"])({ runId: "r", argv: ["claude"] }), true, "both acknowledged");
  assert.equal(await recheck([".claude/settings.json"])({ runId: "r", argv: ["claude"] }), false, "the local settings file appeared since");
  assert.equal(await recheck([])({ runId: "r", argv: ["claude"] }), false);
  assert.deepEqual(rows, [
    { runId: "r", agentId: "w1", event: "mint_refused", rule: "repo_config_unacknowledged", warnings: 1 },
    { runId: "r", agentId: "w1", event: "mint_refused", rule: "repo_config_unacknowledged", warnings: 2 },
  ]);
});

test("review 3 N13: an absolute executable whose real path cannot be resolved refuses, at enable and at mint (never the name instead)", async () => {
  const gone = "/nonexistent-axis-test/bin/claude";
  assert.deepEqual(await hostEnableCheck(fakeDeps({ value: [{ id: "e1", label: "E", command: [gone], args: [] }] }))("w1", signal), { allowed: false, rule: "real_path_unresolved" });
  const rows: unknown[] = [];
  const recheck = hostMintRecheck({ ...fakeDeps(), acknowledged: () => [], agentOfRun: () => "w1", audit: { append: (e) => void rows.push(e.payload) } });
  assert.equal(await recheck({ runId: "r", argv: [gone] }), false);
  assert.deepEqual(rows, [{ runId: "r", agentId: "w1", event: "mint_refused", rule: "real_path_unresolved" }]);
});

test("review 3 N15: a launch the rule cannot judge is refused by its own reason; a recognised bypass stays bypass_entry", async (t) => {
  const r = await deliveryRig(t, { noDelivery: true });
  const on = { setting: "cliMessaging", agentId: "c1", value: true } as const;
  for (const rule of ["wrapper_unparsed", "config_unparsed", "too_many_repo_files", "empty_argv", "unknown_flag", "env_assignment", "config_home", "real_path_unresolved"]) {
    assert.throws(() => r.m.settings.updateSettings(USER, on, { allowed: false, rule }), (e: { reason?: string }) => e.reason === rule, rule);
  }
  for (const rule of ["claude.dangerously-skip-permissions", "user_marked", "no_entry", "bypass_pattern"]) {
    assert.throws(() => r.m.settings.updateSettings(USER, on, { allowed: false, rule }), (e: { reason?: string }) => e.reason === "bypass_entry", rule);
  }
});
