// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Shared scanning rules for test/packages/*.test.mjs (this file is not a test).
//
// The hidden-loader and re-export rules live in scripts/code-oss/stage-ast.mjs (a parse, shared with the staging hook).

/** Every extension a script can have: JavaScript and TypeScript, in module, CommonJS and JSX flavours. */
export const SCRIPT_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx"];

/** True for a script file the scanners must read; declaration files (`.d.ts`, `.d.mts`, `.d.cts`) hold no code. */
export function isScriptFile(path) {
  if (/\.d\.[mc]?ts$/.test(path)) return false;
  return SCRIPT_EXTENSIONS.some((ext) => path.endsWith(ext));
}

export const PRINCIPAL_SUBPATH = "@axis/journal/daemon-principal";
