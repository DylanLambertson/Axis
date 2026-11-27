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
  [FILES.switchStore]: `
declare const S: unique symbol;
export interface CliEndpointSwitchWrite { readonly [S]: true }
export class CliEndpointSwitchRecords {
  takeSwitchMint(): () => CliEndpointSwitchWrite { return () => ({}) as CliEndpointSwitchWrite; }
  switchOn(t: CliEndpointSwitchWrite): { changed: boolean } { void t; return { changed: true }; }
  switchOff(): { changed: boolean } { return { changed: true }; }
  enabled(): boolean { return false; }
}`,
  [FILES.journal]: `
import { PluginGrantRecords } from "./plugin-grant-store.js";
import { CliEndpointSwitchRecords } from "./cli-endpoint-store.js";
export class Journal { readonly plugins = new PluginGrantRecords(); readonly cliEndpoint = new CliEndpointSwitchRecords(); static open(): Journal { return new Journal(); } }`,
  [FILES.switchAction]: `
import type { CliEndpointSwitchRecords, CliEndpointSwitchWrite } from "../../../journal/src/cli-endpoint-store.js";
export interface CliEndpointSwitchAction { switchOn(): { changed: boolean } }
export function createCliEndpointSwitchAction(s: Pick<CliEndpointSwitchRecords, "switchOn">, mint: () => CliEndpointSwitchWrite): CliEndpointSwitchAction {
  return { switchOn: () => s.switchOn(mint()) };
}`,
  [FILES.switchHandler]: `
import type { CliEndpointSwitchAction } from "../messages/cli-endpoint-action.js";
import type { CliEndpointSwitchRecords } from "../../../journal/src/cli-endpoint-store.js";
export function handlers(d: { action: CliEndpointSwitchAction; store: Pick<CliEndpointSwitchRecords, "enabled" | "switchOff"> }) {
  return { on: () => d.action.switchOn(), off: () => d.store.switchOff(), state: () => d.store.enabled() };
}`,
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
import { registerPluginsHandlers } from "./handlers/plugins.js";
import { createCliEndpointSwitchAction } from "./messages/cli-endpoint-action.js";
import { handlers } from "./handlers/messages-switch.js";
export function wire(j: Journal) {
  registerPluginsHandlers({ journal: j });
  handlers({ action: createCliEndpointSwitchAction(j.cliEndpoint, j.cliEndpoint.takeSwitchMint()), store: j.cliEndpoint });
  return createGrantAction(j.plugins, j.plugins.takeGrantMint());
}`,
  [FILES.handler]: `
import type { GrantAction } from "../plugins/grant-action.js";
import type { Journal } from "../../../journal/src/journal.js";
export function revoke(j: Journal, a?: GrantAction) { j.plugins.setEnabled("x", "p", false); a?.grant("x", "p", "runs.start"); }
export function registerPluginsHandlers(deps: { journal: { plugins: { setEnabled(a: string, b: string, e: false): void } } }): unknown { return deps; }`,
  [FILES.host]: `
import { Journal } from "../../journal/src/journal.js";
export const journal = Journal.open();`,
  [FILES.nodeStorage]: `
import { openDatabase } from "../../../audit/src/db.js";
export const db = openDatabase("x");`,
};

const EVIL = "packages/daemon-host/src/evil.ts";
const J = `import type { Journal } from "../../journal/src/journal.js";\nimport type { PluginGrantWrite } from "../../journal/src/plugin-grant-store.js";\n`;
const JS = `import type { Journal } from "../../journal/src/journal.js";\nimport type { CliEndpointSwitchWrite } from "../../journal/src/cli-endpoint-store.js";\n`;

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
  ["an enable outside the allowed files", `${J}export function f(j: Journal) { j.plugins.setEnabled("x", "p", true); }`],
  ["a setEnabled whose third argument is not the literal false", `${J}export function f(j: Journal, on: boolean) { j.plugins.setEnabled("x", "p", on); }`],
  ["a bare reference to grant", `${J}export function f(j: Journal) { const g = j.plugins.grant; return typeof g; }`],
  ["a structural view of the store", `${J}export function f(j: Journal) { const p: { takeGrantMint(): () => unknown; grant(a: string, b: string, c: string, t: never): void } = j.plugins; return p.takeGrantMint(); }`],
  ["a Pick<> view of the store", `${J}import type { PluginGrantRecords } from "../../journal/src/plugin-grant-store.js";\nexport function f(j: Journal, t: PluginGrantWrite) { const p: Pick<PluginGrantRecords, "grant"> = j.plugins; p.grant("a", "b", "c", t); }`],
  ["a two-member union view", `${J}export function f(j: Journal) { const p: { takeGrantMint(): unknown; x?: 1 } | { takeGrantMint(): unknown; y?: 2 } = j.plugins; return p.takeGrantMint(); }`],
  ["a literal bracket enable, no token in sight", `${J}export function f(j: Journal) { j.plugins["setEnabled"]("x", "p", true); }`],
  ["a union view", `${J}export function f(j: Journal) { const p: { takeGrantMint(): () => unknown } | undefined = j.plugins; return p?.takeGrantMint(); }`],
  ["the store in an array", `${J}export function f(j: Journal) { const a = [j.plugins]; return a[0]?.takeGrantMint(); }`],
  ["the store in an object", `${J}export function f(j: Journal) { const o = { s: j.plugins }; return o.s.takeGrantMint(); }`],
  ["a function returning the store in a tuple", `${J}const pair = (j: Journal): [number, Journal["plugins"]] => [1, j.plugins];\nexport function f(j: Journal) { return pair(j)[1].takeGrantMint(); }`],
  ["the journal in an array", `${J}export function f(j: Journal) { return [j][0]?.plugins.takeGrantMint(); }`],
  ["an element access into a structural journal view", `${J}export function f(j: Journal) { const v: { plugins: { setEnabled(a: string, b: string, e: boolean): void } } = { plugins: j["plugins"] }; v.plugins.setEnabled("x", "p", true); }`],
  ["the journal through a promise", `${J}export async function f(j: Journal) { const v: { plugins: { takeGrantMint(): unknown } } = await Promise.resolve(j); return v.plugins.takeGrantMint(); }`],
  ["a generic bounded by a structural view", `${J}function g<T extends { plugins: { takeGrantMint(): unknown } }>(x: T) { return x.plugins.takeGrantMint(); }\nexport function f(j: Journal) { return g(j); }`],
  ["a structural journal view", `${J}export function f(j: Journal) { const v: { plugins: { setEnabled(a: string, b: string, e: boolean): void } } = j; v.plugins.setEnabled("x", "p", true); }`],
  ["a function typed to return a view of the store", `${J}export function view(j: Journal): { setEnabled(a: string, b: string, e: boolean): void } { return j.plugins; }\nexport function f(j: Journal) { view(j).setEnabled("x", "p", true); }`],
  ["a function returning a token, alone", `${J}export function f(m: () => PluginGrantWrite) { return typeof m; }`],
  ["a shorthand property", `${J}export function f(j: Journal) { const plugins = j.plugins; const o = { plugins }; return o.plugins.takeGrantMint(); }`],
  ["a forged local GrantAction cast", `${J}interface GrantAction { takeGrantMint(): unknown; grant(a: string, b: string, c: string): void }\nexport function f(j: Journal) { return (j.plugins as unknown as GrantAction).takeGrantMint(); }`],
  ["a forged GrantAction in a tuple", `${J}interface GrantAction { takeGrantMint(): unknown }\nexport function f(j: Journal) { const t: [GrantAction] = [j.plugins]; return t[0].takeGrantMint(); }`],
  ["an enable through a forged GrantAction", `${J}interface GrantAction { setEnabled(a: string, b: string, e: boolean): void }\nexport function f(j: Journal) { (j.plugins as GrantAction).setEnabled("x", "p", true); }`],
  ["nested destructuring", `${J}export function f(j: Journal) { const { plugins: { takeGrantMint } } = j; return takeGrantMint; }`],
  ["destructuring a parameter", `${J}export function f({ takeGrantMint }: Journal["plugins"]) { return takeGrantMint; }`],
  ["destructuring a callback parameter", `${J}export function f(j: Journal) { return [j.plugins].map(({ takeGrantMint }) => takeGrantMint); }`],
  ["destructuring in a for-of", `${J}export function f(j: Journal) { for (const { setEnabled } of [j.plugins]) void setEnabled; }`],
  ["destructuring inside an array pattern", `${J}export function f(j: Journal) { const [{ grant }] = [j.plugins]; return grant; }`],
  ["an assignment pattern", `${J}export function f(j: Journal) { let g: unknown; ({ grant: g } = j.plugins); return g; }`],
  ["a nested assignment pattern", `${J}export function f(j: Journal) { let m: unknown; ({ plugins: { takeGrantMint: m } } = j); return m; }`],
  ["an assignment pattern in a for-of", `${J}export function f(j: Journal) { let s: unknown; for ({ setEnabled: s } of [j.plugins]) void s; }`],
  ["Journal.open outside the host", `import { Journal } from "../../journal/src/journal.js";\nexport const j = Journal.open();`],
  ["new PluginGrantRecords outside the journal", `import { PluginGrantRecords } from "../../journal/src/plugin-grant-store.js";\nexport const p = new PluginGrantRecords();`],
  ["the audit openDatabase elsewhere", `import { openDatabase } from "../../audit/src/db.js";\nexport const d = openDatabase("y");`],
  // The CLI endpoint switch (PV-M7 slice 2): switchOn only through the action, switchOff only in its handler, the mint only into the action.
  ["switchOn on the switch store", `${JS}export function f(j: Journal, t: CliEndpointSwitchWrite) { return j.cliEndpoint.switchOn(t); }`],
  ["switchOff outside its handler", `${JS}export function f(j: Journal) { return j.cliEndpoint.switchOff(); }`],
  ["a second caller of takeSwitchMint", `${JS}export function f(j: Journal) { return j.cliEndpoint.takeSwitchMint(); }`],
  ["destructuring switchOn", `${JS}export function f(j: Journal) { const { switchOn } = j.cliEndpoint; return switchOn; }`],
  ["a literal bracket switchOff", `${JS}export function f(j: Journal) { return j.cliEndpoint["switchOff"](); }`],
  ["a computed key on the switch store", `${JS}export function f(j: Journal, k: "switchOn" | "enabled") { return j.cliEndpoint[k]; }`],
  ["a structural view of the switch store", `${JS}export function f(j: Journal) { const v: { switchOff(): unknown } = j.cliEndpoint; return v.switchOff(); }`],
  ["the switch store passed to a helper", `${JS}function h(p: unknown) { return p; }\nexport function f(j: Journal) { return h(j.cliEndpoint); }`],
  ["a switch token held elsewhere", `${JS}export function f(m: () => CliEndpointSwitchWrite) { return typeof m; }`],
  ["the switch action held elsewhere", `import type { CliEndpointSwitchAction } from "./messages/cli-endpoint-action.js";\nexport function f(a: CliEndpointSwitchAction) { return a.switchOn(); }`],
  ["a forged local CliEndpointSwitchAction cast", `${JS}interface CliEndpointSwitchAction { switchOff(): unknown }\nexport function f(j: Journal) { return (j.cliEndpoint as unknown as CliEndpointSwitchAction).switchOff(); }`],
  ["new CliEndpointSwitchRecords outside the journal", `import { CliEndpointSwitchRecords } from "../../journal/src/cli-endpoint-store.js";\nexport const s = new CliEndpointSwitchRecords();`],
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

test("refused: the composition exporting the store under a structural type, at the importer's call", () => {
  const problems = run({
    [FILES.compose]: `${BASE[FILES.compose]}\nexport function leak(j: Journal): { grant(a: string, b: string, c: string, t: never): void } { return j.plugins; }`,
    [EVIL]: `${J}import { leak } from "./compose-serving.js";\nexport function f(j: Journal, t: never) { leak(j).grant("a", "b", "c", t); }`,
  });
  assert.ok(problems.some((p) => p.startsWith(`${EVIL}:`) && p.includes("grant")), JSON.stringify(problems));
});

test("refused: the handler passing the grant action out under a structural type, at the call", () => {
  const problems = run({ [FILES.handler]: `${BASE[FILES.handler]}\nexport function out(a: GrantAction) { const g: { grant(a: string, b: string, c: string): void } = a; g.grant("x", "p", "runs.start"); }` });
  assert.ok(problems.some((p) => p.startsWith(`${FILES.handler}:`) && p.includes("grant")), JSON.stringify(problems));
});

test("refused: something leaked inside the handler-deps call of the composition", () => {
  const problems = run({
    [EVIL]: `${J}export function leak(j: Journal) { return j.plugins.takeGrantMint(); }`,
    [FILES.compose]: `${BASE[FILES.compose]}\nimport { leak } from "./evil.js";\nexport function more(j: Journal) { registerPluginsHandlers({ journal: j, extra: leak(j) } as never); }`,
  });
  assert.ok(problems.some((p) => p.startsWith(`${EVIL}:`)), JSON.stringify(problems));
});

test("allowed: a decrease anywhere, the grant action's own calls, a data field named grant, an unused method named grant", () => {
  assert.deepEqual(run(), []);
  assert.deepEqual(run({ [EVIL]: `${J}export function f(j: Journal) { j.plugins.setEnabled("x", "p", false); }` }), [], "a decrease");
  assert.deepEqual(run({ [EVIL]: `export function f(out: { kind: "granted"; grant: { token: string } }) { return out.grant.token; }` }), [], "a data field");
  assert.deepEqual(run({ [EVIL]: `class Acl { grant(): void {} }\nexport function f(a: Acl) { return typeof a; }` }), [], "a method declared but not used");
});

test("refused: a local GrantAction declared inside the handler file itself", () => {
  const problems = run({ [FILES.handler]: `${BASE[FILES.handler]}\nnamespace L { export interface GrantAction { takeGrantMint(): unknown } }\nexport function f(j: Journal) { return (j.plugins as unknown as L.GrantAction).takeGrantMint(); }` });
  assert.ok(problems.some((p) => p.startsWith(`${FILES.handler}:`) && p.includes("takeGrantMint")), JSON.stringify(problems));
});

test("refused: a second value exported from cli-endpoint-action.ts", () => {
  const problems = run({ [FILES.switchAction]: `${BASE[FILES.switchAction]}\nexport const leak = 1;` });
  assert.ok(problems.some((p) => p.includes("cli-endpoint-action.ts must export exactly one value")), JSON.stringify(problems));
});

test("refused: takeSwitchMint in the composition but not straight into createCliEndpointSwitchAction", () => {
  const problems = run({ [FILES.compose]: `
import type { Journal } from "../../journal/src/journal.js";
import { createCliEndpointSwitchAction } from "./messages/cli-endpoint-action.js";
export function wire(j: Journal) { const m = j.cliEndpoint.takeSwitchMint(); return createCliEndpointSwitchAction(j.cliEndpoint, m); }` });
  assert.ok(problems.some((p) => p.startsWith(`${FILES.compose}:`) && p.includes("takeSwitchMint")), JSON.stringify(problems));
});

test("refused: the plugin grant mint handed to the switch action, or the switch mint to the grant action", () => {
  const crossed = run({ [FILES.compose]: `
import type { Journal } from "../../journal/src/journal.js";
import { createCliEndpointSwitchAction } from "./messages/cli-endpoint-action.js";
import { createGrantAction } from "./plugins/grant-action.js";
export function wire(j: Journal) { createCliEndpointSwitchAction(j.cliEndpoint, j.plugins.takeGrantMint() as never); return createGrantAction(j.plugins, j.cliEndpoint.takeSwitchMint() as never); }` });
  assert.ok(crossed.some((p) => p.includes("takeGrantMint")) && crossed.some((p) => p.includes("takeSwitchMint")), JSON.stringify(crossed));
});

test("allowed: the switch's reader anywhere, a data field named switchOn, the handler's own switchOff and the action's switchOn", () => {
  assert.deepEqual(run({ [EVIL]: `${JS}export function f(j: Journal) { return j.cliEndpoint.enabled(); }` }), [], "reading the switch");
  assert.deepEqual(run({ [EVIL]: `export function f(o: { switchOn: boolean }) { return o.switchOn; }` }), [], "a data field");
});

test("refused: either mint passed straight into a function that is not its own action's creator", () => {
  for (const [mint, store] of [["takeSwitchMint", "cliEndpoint"], ["takeGrantMint", "plugins"]]) {
    const problems = run({ [FILES.compose]: `${BASE[FILES.compose]}\nfunction keep(m: unknown) { return m; }\nexport function leak(j: Journal) { return keep(j.${store}.${mint}()); }` });
    assert.ok(problems.some((p) => p.startsWith(`${FILES.compose}:`) && p.includes(`${mint}()`)), `${mint}: ${JSON.stringify(problems)}`);
  }
});
