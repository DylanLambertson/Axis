// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The daemon's egress client (PV-N1d slice B, scripts/code-oss/web-rules.mjs rule 1b, egress-rules.mjs rule 1): the ONE
// daemon file that may load node:https and node:dns (lookup only), pinned by its SHA-256, imported only by the composition
// root. Judged by the import lint, the staging classification, the staged-tree check and the bundle graph check alike.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { importSpecifiers, unsafeForms } from "../../scripts/code-oss/stage-ast.mjs";
import { EGRESS_CLIENT_TYPES, EGRESS_CLIENT_VALUES, namesEgressClient } from "../../scripts/code-oss/egress-client-imports.mjs";
import { classifySpecifier } from "../../scripts/code-oss/stage-scan.mjs";
import { STAGE_ROOT, checkStagedFile } from "../../scripts/code-oss/stage-verify.mjs";
import { DEFAULT_ENTRY, checkMetafile } from "../../scripts/code-oss/check-daemon-graph.mjs";
import { EGRESS_CLIENT_FILE, EGRESS_CLIENT_IMPORTERS, EGRESS_CLIENT_SHA256, EGRESS_DNS_IMPORT, STAGED_NOTICE, egressClientEdgeRefusal, egressClientPinRefusals, listenerBuiltinRefusal, sourceSha256 } from "../../scripts/code-oss/web-rules.mjs";
import { egressBuiltinRefusal } from "../../scripts/code-oss/egress-rules.mjs";
import { violation } from "./imports.test.mjs";

const packagesDir = fileURLToPath(new URL("../../packages/", import.meta.url));
const CLIENT_SRC = join(packagesDir, "daemon-host", "src", "net", "egress-client.ts");
const SOURCE = readFileSync(CLIENT_SRC, "utf8");
const split = (staged) => [staged.split("/")[0], staged.split("/").slice(1).join("/")];
/** The four checks on one (staged path, specifier): [lint, classify, verify, graph], true where the check refuses. */
const verdicts = (staged, spec) => {
  const [pkg, rel] = split(staged);
  const dir = join(packagesDir, pkg);
  const lint = violation(pkg, spec, join(dir, "src", ...rel.split("/")), dir) !== null;
  let classify = false;
  try { classifySpecifier(spec, pkg, () => [], rel); } catch (e) { assert.equal(typeof e, "string"); classify = true; }
  let verify = false;
  // The staged-tree check also holds the client to its pin, so the client's allowed built-ins are judged on its real text
  // (which loads both); any other text for the client is refused, by the pin if not by the built-in rule.
  const text = staged === EGRESS_CLIENT_FILE && (spec === "node:https" || spec === "node:dns") ? SOURCE : `import "${spec}";\n`;
  const deps = ["daemon-host/net/address.ts", "daemon-host/net/egress-errors.ts", "daemon-host/net/egress-limits.ts", "daemon-host/net/host.ts", "protocol/index.ts"];
  try { checkStagedFile(staged, text, new Set([staged, ...deps])); } catch (e) {
    assert.equal(e.name, "StageError", String(e));
    // The real text fails the staged-tree check for being unstaged (a bare @axis import); what matters is that no built-in rule refused it.
    verify = text === SOURCE ? /opens sockets|resolves names/.test(String(e)) : true;
  }
  const P = (r) => `${STAGE_ROOT}/${r}`;
  const meta = { inputs: { [DEFAULT_ENTRY]: { imports: [{ path: P(staged), kind: "import-statement" }] }, [P(staged)]: { imports: [{ path: spec, kind: "import-statement", external: true }] } } };
  const graph = checkMetafile(meta, { zod: null, files: [{ path: staged }] }).some((t) => t.includes(spec));
  return [lint, classify, verify, graph];
};
const all = (v, want, what) => assert.deepEqual(v, [want, want, want, want], `${what}: [lint, classify, verify, graph]`);

test("the egress client may load exactly node:https and node:dns, in the desktop bundles too", () => {
  assert.equal(EGRESS_CLIENT_FILE, "daemon-host/net/egress-client.ts");
  all(verdicts(EGRESS_CLIENT_FILE, "node:https"), false, "node:https");
  all(verdicts(EGRESS_CLIENT_FILE, "node:dns"), false, "node:dns");
  assert.equal(listenerBuiltinRefusal("node:https", EGRESS_CLIENT_FILE, { desktop: true }), null);
  for (const spec of ["node:http", "node:http2", "node:tls", "node:net", "node:dgram", "node:https/x", "node:dns/promises"]) all(verdicts(EGRESS_CLIENT_FILE, spec), true, spec);
});

test("no other daemon file may load node:https or node:dns, statically or dynamically", () => {
  const others = ["daemon-host/net/host.ts", "daemon-host/net/address.ts", "daemon-host/net/egress-limits.ts", "daemon-host/compose.ts", "daemon-host/bindings/providers.ts", "daemon-host/net/egress-client.tsx", "daemon-host/net/sub/egress-client.ts", "daemon/net/egress-client.ts"];
  for (const f of others) for (const spec of ["node:https", "node:dns", "node:tls", "node:net", "node:http"]) all(verdicts(f, spec), true, `${spec} in ${f}`);
  assert.notEqual(egressBuiltinRefusal("node:dns", null), null, "a call without a file is judged strictly");
  for (const form of ['await import("node:https");', 'require("node:dns");', 'const h = await import("node:tls");']) {
    const specs = importSpecifiers(form, "x.ts");
    assert.equal(specs.length, 1, form);
    assert.notEqual(violation("daemon-host", specs[0], join(packagesDir, "daemon-host", "src", "x.ts"), join(packagesDir, "daemon-host")), null, form);
  }
  assert.ok(unsafeForms("const m = 'node:https'; await import(m);", "daemon-host/x.ts").length > 0, "a computed import is refused");
});

test("the client is pinned: its text, and its one node:dns form", () => {
  assert.equal(sourceSha256(SOURCE), EGRESS_CLIENT_SHA256, "the egress client changed: review it and update the pin in web-rules.mjs");
  assert.deepEqual(egressClientPinRefusals(EGRESS_CLIENT_FILE, SOURCE), []);
  assert.deepEqual(egressClientPinRefusals(EGRESS_CLIENT_FILE, SOURCE.replace(/\n/g, "\r\n")), [], "CRLF reads as LF");
  const [first, ...rest] = SOURCE.split("\n");
  assert.deepEqual(egressClientPinRefusals(EGRESS_CLIENT_FILE, [first, `// ${STAGED_NOTICE}`, ...rest].join("\n")), [], "as staged");
  assert.match(egressClientPinRefusals(EGRESS_CLIENT_FILE, `${SOURCE}\n`)[0] ?? "", /is not the pinned egress client/, "any edit");
  assert.ok(checkStagedFileFails(SOURCE.replace('minVersion: "TLSv1.2", keepAlive', "keepAlive")), "the staged-tree check refuses an edited client");
  for (const form of ['import * as dns from "node:dns";', 'import dns from "node:dns";', 'import { lookup, resolve4 } from "node:dns";', 'import { Resolver } from "node:dns";']) {
    const edited = SOURCE.replace(EGRESS_DNS_IMPORT, form);
    assert.ok(egressClientPinRefusals(EGRESS_CLIENT_FILE, edited).some((t) => t.includes("node:dns must appear once")), form);
  }
  assert.ok(egressClientPinRefusals(EGRESS_CLIENT_FILE, `${SOURCE}\nconst d = require('node:dns/promises');`).some((t) => t.includes("node:dns must appear once")), "a second use, quoted another way");
  assert.ok(egressClientPinRefusals(EGRESS_CLIENT_FILE, `${SOURCE}\nimport("node:dns");`).some((t) => t.includes("node:dns must appear once")), "a second use");
  assert.deepEqual(egressClientPinRefusals("daemon-host/net/host.ts", "anything"), [], "the pin is the client's alone");
});

function checkStagedFileFails(text) {
  try {
    checkStagedFile(EGRESS_CLIENT_FILE, text, new Set([EGRESS_CLIENT_FILE, "daemon-host/net/address.ts", "daemon-host/net/egress-errors.ts", "daemon-host/net/egress-limits.ts", "daemon-host/net/host.ts"]));
  } catch (e) {
    return String(e).includes("pinned egress client");
  }
  return false;
}

test("only the composition root may import the client, by every check", () => {
  assert.deepEqual([...EGRESS_CLIENT_IMPORTERS], ["daemon-host/compose.ts"]);
  assert.equal(egressClientEdgeRefusal("daemon-host/compose.ts", EGRESS_CLIENT_FILE), null);
  assert.equal(egressClientEdgeRefusal("daemon-host/compose.ts", "daemon-host/net/egress-client.js"), null);
  for (const from of ["daemon-host/compose-serving.ts", "daemon-host/index.ts", "daemon-host/net/host.ts", "daemon-host/handlers/agents.ts", null]) {
    assert.notEqual(egressClientEdgeRefusal(from, EGRESS_CLIENT_FILE), null, String(from));
  }
  assert.notEqual(egressClientEdgeRefusal("daemon-host/handlers/x.ts", "daemon-host/net/egress-client.js"), null, "the .js spelling is the client too");
  assert.equal(egressClientEdgeRefusal("daemon-host/x.ts", "daemon-host/net/host.ts"), null, "other files are not the client");
  const dir = join(packagesDir, "daemon-host");
  assert.notEqual(violation("daemon-host", "../net/egress-client.js", join(dir, "src", "handlers", "x.ts"), dir), null, "lint: a handler");
  assert.notEqual(violation("daemon-host", "./egress-client.js", join(dir, "src", "net", "x.ts"), dir), null, "lint: a sibling");
  assert.equal(violation("daemon-host", "./net/egress-client.js", join(dir, "src", "compose.ts"), dir), null, "lint: the composition root");
  assert.equal(violation("daemon-host", "../../src/net/egress-client.js", join(dir, "test", "net", "a.test.ts"), dir), null, "lint: tests");
  const files = new Set([EGRESS_CLIENT_FILE, "daemon-host/handlers/x.ts", "daemon-host/compose.ts"]);
  assert.throws(() => checkStagedFile("daemon-host/handlers/x.ts", 'import { createEgressClient } from "../net/egress-client.js";\n', files), /is the egress client/, "verify: a handler");
  assert.doesNotThrow(() => checkStagedFile("daemon-host/compose.ts", 'import { createEgressClient } from "./net/egress-client.js";\nexport const c = createEgressClient;\n', files), "verify: the composition root");
  const P = (r) => `${STAGE_ROOT}/${r}`;
  const meta = (from) => ({ inputs: { [DEFAULT_ENTRY]: { imports: [{ path: P(from), kind: "import-statement" }] }, [P(from)]: { imports: [{ path: P(EGRESS_CLIENT_FILE), kind: "import-statement" }] }, [P(EGRESS_CLIENT_FILE)]: { imports: [] } } });
  const manifest = (from) => ({ zod: null, files: [{ path: from }, { path: EGRESS_CLIENT_FILE }] });
  assert.ok(checkMetafile(meta("daemon-host/handlers/x.ts"), manifest("daemon-host/handlers/x.ts")).some((t) => t.includes("is the egress client")), "graph: a handler");
  assert.ok(!checkMetafile(meta("daemon-host/compose.ts"), manifest("daemon-host/compose.ts")).some((t) => t.includes("is the egress client")), "graph: the composition root");
});

test("an importer may take only the production factory and the client's types, by static named import (review 1 S1)", () => {
  assert.deepEqual([...EGRESS_CLIENT_VALUES].sort(), ["EGRESS_METHODS", "createEgressClient"]);
  assert.ok(!EGRESS_CLIENT_TYPES.has("EgressTestSeam"));
  const shape = (text, file = "daemon-host/compose.ts") => unsafeForms(text, file, { pkg: "daemon-host" }).filter((t) => /(?:of|from) the egress client|egress client \(only/.test(t));
  const ok = [
    'import { createEgressClient } from "./net/egress-client.js";',
    'import { createEgressClient as make, type EgressClient } from "./net/egress-client.js";',
    'import type { EgressRequest, EgressResponse } from "./net/egress-client.js";',
    'import { EGRESS_METHODS } from "./net/egress-client.js";',
  ];
  for (const text of ok) assert.deepEqual(shape(text), [], text);
  const refused = [
    'import * as egress from "./net/egress-client.js"; egress[["createEgressClient", "For", "Test"].join("")]({}, {});',
    'import * as egress from "./net/egress-client";',
    'import egress from "./net/egress-client.js";',
    'import "./net/egress-client.js";',
    'import { createEgressClientForTest } from "./net/egress-client.js";',
    'import { createEgressClient, createEgressClientForTest as x } from "./net/egress-client.js";',
    'import type { EgressTestSeam } from "./net/egress-client.js";',
    'export { createEgressClientForTest } from "./net/egress-client.js";',
    'export * from "./net/egress-client.js";',
    'export * as e from "./net/egress-client.js";',
    'const e = await import("./net/egress-client.js");',
    'const e = require("./net/egress-client.js");',
    'import e = require("./net/egress-client.js");',
    'type T = import("./net/egress-client.js").EgressTestSeam;',
    'import { createEgressClientForTest } from "./net/../net/egress-client.ts";',
  ];
  for (const text of refused) assert.ok(shape(text).length > 0, text);
  assert.match(shape('import egress from "./net/egress-client.js";').join(), /a default import of the egress client/);
  assert.match(shape('import egress, { createEgressClient } from "./net/egress-client.js";').join(), /a default import of the egress client/, "a default beside named imports");
  assert.ok(shape('import { createEgressClientForTest } from "../net/egress-client.js";', "daemon-host/handlers/x.ts").length > 0, "from any directory");
  assert.deepEqual(shape('import { createEgressClientForTest } from "./egress-client.js";', EGRESS_CLIENT_FILE), [], "the client itself is not an importer");
  assert.ok(namesEgressClient("daemon-host/compose.ts", "./net/egress-client.mjs"));
  assert.ok(!namesEgressClient("daemon-host/compose.ts", "./net/egress-client-x.js"));
  for (const spelling of ["./net/egress-client.js?x", "./net/egress-client.js#x", "./net/egress-clien%74.js", "./net/egress-client.d.ts", "./net/%65gress-client", "./net/egress-client.js%", "./net/egress-client.tsx"]) {
    assert.ok(namesEgressClient("daemon-host/compose.ts", spelling), spelling);
    assert.ok(shape(`import * as e from "${spelling}";`).length > 0, `a namespace import through ${spelling}`);
  }
  assert.ok(!namesEgressClient("daemon-host/compose.ts", "@axis/daemon-host"));
  assert.ok(!namesEgressClient(null, "./net/egress-client.js"));
  // The staged-tree check applies it: compose.ts may import the client, but not the test factory.
  const files = new Set([EGRESS_CLIENT_FILE, "daemon-host/compose.ts"]);
  assert.throws(() => checkStagedFile("daemon-host/compose.ts", 'import * as e from "./net/egress-client.js";\nexport const x = e;\n', files), /namespace import of the egress client/);
});
