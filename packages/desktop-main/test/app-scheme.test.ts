// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The app scheme handler. Mutants each test kills (named in the assertion messages):
//   M1 a method other than GET and HEAD served; M2 another host or scheme served; M3 credentials or a port accepted;
//   M4 a `..`, `.`, hidden, encoded or empty segment accepted; M5 a Windows device name or a trailing dot accepted;
//   M6 an extension outside the MIME map served, or the type taken from anything but the map; M7 the containment check
//   dropped or made a prefix match without the separator (a sibling `bundle-evil` directory); M8 a link out of the bundle
//   followed; M9 a directory served; M10 the size cap dropped; M11 an error body that names the path, or an error without the
//   security headers; M12 HEAD with a body; M13 a failed root resolution cached forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_MIME_TYPES, MAX_APP_FILE_BYTES, buildCsp, createAppSchemeHandler, resolveAppPath, type AppFiles } from "../src/index.js";

const csp = buildCsp({ trustedTypesPolicies: [] });
const text = (b: Uint8Array | null): string => new TextDecoder().decode(b ?? new Uint8Array());

function bundle(t: { after(fn: () => void): void }): { root: string; outside: string; handler: ReturnType<typeof createAppSchemeHandler> } {
  const dir = mkdtempSync(join(tmpdir(), "axis-app-scheme-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "bundle");
  mkdirSync(join(root, "chunks"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html>");
  writeFileSync(join(root, "chunks", "main-ABC123.js"), "export {};");
  writeFileSync(join(root, "secret.bin"), "x");
  mkdirSync(join(root, "dir.js"));
  const outside = join(dir, "bundle-evil");
  mkdirSync(outside);
  writeFileSync(join(outside, "x.js"), "stolen");
  writeFileSync(join(dir, "outside.js"), "stolen");
  symlinkSync(join(dir, "outside.js"), join(root, "link.js"));
  symlinkSync(outside, join(root, "evil"));
  return { root, outside, handler: createAppSchemeHandler({ root, csp }) };
}

test("resolveAppPath: method, scheme, host, credentials and port", () => {
  assert.equal(resolveAppPath("axis-app://shell/index.html", "GET").ok, true);
  assert.equal(resolveAppPath("axis-app://shell/index.html", "HEAD").ok, true);
  for (const m of ["POST", "PUT", "get", "OPTIONS", ""]) assert.deepEqual(resolveAppPath("axis-app://shell/index.html", m), { ok: false, status: 405 }, `M1: ${m}`);
  for (const u of ["axis-app://other/index.html", "https://shell/index.html", "file:///index.html", "axis-app:/index.html", "not a url"]) {
    assert.deepEqual(resolveAppPath(u, "GET"), { ok: false, status: 400 }, `M2: ${u}`);
  }
  for (const u of ["axis-app://u:p@shell/index.html", "axis-app://u@shell/index.html", "axis-app://shell:8080/index.html"]) {
    assert.deepEqual(resolveAppPath(u, "GET"), { ok: false, status: 400 }, `M3: ${u}`);
  }
});

test("resolveAppPath: the root is index.html, the query and fragment are ignored", () => {
  for (const u of ["axis-app://shell/", "axis-app://shell", "axis-app://shell/?a=1#x"]) {
    const r = resolveAppPath(u, "GET");
    assert.ok(r.ok);
    assert.deepEqual(r.segments, ["index.html"]);
  }
  const r = resolveAppPath("axis-app://shell/chunks/main-ABC123.js?v=2#f", "GET");
  assert.ok(r.ok);
  assert.deepEqual(r.segments, ["chunks", "main-ABC123.js"]);
});

test("resolveAppPath: dot segments, plain or encoded, resolve inside the root before any segment is judged", () => {
  for (const [p, want] of [["/../index.html", ["index.html"]], ["/chunks/../../x.js", ["x.js"]], ["/%2e%2e/x.js", ["x.js"]], ["/.%2e/../x.js", ["x.js"]], ["/a/./b.js", ["a", "b.js"]]] as const) {
    const r = resolveAppPath(`axis-app://shell${p}`, "GET");
    assert.ok(r.ok, p);
    assert.deepEqual(r.segments, want, `M4: ${p}`);
  }
});

test("resolveAppPath: unsafe segments are not found", () => {
  const bad = [
    "/a%2fb.js", "/a%5cb.js", "/a%00.js", "/.hidden.js",
    "/a//b.js", "/a b.js", "/a%20b.js", "/c:x.js", "/a\\b.js", "/é.js", "/a.js/", "/_x.js", "/-x.js",
  ];
  for (const p of bad) {
    const r = resolveAppPath(`axis-app://shell${p}`, "GET");
    assert.equal(r.ok, false, `M4: ${p}`);
  }
  for (const p of ["/CON.js", "/nul.html", "/com1.css", "/LPT9.js", "/index.html.", "/aux", "/assets./a.js", "/a./b./c.js"]) {
    assert.equal(resolveAppPath(`axis-app://shell${p}`, "GET").ok, false, `M5: ${p}`);
  }
  assert.equal(resolveAppPath(`axis-app://shell/${Array(17).fill("a").join("/")}.js`, "GET").ok, false, "too many segments");
});

test("resolveAppPath: only the MIME map's extensions, typed by the map", () => {
  for (const p of ["/secret.bin", "/a.exe", "/a.wasm", "/a.htm", "/Makefile", "/a.", "/a.JS.bak"]) {
    assert.deepEqual(resolveAppPath(`axis-app://shell${p}`, "GET"), { ok: false, status: 404 }, `M6: ${p}`);
  }
  const r = resolveAppPath("axis-app://shell/A.JS", "GET");
  assert.ok(r.ok);
  assert.equal(r.contentType, "text/javascript; charset=utf-8");
  assert.equal(APP_MIME_TYPES["html"], "text/html; charset=utf-8");
  assert.equal(Object.isFrozen(APP_MIME_TYPES), true);
  assert.equal(resolveAppPath("axis-app://shell/constructor", "GET").ok, false, "M6: prototype key as an extension");
  assert.equal(resolveAppPath("axis-app://shell/a.constructor", "GET").ok, false, "M6: prototype key as an extension");
});

test("handler: serves a bundle file with the map's type and the security headers", async (t) => {
  const { handler } = bundle(t);
  const r = await handler.handle({ url: "axis-app://shell/chunks/main-ABC123.js", method: "GET" });
  assert.equal(r.status, 200);
  assert.equal(text(r.body), "export {};");
  assert.equal(r.headers["Content-Type"], "text/javascript; charset=utf-8");
  assert.equal(r.headers["Content-Security-Policy"], csp);
  assert.equal(r.headers["X-Content-Type-Options"], "nosniff");
  const root = await handler.handle({ url: "axis-app://shell/", method: "GET" });
  assert.equal(text(root.body), "<!doctype html>");
  const head = await handler.handle({ url: "axis-app://shell/index.html", method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, null, "M12");
});

test("handler: links out of the bundle, sibling prefixes, directories and missing files are not found", async (t) => {
  const { handler } = bundle(t);
  for (const [url, why] of [
    ["axis-app://shell/link.js", "M8: a file link out of the bundle"],
    ["axis-app://shell/evil/x.js", "M7/M8: a directory link to a sibling that shares the root's prefix"],
    ["axis-app://shell/dir.js", "M9: a directory"],
    ["axis-app://shell/missing.js", "missing"],
  ] as const) {
    const r = await handler.handle({ url, method: "GET" });
    assert.equal(r.status, 404, why);
    assert.equal(text(r.body), "Not found", `M11: ${why}`);
    assert.equal(r.headers["Content-Security-Policy"], csp, `M11: ${why}`);
    assert.equal(r.headers["Content-Type"], "text/plain; charset=utf-8");
  }
});

test("handler: the containment check is on the real root plus the separator", async () => {
  const files = (map: Record<string, string>): AppFiles => ({
    realpath: async (p) => {
      const v = map[p];
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    stat: async () => ({ isFile: () => true, size: 1 }),
    readFile: async () => new Uint8Array([120]),
  });
  const h = createAppSchemeHandler({ root: "/r/bundle", csp, files: files({ "/r/bundle": "/real/bundle", "/real/bundle/a.js": "/real/bundle-evil/a.js" }) });
  assert.equal((await h.handle({ url: "axis-app://shell/a.js", method: "GET" })).status, 404, "M7: prefix without separator");
  const h2 = createAppSchemeHandler({ root: "/r/bundle", csp, files: files({ "/r/bundle": "/real/bundle", "/real/bundle/a.js": "/real/bundle" }) });
  assert.equal((await h2.handle({ url: "axis-app://shell/a.js", method: "GET" })).status, 404, "M7: the root itself");
  const h3 = createAppSchemeHandler({ root: "/r/bundle", csp, files: files({ "/r/bundle": "/real/bundle", "/real/bundle/a.js": "/real/bundle/a.js" }) });
  assert.equal((await h3.handle({ url: "axis-app://shell/a.js", method: "GET" })).status, 200);
  const dir: AppFiles = { ...files({ "/r/bundle": "/real/bundle", "/real/bundle/d.js": "/real/bundle/d.js" }), stat: async () => ({ isFile: () => false, size: 1 }) };
  const h4 = createAppSchemeHandler({ root: "/r/bundle", csp, files: dir });
  assert.equal((await h4.handle({ url: "axis-app://shell/d.js", method: "GET" })).status, 404, "M9: a directory named like a file");
});

test("handler: the size cap, and a root that fails is retried", async () => {
  let rootOk = false;
  const files: AppFiles = {
    realpath: async (p) => {
      if (p === "/root") {
        if (!rootOk) throw new Error("EACCES");
        return "/root";
      }
      return p;
    },
    stat: async (p) => ({ isFile: () => true, size: p.endsWith("big.js") ? MAX_APP_FILE_BYTES + 1 : 3 }),
    readFile: async () => new Uint8Array(3),
  };
  const refused: number[] = [];
  const h = createAppSchemeHandler({ root: "/root", csp, files, onRefused: (s) => refused.push(s) });
  assert.equal((await h.handle({ url: "axis-app://shell/a.js", method: "GET" })).status, 404);
  rootOk = true;
  assert.equal((await h.handle({ url: "axis-app://shell/a.js", method: "GET" })).status, 200, "M13");
  assert.equal((await h.handle({ url: "axis-app://shell/big.js", method: "GET" })).status, 404, "M10");
  assert.equal((await h.handle({ url: "axis-app://shell/a.js", method: "POST" })).status, 405);
  assert.deepEqual(refused, [404, 404, 405]);
});
