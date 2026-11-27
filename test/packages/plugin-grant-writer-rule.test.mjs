// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The plugin grant writer rule (PV-K2 K2-g3): a clean fixture passes, and every bypass form a static rule can see is planted and
// refused through the same entry the product walk uses (`grantWriterProgram` + `grantWriterProblems`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FILES, grantWriterProblems, grantWriterProgram } from "./plugin-grant-writer-rule.mjs";

const BASE = {
  [FILES.store]: `
declare const B: unique symbol;
export interface PluginGrantWrite { readonly [B]: true }
export class PluginGrantRecords {
  takeGrantMint(): () => PluginGrantWrite { return () => ({}) as PluginGrantWrite; }
  grant(a: string, b: string, c: string, t: PluginGrantWrite): void { void a; void b; void c; void t; }
  setEnabled(a: string, b: string, e: boolean, t?: PluginGrantWrite): void { void a; void b; void e; void t; }
  state(a: string, b: string): unknown { return [a, b]; }
}`,
  [FILES.journal]: `
import { PluginGrantRecords } from "./plugin-grant-store.js";
export class Journal { readonly plugins = new PluginGrantRecords(); static open(): Journal { return new Journal(); } }`,
  [FILES.auditDb]: `export function openDatabase(path: string): unknown { return path; }`,
  [FILES.action]: `
import type { PluginGrantRecords, PluginGrantWrite } from "../../../journal/src/plugin-grant-store.js";
export interface GrantAction { grant(a: string, b: string, c: string): void }
export function createGrantAction(p: Pick<PluginGrantRecords, "grant">, mint: () => PluginGrantWrite): GrantAction {
  return { grant: (a, b, c) => p.grant(a, b, c, mint()) };
}`,
  [FILES.compose]: `
import type { Journal } from "../../journal/src/journal.js";
import { createGrantAction } from "./plugins/grant-action.js";
export function wire(j: Journal) { return createGrantAction(j.plugins, j.plugins.takeGrantMint()); }`,
  [FILES.handler]: `
import type { GrantAction } from "../plugins/grant-action.js";
import type { Journal } from "../../../journal/src/journal.js";
export function revoke(j: Journal, a?: GrantAction) { j.plugins.setEnabled("x", "p", false); a?.grant("x", "p", "runs.start"); }`,
  [FILES.host]: `
import { Journal } from "../../journal/src/journal.js";
export const journal = Journal.open();`,
  [FILES.nodeStorage]: `
import { openDatabase } from "../../../audit/src/db.js";
export const db = openDatabase("x");`,
};

const EVIL = "packages/daemon-host/src/evil.ts";
const J = `import type { Journal } from "../../journal/src/journal.js";\nimport type { PluginGrantWrite } from "../../journal/src/plugin-grant-store.js";\n`;

function run(extra = {}) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "axis-grant-rule-"));
  try {
    const files = { ...BASE, ...extra };
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    const program = grantWriterProgram(Object.keys(files).map((rel) => join(root, rel)));
    return grantWriterProblems(program, root, (rel) => /^packages\/[^/]+\/src\//.test(rel));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a clean fixture shaped like the product has no problem", () => {
  assert.deepEqual(run(), []);
});

const PLANTED = [
  ["an alias of the store", `${J}export function f(j: Journal, t: PluginGrantWrite) { const p = j.plugins; p.grant("a", "b", "c", t); }`],
  ["destructuring", `${J}export function f(j: Journal) { const { grant } = j.plugins; return grant; }`],
  ["a literal bracket key", `${J}export function f(j: Journal, t: PluginGrantWrite) { j.plugins["grant"]("a", "b", "c", t); }`],
  ["a computed key", `${J}export function f(j: Journal, k: "grant" | "state") { return j.plugins[k]; }`],
  ["call through .call", `${J}export function f(j: Journal, t: PluginGrantWrite) { j.plugins.grant.call(j.plugins, "a", "b", "c", t); }`],
  ["bind", `${J}export function f(j: Journal) { return j.plugins.setEnabled.bind(j.plugins); }`],
  ["a helper that receives the store", `${J}function h(p: unknown) { return p; }\nexport function f(j: Journal) { return h(j.plugins); }`],
  ["a second caller of takeGrantMint", `${J}export function f(j: Journal) { return j.plugins.takeGrantMint(); }`],
  ["a token laundered through a look-alike interface", `${J}interface S { grant(a: string, b: string, c: string, t: PluginGrantWrite): void }\nexport function f(s: S, t: PluginGrantWrite) { s.grant("a", "b", "c", t); }`],
  ["the grant action held elsewhere", `import type { GrantAction } from "./plugins/grant-action.js";\nexport function f(a: GrantAction) { a.grant("a", "b", "c"); }`],
  ["a decrease called outside the allowed files", `${J}export function f(j: Journal) { j.plugins.setEnabled("x", "p", false); }`],
  ["a bare reference to grant", `${J}export function f(j: Journal) { const g = j.plugins.grant; return typeof g; }`],
  ["Journal.open outside the host", `import { Journal } from "../../journal/src/journal.js";\nexport const j = Journal.open();`],
  ["new PluginGrantRecords outside the journal", `import { PluginGrantRecords } from "../../journal/src/plugin-grant-store.js";\nexport const p = new PluginGrantRecords();`],
  ["the audit openDatabase elsewhere", `import { openDatabase } from "../../audit/src/db.js";\nexport const d = openDatabase("y");`],
];

for (const [label, text] of PLANTED) {
  test(`refused: ${label}`, () => {
    const problems = run({ [EVIL]: text });
    assert.ok(problems.some((p) => p.startsWith(`${EVIL}:`)), `${label}: ${JSON.stringify(problems)}`);
  });
}

test("refused: createGrantAction reached through a barrel re-export, outside the composition", () => {
  const problems = run({
    "packages/daemon-host/src/barrel.ts": `export { createGrantAction } from "./plugins/grant-action.js";`,
    [EVIL]: `${J}import { createGrantAction } from "./barrel.js";\nexport function f(j: Journal, m: () => PluginGrantWrite) { return createGrantAction(j.plugins, m); }`,
  });
  assert.ok(problems.some((p) => p.startsWith(`${EVIL}:`) && p.includes("createGrantAction")), JSON.stringify(problems));
});

test("refused: a second value exported from grant-action.ts (a wrapper that could forward the mint)", () => {
  const problems = run({ [FILES.action]: `${BASE[FILES.action]}\nexport const leak = 1;` });
  assert.ok(problems.some((p) => p.includes("exactly one value")), JSON.stringify(problems));
});

test("refused: takeGrantMint in the composition but not straight into createGrantAction", () => {
  const problems = run({ [FILES.compose]: `
import type { Journal } from "../../journal/src/journal.js";
import { createGrantAction } from "./plugins/grant-action.js";
export function wire(j: Journal) { const m = j.plugins.takeGrantMint(); return createGrantAction(j.plugins, m); }` });
  assert.ok(problems.some((p) => p.startsWith(`${FILES.compose}:`)), JSON.stringify(problems));
});

test("refused: takeGrantMint in the composition wrapped in anything but the direct argument", () => {
  const problems = run({ [FILES.compose]: `
import type { Journal } from "../../journal/src/journal.js";
import { createGrantAction } from "./plugins/grant-action.js";
export function wire(j: Journal) { return createGrantAction(j.plugins, (j.plugins.takeGrantMint())); }` });
  assert.ok(problems.some((p) => p.startsWith(`${FILES.compose}:`) && p.includes("takeGrantMint")), JSON.stringify(problems));
});
