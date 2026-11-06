// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The web host isolation (ticket W1, docs/design/web-host-entry.md): only daemon-host/web/server.ts loads a socket built-in, and
// nothing outside daemon-host/web/ (no staged module, neither desktop entry) reaches the web host, on the staging hook's
// classification, on the staged files and on the esbuild metafile, directly and transitively.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ENTRY, SEAM_ENTRY, checkMetafile } from "../../scripts/code-oss/check-daemon-graph.mjs";
import { classifySpecifier } from "../../scripts/code-oss/stage-scan.mjs";
import { STAGE_ROOT, checkStagedFile } from "../../scripts/code-oss/stage-verify.mjs";
import { LISTENER_BUILTINS, WEB_ENTRIES, listenerReachViolations } from "../../scripts/code-oss/web-rules.mjs";

const D = (f) => `daemon-host/${f}`;
const P = (rel) => `${STAGE_ROOT}/${rel}`;
const stagedOf = (p) => (p.startsWith(`${STAGE_ROOT}/`) ? p.slice(STAGE_ROOT.length + 1) : null);
const FILES = ["index.ts", "entry.ts", "compose.ts", "supervisor.ts", "control/attestation.ts", "transport/mux.ts", "handlers/helper.ts", "web/index.ts", "web/server.ts", "web/session.ts", "gate/run-trust.ts"].map(D);
const manifest = { zod: null, files: FILES.map((path) => ({ path })) };
const exportsOf = () => [];

/** A metafile of the given edges; an importer starting with "src/" is outside the staged tree; "node:*" targets are external. */
const graph = (edges) => {
  const inputs = {};
  const at = (f) => (f.startsWith("src/") ? f : P(f));
  for (const [from, targets] of Object.entries(edges)) {
    inputs[at(from)] ??= { imports: [] };
    for (const t of targets) {
      if (t.startsWith("node:")) {
        inputs[at(from)].imports.push({ path: t, kind: "import-statement", external: true });
        continue;
      }
      inputs[at(from)].imports.push({ path: at(t), kind: "import-statement" });
      inputs[at(t)] ??= { imports: [] };
    }
  }
  return { inputs };
};
/** The real shape: the desktop entries reach the host and the supervisor; the web host reaches shared host modules. */
const GOOD = {
  [DEFAULT_ENTRY]: [D("entry.ts")],
  [SEAM_ENTRY]: [D("supervisor.ts"), "node:crypto"],
  [D("entry.ts")]: [D("compose.ts"), D("transport/mux.ts")],
  [D("compose.ts")]: [D("gate/run-trust.ts"), D("handlers/helper.ts")],
  [D("web/index.ts")]: [D("web/server.ts")],
  [D("web/server.ts")]: [D("web/session.ts"), D("control/attestation.ts"), D("transport/mux.ts"), "node:http", "node:crypto"],
};

test("the legitimate graph passes, the web host included", () => {
  assert.deepEqual(checkMetafile(graph(GOOD), manifest), []);
  assert.deepEqual(listenerReachViolations(graph(GOOD), stagedOf), []);
  assert.equal(WEB_ENTRIES.size, 0, "no overlay file may load the web host until the reh tunnel (W1b) exists");
});

test("classify: a socket built-in only in daemon-host web/server.ts", () => {
  for (const spec of LISTENER_BUILTINS) {
    // `node:http2` is refused by the staging hook's built-in pattern anyway (no digits), wherever it appears.
    if (spec !== "node:http2") assert.equal(classifySpecifier(spec, "daemon-host", exportsOf, "web/server.ts").kind, "node", spec);
    for (const [pkg, rel] of [["daemon-host", "web/session.ts"], ["daemon-host", "entry.ts"], ["daemon-host", "supervisor.ts"], ["daemon", "web/server.ts"], ["daemon-host", null]]) {
      assert.throws(() => classifySpecifier(spec, pkg, exportsOf, rel), spec === "node:http2" ? /malformed/ : /opens sockets/, `${pkg} ${rel} ${spec}`);
    }
  }
  assert.throws(() => classifySpecifier("node:http/x", "daemon-host", exportsOf, "host.ts"), /opens sockets/, "a subpath is the same built-in");
  assert.equal(classifySpecifier("node:crypto", "daemon-host", exportsOf, "entry.ts").kind, "node");
});

test("staged files: socket built-ins and edges into web/ are refused outside the web host", () => {
  const files = new Set(FILES);
  checkStagedFile(D("web/server.ts"), 'import { createServer } from "node:http";\nimport "./session.js";\nimport "../control/attestation.js";\n', files);
  checkStagedFile(D("web/index.ts"), 'export * from "./server.js";\n', files);
  for (const [from, text] of [
    [D("web/session.ts"), 'import "node:net";\n'],
    [D("entry.ts"), 'import "node:http";\n'],
    [D("supervisor.ts"), 'import { connect } from "node:tls";\n'],
    ["daemon/index.ts", 'import "node:dgram";\n'],
  ]) {
    assert.throws(() => checkStagedFile(from, text, files), /opens sockets/, `${from}`);
  }
  for (const [from, spec] of [[D("index.ts"), "./web/index.js"], [D("entry.ts"), "./web/server.js"], [D("supervisor.ts"), "./web/session.js"], [D("transport/mux.ts"), "../web/index.js"], ["daemon/index.ts", "../daemon-host/web/index.js"]]) {
    assert.throws(() => checkStagedFile(from, `import "${spec}";\n`, new Set([...files, "daemon/index.ts"])), /web host/, `${from} -> ${spec}`);
  }
});

test("metafile: a socket built-in outside the listener is refused, in staged modules and in the desktop entry files", () => {
  for (const [from, extra] of [[D("web/session.ts"), "node:net"], [D("entry.ts"), "node:http"], [D("supervisor.ts"), "node:https"], [DEFAULT_ENTRY, "node:http"], [SEAM_ENTRY, "node:net"]]) {
    const found = checkMetafile(graph({ ...GOOD, [from]: [...(GOOD[from] ?? []), extra] }), manifest);
    assert.ok(found.some((v) => v.includes(from) && /opens sockets/.test(v)), `${from}: ${found.join("; ")}`);
  }
});

test("metafile: a direct edge into the web host from either desktop entry or any staged module outside web/ is refused", () => {
  for (const [from, to] of [[DEFAULT_ENTRY, "web/index.ts"], [SEAM_ENTRY, "web/server.ts"], [D("entry.ts"), "web/index.ts"], [D("compose.ts"), "web/session.ts"], [D("supervisor.ts"), "web/server.ts"], [D("index.ts"), "web/index.ts"], ["src/vs/axis/other/node/x.ts", "web/index.ts"]]) {
    const found = checkMetafile(graph({ ...GOOD, [from]: [...(GOOD[from] ?? []), D(to)] }), manifest);
    const direct = found.filter((v) => v.startsWith(`${from.startsWith("src/") ? from : P(from)}: `) && /web host/.test(v));
    assert.equal(direct.length, 1, `${from} -> ${to}: ${found.join("; ")}`);
    assert.ok(!found.some((v) => v.startsWith(`${from.startsWith("src/") ? from : from} -> ${D(to)}:`)), "the walk does not repeat a direct edge already named");
  }
});

test("walk: the desktop bundles cannot reach the web host through a chain of helpers, even with the per-edge rule missing", () => {
  const chain = { ...GOOD, [D("transport/mux.ts")]: [D("handlers/helper.ts")], [D("handlers/helper.ts")]: [D("web/index.ts")] };
  const found = listenerReachViolations(graph(chain), stagedOf);
  for (const start of [DEFAULT_ENTRY, SEAM_ENTRY]) {
    const g = start === SEAM_ENTRY ? { ...chain, [SEAM_ENTRY]: [D("supervisor.ts")], [D("supervisor.ts")]: [D("transport/mux.ts")] } : chain;
    const v = listenerReachViolations(graph(g), stagedOf).find((x) => x.path[0] === start);
    assert.ok(v, `${start}: ${JSON.stringify(found)}`);
    assert.equal(v.path.at(-1), D("web/index.ts"));
  }
  const texts = checkMetafile(graph(chain), manifest);
  assert.ok(texts.some((t) => t.startsWith(`${DEFAULT_ENTRY} -> ${D("entry.ts")} -> `) && t.includes(`${D("handlers/helper.ts")} -> ${D("web/index.ts")}: reaches`)), texts.join("; "));
  // A cycle back out of the web host into a shared module and into web/ again is still a shared module reaching the web host.
  const cycle = { ...GOOD, [D("control/attestation.ts")]: [D("web/session.ts")] };
  const cyc = listenerReachViolations(graph(cycle), stagedOf);
  assert.ok(cyc.some((v) => v.path[0] === D("control/attestation.ts")), JSON.stringify(cyc));
});

test("walk: an overlay file listed in WEB_ENTRIES may load the web host; nothing upstream of a refused module gets through", () => {
  const entry = "src/vs/axis/server/node/axisWebMain.ts";
  const g = { ...GOOD, [entry]: [D("web/index.ts")] };
  assert.equal(listenerReachViolations(graph(g), stagedOf).length, 1);
  WEB_ENTRIES.add(entry);
  try {
    assert.deepEqual(listenerReachViolations(graph(g), stagedOf), []);
    assert.deepEqual(checkMetafile(graph(g), manifest), []);
  } finally {
    WEB_ENTRIES.delete(entry);
  }
});

test("the web host is not a composition point: a path from web/ to the composition root or a minter is refused", () => {
  for (const target of ["compose.ts", "entry.ts", "index.ts", "gate/run-trust.ts"]) {
    const found = checkMetafile(graph({ ...GOOD, [D("web/server.ts")]: [...GOOD[D("web/server.ts")], D(target)] }), manifest);
    assert.ok(found.some((v) => v.includes(D("web/server.ts")) && v.includes(target)), `${target}: ${found.join("; ")}`);
  }
  const files = new Set(FILES);
  for (const spec of ["../compose.js", "../entry.js", "../index.js", "../gate/run-trust.js"]) assert.throws(() => checkStagedFile(D("web/server.ts"), `import "${spec}";\n`, files), /may import|reaches/, spec);
});
