// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// The web host isolation rules (ticket W1, docs/design/web-host-entry.md), shared by the import test
// (test/packages/imports.test.mjs), the staged-file scan (stage-scan.mjs, stage-verify.mjs) and the bundle graph
// check (check-daemon-graph.mjs). Paths are staged paths: `<package>/<path inside its src>`, for example
// `daemon-host/web/server.ts`; null means a file outside the staged tree (an overlay file).
//
//   1. Built-ins that open sockets may be loaded only by the files in LISTENER_FILES, each only the built-ins listed for it:
//      the web host listener (opt-in, W1) and the CLI messaging endpoint in the pty process (`node:net`'s `createServer`
//      only, listening only on a path: ADR 0007 decision 7.1, PV-M6 slice 2; the source rules are `endpointForms` in
//      stage-ast.mjs, on the TypeScript AST). In the DESKTOP bundles (the daemon and the main seam) the allowance is the web
//      host's alone, and neither listener file may be reached at all (rule 2), so no desktop bundle can hold a socket
//      built-in. NET-1's "no TCP listener in a desktop run" is unchanged: the packaged check lists TCP sockets only.
//   2. Nothing outside `daemon-host/web/` may load a file inside it (and no desktop bundle may reach the endpoint listener
//      file either, listenerReachViolations), except the overlay files listed in WEB_ENTRIES
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

/**
 * Why the staged file `rel` may not load the built-in `spec`, or null. A call without a file is judged strictly. With
 * `desktop` (the daemon and main seam bundle checks) only the web host listener may, as before the endpoint existed.
 */
export function listenerBuiltinRefusal(spec, rel, { desktop = false } = {}) {
  const base = spec.replace(/\/.*$/, "");
  if (!LISTENER_BUILTINS.has(base)) return null;
  if (desktop) return rel === LISTENER_FILE ? null : `${spec} opens sockets: in a desktop bundle only ${LISTENER_FILE} (the web host listener) may load it`;
  const allowed = LISTENER_FILES.get(rel);
  if (allowed === undefined) return `${spec} opens sockets: only ${LISTENER_FILE} (the web host listener) and ${ENDPOINT_LISTENER_FILE} (node:net) may load it`;
  return allowed.has(base) && spec === base ? null : `${spec} opens sockets: ${rel} may load only ${[...allowed].join(", ")}`;
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
  // The web host and the endpoint listener: no module of a desktop bundle may reach either (DMN-4: the daemon opens no listener).
  const isWeb = (p) => isWebHostModule(stagedOf(p)) || stagedOf(p) === ENDPOINT_LISTENER_FILE;
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
    const target = names[names.length - 1];
    bad.push({ path: names, text: target === ENDPOINT_LISTENER_FILE ? `${names.join(" -> ")}: reaches the pty process endpoint listener, which no desktop bundle may contain` : `${names.join(" -> ")}: reaches the web host, which nothing outside ${WEB_HOST_DIR} may load` });
  }
  return bad;
}
