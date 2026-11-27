// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The project trust gate's import rules (docs/design/project-registration-and-trust.md §5.4, review S1b A SF1), for imports.test.mjs:
// only the composition (`src/compose-serving.ts`) loads the gate factories, only the two gate modules reach the ticket's brand and
// state, and only the composition root (`src/compose.ts`) loads the composition helper that builds the gate. Code outside `src/`
// (tests and the test rigs in `testing/`) is not limited here. Mirrors the staged-tree rules in scripts/code-oss/stage-scan.mjs.

/**
 * `target`: the imported file, relative to the package (`src/gate/project-trust-gate.ts`, with or without an extension).
 * `from`: the importing file, relative to the package. A reason, or null.
 */
export function projectTrustVerdict(target, from) {
  if (!from.startsWith("src/")) return null;
  const is = (name) => new RegExp(`^src/${name}(\\.[cm]?[jt]s)?$`).test(target);
  if (is("gate/project-trust-gate") && from !== "src/compose-serving.ts") return "only src/compose-serving.ts (the composition) may import the project trust gate factories";
  if (is("gate/project-ticket") && from !== "src/gate/project-trust.ts" && from !== "src/gate/project-trust-gate.ts") return "only the project trust gate modules may import the project trust ticket";
  if (is("compose-serving") && from !== "src/compose.ts") return "only the composition root src/compose.ts may import compose-serving";
  return null;
}
