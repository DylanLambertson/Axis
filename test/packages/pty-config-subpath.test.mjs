// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-X1b (docs/design/pty-exec-node.md §6.6): main imports the hand-over names and their check from `@axis/pty-process/config`.
// That subpath must never reach the exec function, the service or the spawn adapter, and the daemon host may import it only from
// main's modules (`src/main/*.ts`); the daemon's own graph keeps reaching the pty process through `/client` only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript6";
import { ptyClientVerdict } from "./pty-client-rule.mjs";

const read = (rel) => readFileSync(new URL(`../../packages/pty-process/${rel}`, import.meta.url), "utf8");

/** Every module specifier of a TypeScript source: imports, re-exports, import types, dynamic imports and requires. */
function specifiers(source) {
  const sf = ts.createSourceFile("f.ts", source, ts.ScriptTarget.Latest, true);
  const out = [];
  const visit = (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier !== undefined) out.push(n.moduleSpecifier.text);
    else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteralLike(n.argument.literal)) out.push(n.argument.literal.text);
    else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) out.push(n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) ? n.arguments[0].text : "<dynamic>");
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The rule breaks of the config subpath's source (empty when fine): it may load only node:fs and node:path. */
export function configViolations(source) {
  return specifiers(source).filter((s) => s !== "node:fs" && s !== "node:path").map((s) => `config.ts loads ${s}`);
}

const CONFIG = read("src/config.ts");

test("the config subpath loads only node:fs and node:path, so it never reaches exec-node, the service or the spawn adapter", () => {
  assert.deepEqual(configViolations(CONFIG), []);
  assert.deepEqual(specifiers(CONFIG).sort(), ["node:fs", "node:path"]);
});

test("the checker refuses a config that reaches code that starts a program", () => {
  for (const [line, expected] of [
    ['import { createNodeExec } from "./exec-node.js";', "config.ts loads ./exec-node.js"],
    ['export { createPtyService } from "./service.js";', "config.ts loads ./service.js"],
    ['import type { SpawnFn } from "./ports.js";', "config.ts loads ./ports.js"],
    ['const cp = require("node:child_process");', "config.ts loads node:child_process"],
    ['const m = await import("./entry.js");', "config.ts loads ./entry.js"],
  ]) {
    assert.ok(configViolations(`${CONFIG}\n${line}\n`).includes(expected), expected);
  }
});

test("package.json maps ./config to the built config module, next to ., ./client and ./signal-guard (audit C M1)", () => {
  const exports = JSON.parse(read("package.json")).exports;
  assert.deepEqual(Object.keys(exports).sort(), [".", "./client", "./config", "./signal-guard"]);
  assert.deepEqual(exports["./config"], { types: "./dist/src/config.d.ts", default: "./dist/src/config.js" });
  assert.deepEqual(exports["./signal-guard"], { types: "./dist/src/signal-guard.d.ts", default: "./dist/src/signal-guard.js" });
});

test("the entry re-exports the names and the check from config.ts and defines none of them itself", () => {
  const entry = read("src/entry.ts");
  assert.match(entry, /^export \{ PTY_ENV_GH, PTY_ENV_GIT, PTY_ENV_SCRATCH, readPtyExecConfig, type PtyExecConfig \} from "\.\/config\.js";$/m);
  assert.doesNotMatch(entry, /export (const|function|interface) (PTY_ENV_|readPtyExecConfig|PtyExecConfig)/);
  assert.match(CONFIG, /export const PTY_ENV_GIT = "AXIS_PTY_GIT";/);
  assert.match(CONFIG, /export const PTY_ENV_GH = "AXIS_PTY_GH";/);
  assert.match(CONFIG, /export const PTY_ENV_SCRATCH = "AXIS_PTY_SCRATCH";/);
});

test("the daemon host may import /config only from a file directly in src/main/, and /client only from its binding", () => {
  const cases = [
    ["@axis/pty-process/config", "src/main/pty-handover.ts", "ok"],
    ["@axis/pty-process/config", "src/main/answers.ts", "ok"],
    ["@axis/pty-process/config", "src/main/sub/pty.ts", "refused"],
    ["@axis/pty-process/config", "src/bindings/pty-control.ts", "refused"],
    ["@axis/pty-process/config", "src/entry.ts", "refused"],
    ["@axis/pty-process/config", null, "refused"],
    ["@axis/pty-process/client", "src/bindings/pty-control.ts", "ok"],
    ["@axis/pty-process/client", "src/main/pty-handover.ts", "refused"],
    ["@axis/pty-process", "src/main/pty-handover.ts", "refused"],
    ["@axis/pty-process/entry", "src/main/pty-handover.ts", "refused"],
    ["@axis/pty-process/config/../exec-node", "src/main/pty-handover.ts", "refused"],
    ["@axis/pty-process/config", "test/main.test.ts", "ok"],
    ["@axis/pty-policy", "src/main/pty-handover.ts", null],
  ];
  for (const [spec, rel, expected] of cases) {
    const verdict = ptyClientVerdict(spec, rel);
    const got = verdict === null ? null : verdict === "ok" ? "ok" : "refused";
    assert.equal(got, expected, `${spec} from ${rel}`);
  }
});
