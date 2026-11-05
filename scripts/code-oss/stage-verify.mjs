// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// Checks of the STAGED output (ADR 0005 D3), independent of the code that produced it: the import allowlist
// applied to the staged files, the manifest against the disk, and the tree hash.
import { createHash } from "node:crypto";
import { join, posix } from "node:path";
import { StageError, fail, readRegular, walkFiles } from "./stage-fs.mjs";
import { RESTRICTED_MODULES, hiddenLoaders, importSpecifiers, nonLiteralLoads } from "./stage-scan.mjs";

export const STAGE_ROOT = "src/vs/axis/packages";
export const MANIFEST_NAME = "stage-manifest.json";
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** SHA-256 over every staged file's path and content hash, in byte order. The manifest itself is not included. */
export function treeHash(files) {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) h.update(`${f.path}\0${f.sha256}\n`);
  return h.digest("hex");
}

/**
 * The import allowlist, applied to one staged file. `rel` is relative to STAGE_ROOT (posix) and `fileSet` holds
 * every staged path. A staged file may import only `node:*` built-ins and other staged files by relative path
 * (a `.js` specifier names the `.ts` source or the vendored `.js`). Bare specifiers, including `zod` and
 * `@axis/*`, must already have been rewritten, so any that remain mean the tree would resolve them at run time.
 */
export function checkStagedFile(rel, text, fileSet) {
  const here = posix.dirname(rel);
  const pkg = rel.split("/")[0];
  const isTs = rel.endsWith(".ts");
  if (isTs && !rel.endsWith(".d.ts")) {
    for (const t of hiddenLoaders(text)) fail(`staged ${rel}: ${t} hides a load from the import check`);
    for (const t of nonLiteralLoads(text)) fail(`staged ${rel}: dynamic load needs a string literal (${t})`);
  }
  for (const spec of importSpecifiers(text, { code: pkg === "vendor" })) {
    if (/^node:[a-z_]+(?:\/[a-z0-9_]+)*$/.test(spec)) {
      if (pkg === "vendor") fail(`staged ${rel}: vendored code imports ${spec}`);
      continue;
    }
    if (!spec.startsWith("./") && !spec.startsWith("../")) fail(`staged ${rel}: bare import ${spec} would resolve from the tree at run time`);
    const target = posix.normalize(posix.join(here, spec));
    if (target.startsWith("../") || target === "..") fail(`staged ${rel}: ${spec} leaves the staged tree`);
    const candidates = target.endsWith(".js") ? [target, target.replace(/\.js$/, ".ts"), target.replace(/\.js$/, ".d.ts")] : [target];
    if (!candidates.some((c) => fileSet.has(c))) fail(`staged ${rel}: ${spec} does not resolve to a staged file`);
    const targetPkg = target.split("/")[0];
    if (pkg === "vendor" && targetPkg !== "vendor") fail(`staged ${rel}: vendored code reaches ${spec}`);
    if (pkg !== "vendor" && targetPkg === "vendor" && !target.startsWith("vendor/zod/")) fail(`staged ${rel}: ${spec} reaches an unknown vendored module`);
    for (const r of RESTRICTED_MODULES) {
      if (target.startsWith(`${r.pkg}/${r.file.replace(/\.ts$/, "")}.`) && pkg !== r.pkg && !r.importers.has(pkg)) {
        fail(`staged ${rel}: ${spec} reaches ${r.pkg}/${r.file}, which only ${[...r.importers].join(", ")} may import`);
      }
    }
  }
}

/**
 * Re-reads the staged tree from disk and checks it against its manifest: no link or odd file, no file the manifest
 * does not list, no listed file missing or changed, the tree hash, and the import allowlist on every staged file.
 * Returns the manifest. Throws StageError otherwise.
 */
export function verifyStaged(tree) {
  const stageRoot = join(tree, STAGE_ROOT);
  let manifest;
  try {
    manifest = JSON.parse(readRegular(join(stageRoot, MANIFEST_NAME), MAX_FILE_BYTES).data.toString("utf8"));
  } catch (e) {
    if (e instanceof StageError) throw e;
    return fail(`${STAGE_ROOT}/${MANIFEST_NAME} is missing or not JSON`);
  }
  if (manifest?.schema !== 1 || !Array.isArray(manifest.files)) fail(`${MANIFEST_NAME} has an unknown schema`);
  const listed = new Map(manifest.files.map((f) => [f.path, f.sha256]));
  if (listed.size !== manifest.files.length) fail(`${MANIFEST_NAME} lists a path twice`);
  const texts = new Map();
  const seen = new Set();
  for (const f of walkFiles(stageRoot)) {
    if (f.rel === MANIFEST_NAME) continue;
    seen.add(f.rel);
    if (!listed.has(f.rel)) fail(`${STAGE_ROOT}/${f.rel}: not in the manifest (unexpected file)`);
    const { data } = readRegular(f.path, MAX_FILE_BYTES);
    if (sha256(data) !== listed.get(f.rel)) fail(`${STAGE_ROOT}/${f.rel}: content does not match the manifest`);
    if (/\.(?:ts|js)$/.test(f.rel)) texts.set(f.rel, data.toString("utf8"));
  }
  for (const p of listed.keys()) if (!seen.has(p)) fail(`${STAGE_ROOT}/${p}: listed in the manifest but missing`);
  if (treeHash(manifest.files) !== manifest.treeSha256) fail(`${MANIFEST_NAME}: treeSha256 does not match its files`);
  for (const [rel, text] of texts) checkStagedFile(rel, text, seen);
  return manifest;
}
