// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Rule 1 of web-rules.mjs, widened for the CLI messaging endpoint (ADR 0007 decision 7.1, PV-M6): besides the web host
// listener, exactly one more staged file, the endpoint template pty-process/endpoint-listen.ts, may load exactly one socket
// built-in, node:net, and its whole content is pinned by SHA-256 (no analysis of arbitrary code). The desktop bundles (daemon,
// main seam) keep refusing every socket built-in outside the web host and may not reach the template at all. NET-1's "no TCP
// listener in a desktop run" stays as it was: the packaged check lists TCP sockets only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_ENTRY, SEAM_ENTRY, checkMetafile } from "../../scripts/code-oss/check-daemon-graph.mjs";
import { parseLsofListeners } from "../../scripts/code-oss/check-net-packaged.mjs";
import { unsafeForms } from "../../scripts/code-oss/stage-ast.mjs";
import { classifySpecifier } from "../../scripts/code-oss/stage-scan.mjs";
import { STAGE_ROOT, checkStagedFile } from "../../scripts/code-oss/stage-verify.mjs";
import { ENDPOINT_LISTENER_FILE, ENDPOINT_LISTENER_SHA256, LISTENER_BUILTINS, STAGED_NOTICE, LISTENER_FILE, LISTENER_FILES, endpointPinRefusals, listenerBuiltinRefusal } from "../../scripts/code-oss/web-rules.mjs";

const exportsOf = () => [];
const TEMPLATE = readFileSync(fileURLToPath(new URL("../../packages/pty-process/src/endpoint-listen.ts", import.meta.url)), "utf8");

test("rule 1: exactly two files may load socket built-ins; the endpoint template only node:net, and only the bare specifier", () => {
  assert.equal(ENDPOINT_LISTENER_FILE, "pty-process/endpoint-listen.ts");
  assert.deepEqual([...LISTENER_FILES.keys()].sort(), [LISTENER_FILE, ENDPOINT_LISTENER_FILE].sort(), "no third file");
  assert.deepEqual([...LISTENER_FILES.get(ENDPOINT_LISTENER_FILE)], ["node:net"]);
  assert.equal(classifySpecifier("node:net", "pty-process", exportsOf, "endpoint-listen.ts").kind, "node");
  for (const spec of LISTENER_BUILTINS) {
    if (spec === "node:net" || spec === "node:http2") continue; // http2 is a malformed specifier for the hook anyway
    assert.throws(() => classifySpecifier(spec, "pty-process", exportsOf, "endpoint-listen.ts"), /may load only node:net/, spec);
  }
  assert.match(listenerBuiltinRefusal("node:net/x", ENDPOINT_LISTENER_FILE) ?? "", /may load only node:net/, "a subpath is refused there");
  for (const [pkg, rel] of [["pty-process", "endpoint-host.ts"], ["pty-process", "service.ts"], ["pty-process", "client.ts"], ["daemon-host", "messages/endpoint.ts"], ["pty-process", null]]) {
    assert.throws(() => classifySpecifier("node:net", pkg, exportsOf, rel), /opens sockets/, `${pkg} ${rel}: a second file with node:net`);
  }
  assert.throws(() => checkStagedFile("pty-process/endpoint-host.ts", 'import { createServer } from "node:net";\n', new Set(["pty-process/endpoint-host.ts"])), /opens sockets/);
  assert.equal(listenerBuiltinRefusal("node:https", LISTENER_FILE), null, "the web host listener is unchanged");
});

test("the template is pinned: the real file hashes to the pin, and any changed byte fails the import lint and the staged-tree check", () => {
  const sha = createHash("sha256").update(TEMPLATE.replace(/\r\n/g, "\n"), "utf8").digest("hex");
  assert.equal(sha, ENDPOINT_LISTENER_SHA256, "the template changed: review it and update the pin in web-rules.mjs");
  assert.deepEqual(endpointPinRefusals(ENDPOINT_LISTENER_FILE, TEMPLATE), []);
  assert.deepEqual(endpointPinRefusals(ENDPOINT_LISTENER_FILE, TEMPLATE.replace(/\n/g, "\r\n")), [], "CRLF reads as LF");
  const [first, ...rest] = TEMPLATE.split("\n");
  const staged = [first, `// ${STAGED_NOTICE}`, ...rest].join("\n");
  assert.deepEqual(endpointPinRefusals(ENDPOINT_LISTENER_FILE, staged), [], "the staging hook's notice as the second line, as staged");
  assert.ok(endpointPinRefusals(ENDPOINT_LISTENER_FILE, `${staged}\n// ${STAGED_NOTICE}`).length > 0, "the notice anywhere else is a change");
  assert.ok(endpointPinRefusals(ENDPOINT_LISTENER_FILE, [first, "// another line", ...rest].join("\n")).length > 0, "any other second line is a change");
  assert.deepEqual(unsafeForms(TEMPLATE, "src/endpoint-listen.ts", { pkg: "pty-process", pkgRel: "src/endpoint-listen.ts" }), [], "the import lint");
  const files = new Set([ENDPOINT_LISTENER_FILE]);
  assert.doesNotThrow(() => checkStagedFile(ENDPOINT_LISTENER_FILE, TEMPLATE, files), "the staged-tree check");
  const at = TEMPLATE.indexOf("server.listen(path");
  assert.ok(at > 0);
  for (const [what, changed] of [
    ["one byte flipped", TEMPLATE.slice(0, at) + "server.listen(8080" + TEMPLATE.slice(at + "server.listen(path".length)],
    ["a second listen", TEMPLATE.replace("  return Object.freeze(", "  server.listen(8080);\n  return Object.freeze(")],
    ["a trailing space", `${TEMPLATE} `],
  ]) {
    assert.match(endpointPinRefusals(ENDPOINT_LISTENER_FILE, changed)[0] ?? "", /is not the pinned endpoint template/, what);
    assert.ok(unsafeForms(changed, "src/endpoint-listen.ts", { pkg: "pty-process", pkgRel: "src/endpoint-listen.ts" }).some((m) => /pinned endpoint template/.test(m)), `${what}: the import lint`);
    assert.throws(() => checkStagedFile(ENDPOINT_LISTENER_FILE, changed, files), /pinned endpoint template/, `${what}: the staged-tree check`);
  }
  assert.deepEqual(endpointPinRefusals("pty-process/endpoint-host.ts", "anything"), [], "the pin is the template's alone");
});

test("in the desktop bundles only the web host may load a socket built-in, and the endpoint template may not be reached at all", () => {
  const P = (rel) => `${STAGE_ROOT}/${rel}`;
  const manifest = { zod: null, files: ["pty-process/endpoint-listen.ts", "pty-process/endpoint-host.ts", "pty-process/index.ts", "daemon-host/entry.ts"].map((path) => ({ path })) };
  const graph = (edges) => ({ inputs: Object.fromEntries(Object.entries(edges).map(([from, tos]) => [from, { imports: tos.map((to) => (to.startsWith("node:") ? { path: to, external: true } : { path: to })) }])) });
  assert.notEqual(listenerBuiltinRefusal("node:net", ENDPOINT_LISTENER_FILE, { desktop: true }), null, "the per-file allowance is not a desktop one");
  for (const entry of [DEFAULT_ENTRY, SEAM_ENTRY]) {
    const direct = checkMetafile(graph({ [entry]: [P("pty-process/endpoint-listen.ts")], [P("pty-process/endpoint-listen.ts")]: ["node:net"] }), manifest);
    assert.ok(direct.some((v) => /opens sockets: in a desktop bundle/.test(v)), `${entry}: node:net inside the bundle: ${direct.join("; ")}`);
    assert.ok(direct.some((v) => /endpoint listener, which no desktop bundle may contain/.test(v)), `${entry}: the file is reached: ${direct.join("; ")}`);
    const via = checkMetafile(graph({ [entry]: [P("daemon-host/entry.ts")], [P("daemon-host/entry.ts")]: [P("pty-process/endpoint-host.ts")], [P("pty-process/endpoint-host.ts")]: [P("pty-process/endpoint-listen.ts")], [P("pty-process/endpoint-listen.ts")]: [] }), manifest);
    assert.ok(via.some((v) => /pty-process\/endpoint-host\.ts -> pty-process\/endpoint-listen\.ts: reaches the pty process endpoint listener/.test(v)), `${entry}: transitively: ${via.join("; ")}`);
  }
  assert.ok(checkMetafile(graph({ [DEFAULT_ENTRY]: [P("pty-process/index.ts")], [P("pty-process/index.ts")]: ["node:net"] }), manifest).some((v) => /opens sockets/.test(v)), "any other file: refused as before");
});

test("NET-GATE stays TCP: the packaged check lists TCP listeners only, so a Unix socket is not counted and a TCP one always is", () => {
  const script = readFileSync(fileURLToPath(new URL("../../scripts/code-oss/check-net-packaged.mjs", import.meta.url)), "utf8");
  assert.ok(script.includes('"-iTCP"') && script.includes('"-sTCP:LISTEN"') && script.includes('"/proc/net/tcp"') && script.includes('"/proc/net/tcp6"'));
  assert.equal(script.includes("/proc/net/unix"), false);
  const lsof = "p10\nn/run/user/1000/axis/Ab3.sock\np10\nn127.0.0.1:8080\n";
  assert.deepEqual(parseLsofListeners(lsof, [10]).map((l) => l.port), [8080], "a socket path has no port; a TCP listener is still found");
});
