// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// PV-X1a (docs/design/pty-exec-node.md §5a): the daemon host reaches the pty process only through `@axis/pty-process/client`, from
// its one binding, so no shipped daemon module can reach the exec function (`exec-node.ts`), the service or the native spawn
// adapter. Tests and test support may import the package root. Used by imports.test.mjs for the daemon host.

export const PTY_CLIENT_IMPORTERS = new Set(["src/bindings/pty-control.ts"]);

/**
 * The verdict for `spec` imported by the daemon host file `rel` (package-relative, `/`-separated; null for a call without a file,
 * judged as `src/`): "ok", a refusal, or null when the specifier is not the pty process's.
 */
export function ptyClientVerdict(spec, rel) {
  if (spec !== "@axis/pty-process" && !spec.startsWith("@axis/pty-process/")) return null;
  const at = rel ?? "src/";
  if (!at.startsWith("src/")) return "ok";
  return spec === "@axis/pty-process/client" && PTY_CLIENT_IMPORTERS.has(at) ? "ok" : "the daemon host's src may import only @axis/pty-process/client, from src/bindings/pty-control.ts";
}
