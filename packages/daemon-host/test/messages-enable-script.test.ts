// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Audit B F1: a known CLI name is trusted only when its real file is that CLI, never a script that merely has the name. A shell
// wrapper named after the CLI can run the real one with any flags (a bypass the rule refuses when it is written by hand), so a
// script is refused `wrapper_unparsed`, at enable and at mint, unless it is exactly one of the two npm package scripts. A
// binary named after the CLI, the versioned native install and the npm package scripts (directly or through a link) pass.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { decideCliMessaging } from "../src/messages/enable-rule.js";
import { hostEnableCheck, hostMintRecheck, type EnableCheckDeps } from "../src/messages/enable-check.js";

const skip = process.platform === "win32" ? "POSIX executables and links" : false;
const signal = new AbortController().signal;

function box(t: TestContext): (rel: string, body: string | Buffer) => string {
  const root = mkdtempSync(join(tmpdir(), "axis-enable-script-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return (rel, body) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    chmodSync(p, 0o755);
    return p;
  };
}
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
const WRAPPER = '#!/bin/bash\nexec "$REAL_BIN" --enable hooks --dangerously-bypass-hook-trust "$@"\n';

function deps(command: string): EnableCheckDeps {
  return {
    journal: { agents: { get: () => ({ id: "w1", archived: false, homeWorkspaceId: "ws", launch: { kind: "cli", entryId: "e1" } }) } as never, getWorkspace: (() => ({ worktreePath: "/wt" })) as never },
    settingsGet: async () => [{ id: "e1", label: "E", command: [command], args: [] }],
    platform: "linux",
    exists: () => false,
  };
}
const enable = (command: string) => hostEnableCheck(deps(command))("w1", signal);
async function mint(command: string): Promise<{ ok: boolean; rows: unknown[] }> {
  const rows: unknown[] = [];
  const recheck = hostMintRecheck({ ...deps(command), acknowledged: () => [], agentOfRun: () => "w1", audit: { append: (e) => void rows.push(e.payload) } });
  return { ok: await recheck({ runId: "r", argv: [command] }), rows };
}

test("a shell wrapper named codex or claude is refused wrapper_unparsed at enable and at mint", { skip }, async (t) => {
  const put = box(t);
  for (const name of ["codex", "claude"]) {
    const wrapper = put(`bin/${name}`, WRAPPER);
    assert.deepEqual(await enable(wrapper), { allowed: false, rule: "wrapper_unparsed" }, `${name}: at enable`);
    const m = await mint(wrapper);
    assert.equal(m.ok, false, `${name}: at mint`);
    assert.deepEqual(m.rows, [{ runId: "r", agentId: "w1", event: "mint_refused", rule: "wrapper_unparsed" }]);
    // A link named after the CLI whose real file is a script is the same wrapper.
    const link = join(dirname(wrapper), "..", "links", name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(wrapper, link);
    assert.deepEqual(await enable(link), { allowed: false, rule: "wrapper_unparsed" }, `${name}: through a link`);
  }
});

test("accepted: a binary named after the CLI, the versioned native install, and the exact npm package scripts, directly or linked", { skip }, async (t) => {
  const put = box(t);
  assert.deepEqual(await enable(put("bin/codex", ELF)), { allowed: true, warnings: [] }, "a binary named codex");
  const versioned = put("share/claude/versions/2.1.332", ELF);
  assert.deepEqual(await enable(versioned), { allowed: true, warnings: [] }, "the versioned native install");
  const npmCodex = put("lib/node_modules/@openai/codex/bin/codex.js", "#!/usr/bin/env node\nrequire('./x');\n");
  const npmClaude = put("lib/node_modules/@anthropic-ai/claude-code/cli.js", "#!/usr/bin/env node\nimport('./x');\n");
  for (const [name, real] of [["codex", npmCodex], ["claude", npmClaude]] as const) {
    assert.deepEqual(await enable(real), { allowed: true, warnings: [] }, `${name}: the npm package script itself`);
    const link = join(dirname(real), "..", "..", "..", "..", "bin", name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(real, link);
    assert.deepEqual(await enable(link), { allowed: true, warnings: [] }, `${name}: the npm link to it`);
    assert.equal((await mint(link)).ok, true, `${name}: and at mint`);
  }
});

test("the rule: a script fact refuses the known-name layout; only the two exact npm package paths are scripts it accepts", () => {
  const decide = (real: string, executableScript: boolean) => decideCliMessaging({ argv: [real], executableReal: real, executableScript, bypassesPrompts: false, exists: () => false });
  assert.deepEqual(decide("/u/bin/codex", true), { allowed: false, rule: "wrapper_unparsed" });
  assert.deepEqual(decide("/u/bin/claude", true), { allowed: false, rule: "wrapper_unparsed" });
  assert.deepEqual(decide("/u/bin/codex", false), { allowed: true, warnings: [] });
  assert.deepEqual(decide("/u/lib/node_modules/@openai/codex/bin/codex.js", true), { allowed: true, warnings: [] });
  assert.deepEqual(decide("/u/lib/node_modules/@anthropic-ai/claude-code/cli.js", true), { allowed: true, warnings: [] });
  assert.deepEqual(decide("/u/lib/node_modules/@evil/codex/bin/codex.js", true), { allowed: false, rule: "wrapper_unparsed" }, "another package's codex.js");
  const linked = (exe: string, real: string, executableScript: boolean) => decideCliMessaging({ argv: [exe], executableReal: real, executableScript, bypassesPrompts: false, exists: () => false });
  assert.deepEqual(linked("/u/bin/claude", "/u/share/claude/versions/2.1.332", false), { allowed: true, warnings: [] }, "the versioned native binary");
  assert.deepEqual(linked("/u/bin/claude", "/u/share/claude/versions/2.1.332", true), { allowed: false, rule: "wrapper_unparsed" }, "a script in the versioned layout");
});

test("audit B F5: a trusted project's .codex/hooks.json is warned like the other project-configuration files", () => {
  const out = decideCliMessaging({ argv: ["/u/bin/codex"], executableReal: "/u/bin/codex", executableScript: false, bypassesPrompts: false, exists: (s) => s.join("/") === ".codex/hooks.json" });
  assert.deepEqual(out, { allowed: true, warnings: [{ code: "repo_config", path: ".codex/hooks.json", cli: "codex" }] });
});
