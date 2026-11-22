// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// The connection vault and the Anthropic adapter inside the daemon host (daemon-host.md 2.1; ticket C6; ADR 0009 decision 5,
// ticket PV-N1c): only the providers binding may load the adapter, and only the providers binding and the integrations binding
// (built by PV-N1f) may load the vault. Every other host file is refused, tests included. Used by imports.test.mjs for the
// daemon host; mirrors the vault and adapter entries of RESTRICTED_MODULES in scripts/code-oss/stage-scan.mjs.

/** Host files (package-relative) allowed to import each specifier. */
export const VAULT_RULES = new Map([
  ["@axis/anthropic", Object.freeze(["src/bindings/providers.ts"])],
  ["@axis/vault", Object.freeze(["src/bindings/providers.ts", "src/bindings/integrations.ts"])],
]);

/**
 * The verdict for `spec` imported by the daemon host file `rel` (package-relative, `/`-separated; null for a call without a file):
 * "ok", a refusal, or null when the specifier is neither the vault nor the adapter (a subpath of either counts as the package).
 */
export function vaultVerdict(spec, rel) {
  const pkg = [...VAULT_RULES.keys()].find((p) => spec === p || spec.startsWith(`${p}/`));
  if (pkg === undefined) return null;
  const files = VAULT_RULES.get(pkg);
  if (rel !== null && files.includes(rel)) return "ok";
  return `only ${files.join(", ")} may import ${pkg}`;
}
