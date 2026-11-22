// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// The web host isolation rules (ticket W1, docs/design/web-host-entry.md), shared by the import test
// (test/packages/imports.test.mjs), the staged-file scan (stage-scan.mjs, stage-verify.mjs) and the bundle graph
// check (check-daemon-graph.mjs). Paths are staged paths: `<package>/<path inside its src>`, for example
// `daemon-host/web/server.ts`; null means a file outside the staged tree (an overlay file).
//
//   1. Built-ins that open sockets may be loaded only by the files in LISTENER_FILES, each only the built-ins listed for it:
//      the web host listener (opt-in, W1) and the CLI messaging endpoint in the pty process (`node:net` only, and only ever
//      listening on a path: a Unix socket or a named pipe, never a TCP port; ADR 0007 decision 7.1, PV-M6 slice 2). NET-1's
//      "no TCP listener in a desktop run" is unchanged: the packaged check (check-net-packaged.mjs) lists TCP sockets only.
//   2. Nothing outside `daemon-host/web/` may load a file inside it, except the overlay files listed in WEB_ENTRIES
//      (none yet: the reh tunnel is ticket W1b). So no desktop bundle (the daemon entry, the main seam) can contain the
//      listener, which makes "no Axis listener during a desktop run" (ROADMAP, threat model NET-1, DMN-4) structural.

/** Node built-ins that open a socket, listening or not. */
export const LISTENER_BUILTINS = new Set(["node:net", "node:http", "node:https", "node:http2", "node:tls", "node:dgram"]);
/** The web host listener: the one staged file that may load any of them. */
export const LISTENER_FILE = "daemon-host/web/server.ts";
/** The pty process's CLI messaging endpoint: `node:net` only, path listens only (`listenPathRefusals`). */
export const ENDPOINT_LISTENER_FILE = "pty-process/endpoint-host.ts";
/** Every staged file that may load a socket built-in, with exactly the built-ins it may load. */
export const LISTENER_FILES = new Map([
  [LISTENER_FILE, LISTENER_BUILTINS],
  [ENDPOINT_LISTENER_FILE, new Set(["node:net"])],
]);
export const WEB_HOST_DIR = "daemon-host/web/";
/** Overlay files (tree-relative) that may load the web host. Empty until the reh tunnel (W1b) exists. */
export const WEB_ENTRIES = new Set();

export const isWebHostModule = (rel) => typeof rel === "string" && rel.startsWith(WEB_HOST_DIR);

/** Why the staged file `rel` may not load the built-in `spec`, or null. A call without a file is judged strictly. */
export function listenerBuiltinRefusal(spec, rel) {
  const base = spec.replace(/\/.*$/, "");
  if (!LISTENER_BUILTINS.has(base)) return null;
  const allowed = LISTENER_FILES.get(rel);
  if (allowed === undefined) return `${spec} opens sockets: only ${LISTENER_FILE} (the web host listener) and ${ENDPOINT_LISTENER_FILE} (node:net) may load it`;
  return allowed.has(base) && spec === base ? null : `${spec} opens sockets: ${rel} may load only ${[...allowed].join(", ")}`;
}

/** The source without comments, so a word in a comment counts for nothing. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

/**
 * Why the endpoint file `rel` may listen on something other than a path, as a list (empty when it may not, or for any other
 * file). Structural, on its source: every `listen` is a direct `.listen(<identifier>` call whose identifier is a `const`
 * assigned from `join(` in the same file (a path under the runtime directory); no other use of the name `listen` (bracket,
 * `.call`, `Reflect`, destructuring); no `port`/`host` option, no host or wildcard address literal. A listen on a port, a host,
 * or an options object therefore never stages.
 */
export function listenPathRefusals(rel, text) {
  if (rel !== ENDPOINT_LISTENER_FILE) return [];
  const src = code(text);
  const bad = [];
  const paths = new Set([...src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*join\(/g)].map((m) => m[1]));
  for (const m of src.matchAll(/\blisten\b/g)) {
    const before = src.slice(Math.max(0, m.index - 1), m.index);
    const call = /^listen\(\s*([A-Za-z_$][\w$]*)\s*[,)]/.exec(src.slice(m.index));
    if (before !== ".") bad.push(`${rel}: \`listen\` is used other than as a direct .listen(<path>) call`);
    else if (call === null) bad.push(`${rel}: .listen(...) whose first argument is not a path variable (a port, a host or an options object)`);
    else if (!paths.has(call[1])) bad.push(`${rel}: .listen(${call[1]}): the argument is not a const assigned from join(...) (a path)`);
    // The same name declared any other way (another scope's `const path = 8080`, a `let`) could reach the call instead.
    else if (new RegExp(`\\b(?:let|var|const)\\s+${call[1]}\\s*=\\s*(?!\\s|join\\()`).test(src)) bad.push(`${rel}: .listen(${call[1]}): ${call[1]} is also declared other than from join(...)`);
  }
  if (/\b(?:port|host)\s*:/.test(src)) bad.push(`${rel}: a port or host option`);
  if (/["'`](?:0\.0\.0\.0|127\.\d+\.\d+\.\d+|localhost|::1?|\[::1?\])["'`]/.test(src)) bad.push(`${rel}: a host or wildcard address`);
  return bad;
}

/** Why `fromRel` (a staged path, or null with `fromPath` the overlay file) may not load the staged `targetRel`, or null. */
export function webHostEdgeRefusal(fromRel, targetRel, fromPath = null) {
  if (!isWebHostModule(targetRel) || isWebHostModule(fromRel)) return null;
  if (fromRel === null && fromPath !== null && WEB_ENTRIES.has(fromPath)) return null;
  return `${targetRel} is the web host: nothing outside ${WEB_HOST_DIR} may load it, so no desktop bundle can contain a listener`;
}

/**
 * The whole-graph form of rule 2 on an esbuild metafile: every module (staged or not) that reaches a web host module
 * through modules outside the web host directory, except the WEB_ENTRIES, with the path it takes. Computed backwards
 * from the web modules, so a large bundle costs one pass. Returns `{ path, text }` entries.
 */
export function listenerReachViolations(metafile, stagedOf) {
  const isWeb = (p) => isWebHostModule(stagedOf(p));
  const importers = new Map();
  for (const [input, info] of Object.entries(metafile.inputs)) {
    for (const imp of info.imports) {
      if (imp.external === true) continue;
      if (!importers.has(imp.path)) importers.set(imp.path, []);
      importers.get(imp.path).push(input);
    }
  }
  const next = new Map();
  const queue = [];
  const visit = (from, toward) => {
    if (isWeb(from) || next.has(from)) return;
    next.set(from, toward);
    queue.push(from);
  };
  for (const [target, froms] of importers) if (isWeb(target)) for (const f of froms) visit(f, target);
  for (let i = 0; i < queue.length; i++) for (const f of importers.get(queue[i]) ?? []) visit(f, queue[i]);
  const name = (p) => stagedOf(p) ?? p;
  const bad = [];
  for (const start of queue) {
    if (stagedOf(start) === null && WEB_ENTRIES.has(start)) continue;
    const path = [start];
    for (let at = next.get(start); at !== undefined; at = next.get(at)) path.push(at);
    const names = path.map(name);
    bad.push({ path: names, text: `${names.join(" -> ")}: reaches the web host, which nothing outside ${WEB_HOST_DIR} may load` });
  }
  return bad;
}
