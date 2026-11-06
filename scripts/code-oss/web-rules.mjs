// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// The web host isolation rules (ticket W1, docs/design/web-host-entry.md), shared by the import test
// (test/packages/imports.test.mjs), the staged-file scan (stage-scan.mjs, stage-verify.mjs) and the bundle graph
// check (check-daemon-graph.mjs). Paths are staged paths: `<package>/<path inside its src>`, for example
// `daemon-host/web/server.ts`; null means a file outside the staged tree (an overlay file).
//
//   1. Built-ins that open sockets may be loaded by exactly one file, the web host listener.
//   2. Nothing outside `daemon-host/web/` may load a file inside it, except the overlay files listed in WEB_ENTRIES
//      (none yet: the reh tunnel is ticket W1b). So no desktop bundle (the daemon entry, the main seam) can contain the
//      listener, which makes "no Axis listener during a desktop run" (ROADMAP, threat model NET-1, DMN-4) structural.

/** Node built-ins that open a socket, listening or not. */
export const LISTENER_BUILTINS = new Set(["node:net", "node:http", "node:https", "node:http2", "node:tls", "node:dgram"]);
/** The one staged file that may load them. */
export const LISTENER_FILE = "daemon-host/web/server.ts";
export const WEB_HOST_DIR = "daemon-host/web/";
/** Overlay files (tree-relative) that may load the web host. Empty until the reh tunnel (W1b) exists. */
export const WEB_ENTRIES = new Set();

export const isWebHostModule = (rel) => typeof rel === "string" && rel.startsWith(WEB_HOST_DIR);

/** Why the staged file `rel` may not load the built-in `spec`, or null. A call without a file is judged strictly. */
export function listenerBuiltinRefusal(spec, rel) {
  if (!LISTENER_BUILTINS.has(spec.replace(/\/.*$/, ""))) return null;
  return rel === LISTENER_FILE ? null : `${spec} opens sockets: only ${LISTENER_FILE} (the web host listener) may load it`;
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
