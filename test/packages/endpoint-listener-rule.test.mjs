// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Rule 1 of web-rules.mjs, widened for the CLI messaging endpoint (ADR 0007 decision 7.1, PV-M6 slice 2): besides the web host
// listener, exactly one more staged file, pty-process/endpoint-host.ts, may load exactly one socket built-in, node:net, and
// only `createServer` from it, listening only on a path (endpoint-ast.mjs, on the TypeScript AST). The desktop bundles (daemon,
// main seam) keep refusing every socket built-in outside the web host and may not reach the endpoint file at all. NET-1's
// "no TCP listener in a desktop run" stays as it was: the packaged check lists TCP sockets only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_ENTRY, SEAM_ENTRY, checkMetafile } from "../../scripts/code-oss/check-daemon-graph.mjs";
import { parseLsofListeners } from "../../scripts/code-oss/check-net-packaged.mjs";
import { unsafeForms } from "../../scripts/code-oss/stage-ast.mjs";
import { classifySpecifier } from "../../scripts/code-oss/stage-scan.mjs";
import { STAGE_ROOT, checkStagedFile } from "../../scripts/code-oss/stage-verify.mjs";
import { ENDPOINT_LISTENER_FILE, LISTENER_BUILTINS, LISTENER_FILE, LISTENER_FILES, listenerBuiltinRefusal } from "../../scripts/code-oss/web-rules.mjs";

const exportsOf = () => [];
const HEAD = 'import { createServer } from "node:net";\nimport { join } from "node:path";\n';
const OK = `${HEAD}export function open(dir: string): void {\n  const path = join(dir, "a.sock");\n  const server = createServer();\n  server.listen(path, () => undefined);\n}\n`;
/** The endpoint rules' findings for a source of the endpoint file. */
const rules = (source) => unsafeForms(source, "pty-process/endpoint-host.ts", { pkg: "pty-process" });
/** The OK source with one line replaced. */
const variant = (from, to) => {
  assert.ok(OK.includes(from), from);
  return OK.replace(from, to);
};

test("rule 1: exactly two files may load socket built-ins; the endpoint file only node:net, and only the bare specifier", () => {
  assert.deepEqual([...LISTENER_FILES.keys()].sort(), [LISTENER_FILE, ENDPOINT_LISTENER_FILE].sort(), "no third file");
  assert.deepEqual([...LISTENER_FILES.get(ENDPOINT_LISTENER_FILE)], ["node:net"]);
  assert.equal(classifySpecifier("node:net", "pty-process", exportsOf, "endpoint-host.ts").kind, "node");
  for (const spec of LISTENER_BUILTINS) {
    if (spec === "node:net" || spec === "node:http2") continue; // http2 is a malformed specifier for the hook anyway
    assert.throws(() => classifySpecifier(spec, "pty-process", exportsOf, "endpoint-host.ts"), /may load only node:net/, spec);
  }
  assert.match(listenerBuiltinRefusal("node:net/x", ENDPOINT_LISTENER_FILE) ?? "", /may load only node:net/, "a subpath is refused there");
  for (const [pkg, rel] of [["pty-process", "service.ts"], ["pty-process", "client.ts"], ["daemon-host", "messages/endpoint.ts"], ["pty-process", null]]) {
    assert.throws(() => classifySpecifier("node:net", pkg, exportsOf, rel), /opens sockets/, `${pkg} ${rel}`);
  }
  assert.equal(listenerBuiltinRefusal("node:https", LISTENER_FILE), null, "the web host listener is unchanged");
});

test("review blocker 1: in the desktop bundles only the web host may load a socket built-in, and the endpoint file may not be reached at all", () => {
  const P = (rel) => `${STAGE_ROOT}/${rel}`;
  const stagedOf = (p) => (p.startsWith(`${STAGE_ROOT}/`) ? p.slice(STAGE_ROOT.length + 1) : null);
  const manifest = { zod: null, files: ["pty-process/endpoint-host.ts", "pty-process/index.ts", "daemon-host/entry.ts"].map((path) => ({ path })) };
  const graph = (edges) => ({ inputs: Object.fromEntries(Object.entries(edges).map(([from, tos]) => [from, { imports: tos.map((to) => (to.startsWith("node:") ? { path: to, external: true } : { path: to })) }])) });
  assert.equal(listenerBuiltinRefusal("node:net", ENDPOINT_LISTENER_FILE, { desktop: true }) !== null, true, "the per-file allowance is not a desktop one");
  for (const entry of [DEFAULT_ENTRY, SEAM_ENTRY]) {
    const direct = checkMetafile(graph({ [entry]: [P("pty-process/endpoint-host.ts")], [P("pty-process/endpoint-host.ts")]: ["node:net"] }), manifest);
    assert.ok(direct.some((v) => /opens sockets: in a desktop bundle/.test(v)), `${entry}: node:net inside the bundle: ${direct.join("; ")}`);
    assert.ok(direct.some((v) => /endpoint listener, which no desktop bundle may contain/.test(v)), `${entry}: the file is reached: ${direct.join("; ")}`);
    const via = checkMetafile(graph({ [entry]: [P("daemon-host/entry.ts")], [P("daemon-host/entry.ts")]: [P("pty-process/index.ts")], [P("pty-process/index.ts")]: [P("pty-process/endpoint-host.ts")], [P("pty-process/endpoint-host.ts")]: [] }), manifest);
    assert.ok(via.some((v) => /pty-process\/index\.ts -> pty-process\/endpoint-host\.ts: reaches the pty process endpoint listener/.test(v)), `${entry}: transitively: ${via.join("; ")}`);
  }
  assert.ok(checkMetafile(graph({ [DEFAULT_ENTRY]: [P("pty-process/index.ts")], [P("pty-process/index.ts")]: ["node:net"] }), manifest).some((v) => /opens sockets/.test(v)), "any other file: refused as before");
});

test("the endpoint file's source rules accept the path listen and refuse each review probe", () => {
  assert.deepEqual(rules(OK), []);
  const probes = {
    "a port": variant("server.listen(path, () => undefined);", "server.listen(8080);"),
    "an options object": variant("server.listen(path, () => undefined);", "server.listen({ path });"),
    "a parameter name (SF8)": variant("server.listen(path, () => undefined);", "((p: string) => server.listen(p))(path);"),
    "a function parameter shadow": `${HEAD}export function open(path: number): void {\n  const server = createServer();\n  server.listen(path);\n}\nconst path = join("a", "b");\n`,
    "let, then assigned": variant('const path = join(dir, "a.sock");', "let path;\n  path = 8080;"),
    "for-of shadow": variant('const path = join(dir, "a.sock");', 'const path = join(dir, "a.sock");\n  for (const path of [8080]) void path;'),
    "array destructuring shadow": variant('const path = join(dir, "a.sock");', 'const path = join(dir, "a.sock");\n  { const [path] = [8080]; void path; }'),
    "a local join": variant('const path = join(dir, "a.sock");', 'const join = (..._a: unknown[]) => 8080;\n  const path = join(dir);'),
    'a string "//" hiding code': variant("server.listen(path, () => undefined);", 'const sep = "//"; server.listen(8080);'),
    'a "/*" string': variant("server.listen(path, () => undefined);", 'const a = "/*"; server.listen(8080); const b = "*/";'),
    "a template //": variant("server.listen(path, () => undefined);", "const t = `x//`; server.listen(8080);"),
    "a regex //": variant("server.listen(path, () => undefined);", "const r = /a\\/\\//; server.listen(8080);"),
    "a unicode-escaped listen": variant("server.listen(path, () => undefined);", "server.l\\u0069sten(8080);"),
    "a computed listen": variant("server.listen(path, () => undefined);", 'server["lis" + "ten"](8080);'),
    "a literal ['listen']": variant("server.listen(path, () => undefined);", 'server["listen"](path);'),
    "export { createServer } from node:net": `${OK}export { createServer } from "node:net";\n`,
    "export * from node:net": `${OK}export * from "node:net";\n`,
    "exporting the imported createServer": `${OK}export { createServer };\n`,
    "connect (outbound TCP)": OK.replace("import { createServer }", "import { createServer, connect }") + 'export const c = () => connect(443, "evil.example");\n',
    "createConnection": OK.replace("import { createServer }", "import { createServer, createConnection }"),
    "Socket as a value": OK.replace("import { createServer }", "import { createServer, Socket }"),
    "a namespace import": OK.replace("import { createServer } from", "import * as net from").replace("createServer()", "net.createServer()"),
    "an alias": OK.replace("import { createServer }", "import { createServer as cs }").replace("createServer()", "cs()"),
    "a dynamic import": `${OK}export const m = () => import("node:net");\n`,
    "a second listen": variant("server.listen(path, () => undefined);", "server.listen(path);\n  server.listen(path);"),
    "createServer twice": variant("const server = createServer();", "const server = createServer();\n  const other = createServer();\n  void other;"),
    "a port option": `${OK}export const o = { port: 1 };\n`,
    "a host option": `${OK}export const o = { host: "h" };\n`,
    '"::ffff:0.0.0.0"': `${OK}export const a = "::ffff:0.0.0.0";\n`,
    '"0.0.0.0"': `${OK}export const a = "0.0.0.0";\n`,
    "localhost": `${OK}export const a = "localhost";\n`,
  };
  for (const [what, source] of Object.entries(probes)) assert.ok(rules(source).length > 0, `${what} stages:\n${source}`);
  // Each rule on its own, where another rule would also refuse the probe.
  const says = (what, re) => assert.ok(rules(probes[what]).some((m) => re.test(m)), `${what}: ${rules(probes[what]).join("; ")}`);
  says("exporting the imported createServer", /exports only what it declares/);
  says("a computed listen", /computed property access/);
  says("a unicode-escaped listen", /written with escapes/);
  says("createServer twice", /createServer is called exactly once/);
  says("a parameter name (SF8)", /not a const declared once and initialised by join/);
  says("export * from node:net", /re-exports nothing/);
  assert.deepEqual(rules(`// server.listen(8080) in a comment\n/* port: 1 */\n${OK}`), [], "comments count for nothing");
  assert.deepEqual(unsafeForms(OK.replace("server.listen(path, () => undefined);", "server.listen(8080);"), "pty-process/service.ts", { pkg: "pty-process" }), [], "the rules are the endpoint file's (any other file may not load node:net at all)");
});

test("the rules run at staging and in the import lint: a port listen is refused, a path listen stages", () => {
  const files = new Set(["pty-process/endpoint-host.ts"]);
  assert.doesNotThrow(() => checkStagedFile(ENDPOINT_LISTENER_FILE, OK, files));
  assert.throws(() => checkStagedFile(ENDPOINT_LISTENER_FILE, variant("server.listen(path, () => undefined);", "server.listen(8080);"), files), /listen/);
  assert.throws(() => checkStagedFile(ENDPOINT_LISTENER_FILE, 'import { request } from "node:http";\n', files), /may load only node:net/);
  assert.throws(() => checkStagedFile("pty-process/service.ts", 'import { createServer } from "node:net";\n', new Set(["pty-process/service.ts"])), /opens sockets/);
  assert.ok(unsafeForms(variant("server.listen(path, () => undefined);", "server.listen(8080);"), "src/endpoint-host.ts", { pkg: "pty-process", pkgRel: "src/endpoint-host.ts" }).length > 0, "the import lint's path form");
});

test("the real endpoint file, once it exists (PV-M6 slice 2), passes the rules", () => {
  const real = fileURLToPath(new URL("../../packages/pty-process/src/endpoint-host.ts", import.meta.url));
  if (!existsSync(real)) return; // not on this branch yet: the staging hook and the import lint apply the same rules when it lands
  const text = readFileSync(real, "utf8");
  assert.deepEqual(rules(text), []);
  for (const m of text.matchAll(/from "(node:[a-z0-9/]+)"/g)) assert.equal(listenerBuiltinRefusal(m[1], ENDPOINT_LISTENER_FILE), null, m[1]);
});

test("NET-GATE stays TCP: the packaged check lists TCP listeners only, so a Unix socket is not counted and a TCP one always is", () => {
  const script = readFileSync(fileURLToPath(new URL("../../scripts/code-oss/check-net-packaged.mjs", import.meta.url)), "utf8");
  assert.ok(script.includes('"-iTCP"') && script.includes('"-sTCP:LISTEN"') && script.includes('"/proc/net/tcp"') && script.includes('"/proc/net/tcp6"'));
  assert.equal(script.includes("/proc/net/unix"), false);
  const lsof = "p10\nn/run/user/1000/axis/Ab3.sock\np10\nn127.0.0.1:8080\n";
  assert.deepEqual(parseLsofListeners(lsof, [10]).map((l) => l.port), [8080], "a socket path has no port; a TCP listener is still found");
});
