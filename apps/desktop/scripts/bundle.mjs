// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Bundles the own shell with the pinned esbuild into dist/app: main.cjs and preload.cjs (Node, CommonJS, Electron
// external), renderer/renderer.js (browser, one classic script), the page and its stylesheet, and the notices:
// THIRD-PARTY-NOTICES.txt (generated from the lockfile, scripts/notices.mjs) and, when the Electron runtime is
// installed, its LICENSES.chromium.html (the Chromium licences), which ship next to the app.
//   node scripts/bundle.mjs [--out <dir>]
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const appDir = dirname(dirname(fileURLToPath(import.meta.url)));

/** The Chromium licence file inside the installed Electron runtime (absent when the runtime was not downloaded). */
export function chromiumLicences(root = appDir) {
  return join(root, "..", "..", "node_modules", "electron", "dist", "LICENSES.chromium.html");
}

/** Builds everything into `out`; returns esbuild's metafiles by bundle name. */
export async function bundle(out = join(appDir, "dist", "app")) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "renderer"), { recursive: true });
  const common = { bundle: true, metafile: true, logLevel: "warning", legalComments: "linked", sourcemap: false };
  const node = { ...common, platform: "node", format: "cjs", target: "node24", external: ["electron"] };
  const meta = {};
  meta.main = (await build({ ...node, entryPoints: [join(appDir, "main", "entry.ts")], outfile: join(out, "main.cjs") })).metafile;
  meta.preload = (await build({ ...node, entryPoints: [join(appDir, "preload", "preload.ts")], outfile: join(out, "preload.cjs") })).metafile;
  meta.renderer = (
    await build({
      ...common,
      platform: "browser",
      format: "iife",
      target: "chrome140",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      minify: true,
      entryPoints: [join(appDir, "renderer", "main.tsx")],
      outfile: join(out, "renderer", "renderer.js"),
    })
  ).metafile;
  copyFileSync(join(appDir, "renderer", "index.html"), join(out, "renderer", "index.html"));
  copyFileSync(join(appDir, "renderer", "shell.css"), join(out, "renderer", "shell.css"));
  copyFileSync(join(appDir, "THIRD-PARTY-NOTICES.txt"), join(out, "THIRD-PARTY-NOTICES.txt"));
  if (existsSync(chromiumLicences())) copyFileSync(chromiumLicences(), join(out, "LICENSES.chromium.html"));
  return meta;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--out");
  await bundle(at === -1 ? undefined : resolve(process.argv[at + 1]));
}
