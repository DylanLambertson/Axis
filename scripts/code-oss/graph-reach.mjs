// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// Transitive reachability on the esbuild metafile (ADR 0005 D3): the host's minter modules, and the composition files that
// load them, may be reached only from the composition points. The per-edge rule (RESTRICTED_MODULES) already refuses a direct
// importer; this walk is the independent whole-graph form, so a barrel hop or a chain of helpers cannot launder a minter to
// handler code even if one edge of the table were wrong or missing.
import { HOST_COMPOSITION_FILES, HOST_MINTER_FILES } from "./stage-scan.mjs";

/**
 * Returns `{ path, text }` entries. Walks the staged import graph from every staged module that is not a minter and not a composition file, and reports the first
 * path to a minter or a composition file. A walk does not continue through either, so the composition root's own edges (it loads
 * the handlers and the minters on purpose) are never counted. `stagedOf` maps a metafile path to its staged-relative path or null.
 */
export function minterReachViolations(metafile, stagedOf) {
  const edges = new Map();
  for (const [input, info] of Object.entries(metafile.inputs)) {
    const rel = stagedOf(input);
    if (rel === null) continue;
    edges.set(rel, info.imports.map((i) => stagedOf(i.path)).filter((t) => t !== null));
  }
  const holders = new Set([...HOST_MINTER_FILES, ...HOST_COMPOSITION_FILES]);
  const bad = [];
  for (const start of edges.keys()) {
    if (holders.has(start)) continue;
    const parent = new Map([[start, null]]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      for (const next of edges.get(queue[i]) ?? []) {
        if (parent.has(next)) continue;
        parent.set(next, queue[i]);
        if (holders.has(next)) {
          const path = [next];
          for (let at = queue[i]; at !== null; at = parent.get(at)) path.unshift(at);
          bad.push({ path, text: `${path.join(" -> ")}: staged code outside the composition points reaches ${next}, which only they may reach` });
        } else queue.push(next);
      }
    }
  }
  return bad;
}

/**
 * Returns the reasons a metafile cannot be trusted for the walk: it has no inputs, none of them staged, or an edge to a staged module
 * that has no input entry (the walk would treat that module as a leaf and never follow its imports). Empty means complete.
 */
export function metafileGaps(metafile, stagedOf) {
  const inputs = metafile?.inputs;
  if (inputs === null || typeof inputs !== "object" || Object.keys(inputs).length === 0) return ["the metafile has no inputs, so the graph walk saw nothing"];
  const gaps = [];
  if (!Object.keys(inputs).some((i) => stagedOf(i) !== null)) gaps.push("the metafile has no staged input, so the graph walk saw nothing of the staged tree");
  for (const [input, info] of Object.entries(inputs)) {
    if (!Array.isArray(info?.imports)) {
      gaps.push(`${input}: the metafile entry has no imports list`);
      continue;
    }
    for (const imp of info.imports) {
      if (imp.external === true || stagedOf(imp.path) === null) continue;
      if (!Object.hasOwn(inputs, imp.path)) gaps.push(`${input}: imports ${imp.path}, which the metafile has no input entry for (incomplete metafile)`);
    }
  }
  return gaps;
}
