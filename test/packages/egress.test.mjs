// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Daemon egress (reviews c6 SF-1 and egress-lint r1): the global network clients appear in shipped code only as the `fetch`
// option handed to the Anthropic adapter in daemon-host/src/bindings/providers.ts, and only the composition files load
// that binding. The rule is the shared module scanner's, so the import lint, the staging hook and the staged-tree check agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEgressFile, unsafeForms } from "../../scripts/code-oss/stage-ast.mjs";
import { checkStagedFile } from "../../scripts/code-oss/stage-verify.mjs";
import { PROVIDERS_IMPORTERS, violation } from "./imports.test.mjs";

const packagesDir = fileURLToPath(new URL("../../packages/", import.meta.url));
const hostDir = join(packagesDir, "daemon-host");
const at = (rel) => join(hostDir, ...rel.split("/"));
const EGRESS_REL = "src/bindings/providers.ts";
const egressFindings = (src, opts) => unsafeForms(src, opts.file ?? "x.ts", { shipped: true, ...opts }).filter((m) => /network requests/.test(m));
/** As the import lint calls the scanner: the absolute path and the package-relative one. */
const lint = (src, pkgRel, pkg = "daemon-host") => egressFindings(src, { file: join(packagesDir, pkg, ...pkgRel.split("/")), pkg, pkgRel });

const ADAPTER = [
  "createAnthropicAdapter({ fetch });",
  "createAnthropicAdapter({ connectionId, apiKey, fetch: conn.fetch ?? ((url, init) => fetch(url, init) as unknown as R) });",
  "createAnthropicAdapter({ fetch: fetch as never });",
  "createAnthropicAdapter({ fetch: c ? (u) => fetch(u) : (u) => fetch(u, x) });",
];

test("shipped code of any package and any other file refuses every global network client, in every form", () => {
  const uses = ["fetch(u);", "new WebSocket(u);", "new EventSource(u);", "new XMLHttpRequest();", "const f = fetch; f(u);", "g(fetch);", "const o = { fetch };", "fetch?.(u);", "(0, fetch)(u);", "(fetch as any)(u);", "globalThis.fetch(u);", 'globalThis["fetch"](u);', "globalThis?.fetch(u);", "globalThis[k](u);", "Reflect.get(globalThis, 'fetch');", "const { fetch: f } = globalThis;", ...ADAPTER];
  for (const src of uses) {
    for (const rel of ["src/handlers/git.ts", "src/bindings/agent.ts", "src/compose.ts", "src/web/server.ts"]) assert.ok(unsafeForms(src, at(rel), { pkg: "daemon-host", shipped: true, pkgRel: rel }).length >= 1, `${src} in ${rel}`);
    for (const pkg of ["anthropic", "providers", "broker"]) assert.ok(unsafeForms(src, join(packagesDir, pkg, "src", "a.ts"), { pkg, shipped: true, pkgRel: "src/a.ts" }).length >= 1, `${src} in ${pkg}`);
  }
  assert.deepEqual(unsafeForms("fetch(u);", at("test/a.test.ts"), { pkg: "daemon-host", shipped: false, pkgRel: "test/a.test.ts" }), [], "tests may");
});

test("the egress file is matched exactly as each caller names it, never as a suffix", () => {
  for (const [file, pkgRel] of [[at(EGRESS_REL), EGRESS_REL], ["packages/daemon-host/src/bindings/providers.ts", null], ["daemon-host/bindings/providers.ts", null], ["x.ts", EGRESS_REL], ["C:\\r\\x.ts", "src\\bindings\\providers.ts"]]) {
    assert.equal(isEgressFile(file, "daemon-host", pkgRel), true, `${file} ${pkgRel}`);
    assert.equal(isEgressFile(file, "providers", pkgRel), false, "only as the daemon host's file");
  }
  const nested = [
    ["packages/daemon-host/src/web/daemon-host/bindings/providers.ts", null],
    ["packages/daemon-host/src/handlers/daemon-host/bindings/providers.ts", null],
    ["packages/daemon-host/src/handlers/packages/daemon-host/src/bindings/providers.ts", null],
    ["daemon-host/web/daemon-host/bindings/providers.ts", null],
    ["xpackages/daemon-host/src/bindings/providers.ts", null],
    ["xdaemon-host/bindings/providers.ts", null],
    ["daemon-host/bindings/providers.ts.evil.ts", null],
    ["packages/daemon-host/src/bindings/providers.ts/x.ts", null],
    [at(EGRESS_REL), null],
    [at("src/web/daemon-host/bindings/providers.ts"), "src/web/daemon-host/bindings/providers.ts"],
    [at("src/handlers/packages/daemon-host/src/bindings/providers.ts"), "src/handlers/packages/daemon-host/src/bindings/providers.ts"],
    ["x.ts", "xsrc/bindings/providers.ts"],
    ["x.ts", "src/bindings/providers.ts.evil.ts"],
  ];
  for (const [file, pkgRel] of nested) {
    assert.equal(isEgressFile(file, "daemon-host", pkgRel), false, `${file} ${pkgRel}`);
    assert.ok(egressFindings(ADAPTER[0], { file, pkg: "daemon-host", pkgRel }).length >= 1, `${file} ${pkgRel}`);
  }
});

test("in the egress file `fetch` may only be the fetch option of createAnthropicAdapter: no wrapper, alias, export or other client", () => {
  for (const src of ADAPTER) assert.deepEqual(lint(src, EGRESS_REL), [], src);
  for (const src of [
    "export const f = (u, i) => fetch(u, i);",
    "export { fetch };",
    "export const W = WebSocket;",
    "const f = fetch;",
    "function g() { return fetch; }",
    "fetch(u);",
    "createAnthropicAdapter({ x: fetch });",
    "createAnthropicAdapter({ fetch: g(fetch) });",
    "createAnthropicAdapter({ fetch: (u) => { return fetch(u); } });",
    "createAnthropicAdapter({ fetch: (leak = (u) => fetch(u)) });",
    "createAnthropicAdapter({ fetch: { fetch } });",
    "createAnthropicAdapter({ ...{ fetch } });",
    "createAnthropicAdapter({ fetch: fetch && x });",
    "createAnthropicAdapter({ fetch: WebSocket });",
    "createAnthropicAdapter({ fetch: (u) => new EventSource(u) });",
    "other({ fetch });",
    "x.createAnthropicAdapter({ fetch });",
    "createAnthropicAdapter(fetch);",
    "const a = { fetch }; createAnthropicAdapter(a);",
    "new WebSocket(u);",
  ]) {
    assert.ok(lint(src, EGRESS_REL).length >= 1, src);
  }
  // The staged forms of the file follow the same rule.
  for (const file of ["packages/daemon-host/src/bindings/providers.ts", "daemon-host/bindings/providers.ts"]) {
    assert.deepEqual(egressFindings(ADAPTER[1], { file, pkg: "daemon-host" }), []);
    assert.ok(egressFindings("export const f = (u, i) => fetch(u, i);", { file, pkg: "daemon-host" }).length >= 1);
  }
});

test("the real providers binding passes the rule, and the same source anywhere else fails it", () => {
  const source = readFileSync(at(EGRESS_REL), "utf8");
  assert.ok(/\bfetch\(url, init\)/.test(source), "the binding hands the global fetch to the adapter");
  assert.deepEqual(lint(source, EGRESS_REL), []);
  assert.deepEqual(egressFindings(source, { file: "daemon-host/bindings/providers.ts", pkg: "daemon-host" }), []);
  for (const rel of ["src/web/daemon-host/bindings/providers.ts", "src/handlers/providers.ts", "src/bindings/agent.ts"]) assert.ok(lint(source, rel).length >= 1, rel);
  assert.ok(egressFindings(source, { file: "daemon-host/web/daemon-host/bindings/providers.ts", pkg: "daemon-host" }).length >= 1);
  assert.ok(lint(source, EGRESS_REL, "anthropic").length >= 1);
});

test("only the composition root, the host and the public index import the providers binding (lint and staged tree)", () => {
  assert.deepEqual([...PROVIDERS_IMPORTERS].sort(), ["src/compose.ts", "src/host.ts", "src/index.ts"]);
  for (const [from, spec] of [["src/compose.ts", "./bindings/providers.js"], ["src/host.ts", "./bindings/providers.js"], ["src/index.ts", "./bindings/providers.js"], ["test/a.test.ts", "../src/bindings/providers.js"]]) {
    assert.equal(violation("daemon-host", spec, at(from), hostDir), null, from);
  }
  for (const [from, spec] of [["src/bindings/agent.ts", "./providers.js"], ["src/handlers/providers.ts", "../bindings/providers.js"], ["src/compose-parts.ts", "./bindings/providers.js"], ["src/bindings/provider-redactor.ts", "./providers.ts"], ["src/web/server.ts", "../bindings/providers.js"]]) {
    assert.notEqual(violation("daemon-host", spec, at(from), hostDir), null, from);
  }
  const files = new Set(["daemon-host/bindings/providers.ts", "daemon-host/compose.ts", "daemon-host/host.ts", "daemon-host/index.ts", "daemon-host/handlers/git.ts", "daemon-host/bindings/agent.ts"]);
  for (const from of ["daemon-host/compose.ts", "daemon-host/host.ts", "daemon-host/index.ts"]) checkStagedFile(from, 'import "./bindings/providers.js";\n', files);
  assert.throws(() => checkStagedFile("daemon-host/handlers/git.ts", 'import "../bindings/providers.js";\n', files), /reaches daemon-host\/bindings\/providers\.ts/);
  assert.throws(() => checkStagedFile("daemon-host/bindings/agent.ts", 'import "./providers.js";\n', files), /reaches daemon-host\/bindings\/providers\.ts/);
});
