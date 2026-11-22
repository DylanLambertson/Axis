// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Rule 1 of web-rules.mjs, widened for the CLI messaging endpoint (ADR 0007 decision 7.1, PV-M6 slice 2): besides the web host
// listener, exactly one more staged file, pty-process/endpoint-host.ts, may load exactly one socket built-in, node:net, and may
// only ever listen on a path (a Unix socket or a named pipe), never a TCP port or host. NET-1's "no TCP listener in a desktop
// run" stays as it was: the packaged check lists TCP sockets only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseLsofListeners } from "../../scripts/code-oss/check-net-packaged.mjs";
import { classifySpecifier } from "../../scripts/code-oss/stage-scan.mjs";
import { checkStagedFile } from "../../scripts/code-oss/stage-verify.mjs";
import { ENDPOINT_LISTENER_FILE, LISTENER_BUILTINS, LISTENER_FILE, LISTENER_FILES, listenPathRefusals, listenerBuiltinRefusal } from "../../scripts/code-oss/web-rules.mjs";

const exportsOf = () => [];
const PATH_LISTEN = 'import { createServer } from "node:net";\nimport { join } from "node:path";\nconst path = join(dir, "a.sock");\ncreateServer().listen(path, () => undefined);\n';

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

test("rule 1: the endpoint file listens only on a path assigned from join(...): a port, a host, an options object or another use is refused", () => {
  assert.deepEqual(listenPathRefusals(ENDPOINT_LISTENER_FILE, PATH_LISTEN), []);
  for (const [what, text] of [
    ["a port", "s.listen(8080);"],
    ["port 0", "s.listen(0);"],
    ["an options object", "s.listen({ path: p });"],
    ["a port option", "const path = join(d, x);\ns.listen(path);\nconst o = { port: 1 };"],
    ["a host option", "const path = join(d, x);\ns.listen(path);\nconst o = { host: h };"],
    ["a wildcard address", 'const path = join(d, x);\ns.listen(path, "0.0.0.0");'],
    ["localhost", "const path = join(d, x);\ns.listen(path, 'localhost');"],
    ["a variable not from join", 'const p = "/run/x";\ns.listen(p);'],
    ["the name shadowed", "const path = join(d, x);\n{ const path = 8080; s.listen(path); }"],
    ["bracket access", 's["listen"](p);'],
    ["call", "s.listen.call(s, 80);"],
    ["destructuring", "const { listen } = s;"],
  ]) {
    assert.ok(listenPathRefusals(ENDPOINT_LISTENER_FILE, text).length > 0, what);
  }
  assert.deepEqual(listenPathRefusals(ENDPOINT_LISTENER_FILE, "// s.listen(8080) in a comment\n/* port: 1 */\n" + PATH_LISTEN), [], "comments count for nothing");
  assert.deepEqual(listenPathRefusals("pty-process/service.ts", "s.listen(8080);"), [], "only the endpoint file has this check (others may not load node:net at all)");
});

test("staged files: the endpoint file stages with a path listen and is refused with a port listen", () => {
  const files = new Set(["pty-process/endpoint-host.ts"]);
  assert.doesNotThrow(() => checkStagedFile(ENDPOINT_LISTENER_FILE, PATH_LISTEN, files));
  assert.throws(() => checkStagedFile(ENDPOINT_LISTENER_FILE, 'import { createServer } from "node:net";\ncreateServer().listen(8080);\n', files), /listen/);
  assert.throws(() => checkStagedFile(ENDPOINT_LISTENER_FILE, 'import { request } from "node:http";\n', files), /may load only node:net/);
  assert.throws(() => checkStagedFile("pty-process/service.ts", 'import { createServer } from "node:net";\n', new Set(["pty-process/service.ts"])), /opens sockets/);
});

test("the real endpoint file, once it exists (PV-M6 slice 2), passes both checks", () => {
  const real = fileURLToPath(new URL("../../packages/pty-process/src/endpoint-host.ts", import.meta.url));
  if (!existsSync(real)) return; // not on this branch yet: the staging hook applies the same checks when it lands
  const text = readFileSync(real, "utf8");
  assert.deepEqual(listenPathRefusals(ENDPOINT_LISTENER_FILE, text), []);
  for (const m of text.matchAll(/from "(node:[a-z0-9/]+)"/g)) assert.equal(listenerBuiltinRefusal(m[1], ENDPOINT_LISTENER_FILE), null, m[1]);
});

test("NET-GATE stays TCP: the packaged check lists TCP listeners only, so a Unix socket is not counted and a TCP one always is", () => {
  const script = readFileSync(fileURLToPath(new URL("../../scripts/code-oss/check-net-packaged.mjs", import.meta.url)), "utf8");
  assert.ok(script.includes('"-iTCP"') && script.includes('"-sTCP:LISTEN"') && script.includes('"/proc/net/tcp"') && script.includes('"/proc/net/tcp6"'));
  assert.equal(script.includes("/proc/net/unix"), false);
  const lsof = "p10\nn/run/user/1000/axis/Ab3.sock\np10\nn127.0.0.1:8080\n";
  assert.deepEqual(parseLsofListeners(lsof, [10]).map((l) => l.port), [8080], "a socket path has no port; a TCP listener is still found");
});
