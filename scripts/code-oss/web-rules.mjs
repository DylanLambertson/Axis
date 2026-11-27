// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// The web host isolation rules (ticket W1, docs/design/web-host-entry.md), shared by the import test
// (test/packages/imports.test.mjs), the staged-file scan (stage-scan.mjs, stage-verify.mjs) and the bundle graph
// check (check-daemon-graph.mjs). Paths are staged paths: `<package>/<path inside its src>`, for example
// `daemon-host/web/server.ts`; null means a file outside the staged tree (an overlay file).
//
//   1. Built-ins that open sockets may be loaded only by the files in LISTENER_FILES, each only the built-ins listed for it:
//      the web host listener (opt-in, W1) and the CLI messaging endpoint template in the pty process, `node:net` only
//      (ADR 0007 decision 7.1, PV-M6). The template is not analysed: it is PINNED by its SHA-256 (ENDPOINT_LISTENER_SHA256),
//      checked wherever a file's source is checked (stage-ast.mjs scanModules: the import lint, the staging hook and the
//      staged-tree check), so any edit fails until the pin changes in the same reviewed change. The template's API hands out
//      neither its server nor a raw socket. LIMIT, stated plainly: this rule refuses socket built-ins and listen-capable
//      imports outside the pinned file; it does NOT defend against code in the same process that patches shared prototypes
//      to reach the server (RR-89). A best-effort lint refuses the plain forms of such patching in pty-process sources
//      (prototype-lint.mjs); code review, the pin and the supply-chain checks are the other controls. In the DESKTOP bundles (the
//      daemon and the main seam) the allowance is the web host's alone, and neither listener file may be reached at all
//      (rule 2). NET-1's "no TCP listener in a desktop run" is unchanged: the packaged check lists TCP sockets only.
//   2. Nothing outside `daemon-host/web/` may load a file inside it (and no desktop bundle may reach the endpoint listener
//      file either, listenerReachViolations), except the overlay files listed in WEB_ENTRIES
//      (none yet: the reh tunnel is ticket W1b). So no desktop bundle (the daemon entry, the main seam) can contain the
//      listener, which makes "no Axis listener during a desktop run" (ROADMAP, threat model NET-1, DMN-4) structural.

import { createHash } from "node:crypto";

/** Node built-ins that open a socket, listening or not. */
export const LISTENER_BUILTINS = new Set(["node:net", "node:http", "node:https", "node:http2", "node:tls", "node:dgram"]);
/** The web host listener: the one staged file that may load any of them. */
export const LISTENER_FILE = "daemon-host/web/server.ts";
/** The pty process's CLI messaging endpoint template: `node:net` only, its whole content pinned below. */
export const ENDPOINT_LISTENER_FILE = "pty-process/endpoint-listen.ts";
/**
 * SHA-256 of the template's text with CRLF read as LF. Changing the template means changing this pin in the same change,
 * which a reviewer sees: the template is about 40 lines that listen on an absolute path only and let neither the server nor
 * a raw socket out (`packages/pty-process/src/endpoint-listen.ts`).
 */
export const ENDPOINT_LISTENER_SHA256 = "68107008a3655750e3384eefec6ae5451ad6ebf8a332fcd0590c957752ed8c73";

/** The notice the staging hook writes as the second line of every staged file (after the copyright line). */
export const STAGED_NOTICE = "Staged by code-oss/hooks/post-apply.d/20-stage-axis-packages. Do not edit; edit the source and rerun apply.sh.";

/**
 * Why the endpoint template's text `source` is not the pinned one, as a list (empty when it is, or for any other file). The
 * source as written, or as staged: the staging hook's notice is removed when it is exactly the second line, nothing else.
 */
export function endpointPinRefusals(rel, source) {
  if (rel !== ENDPOINT_LISTENER_FILE) return [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines[1] === `// ${STAGED_NOTICE}`) lines.splice(1, 1);
  const sha = createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
  return sha === ENDPOINT_LISTENER_SHA256 ? [] : [`${rel} is not the pinned endpoint template (sha256 ${sha}, pinned ${ENDPOINT_LISTENER_SHA256}; a staged copy may differ only by the staging notice as its second line, after the copyright line): change the pin in web-rules.mjs with the file, in a reviewed change`];
}
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
