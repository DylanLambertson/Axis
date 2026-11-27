// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// Mutation run for PV-N0c-1 (docs/design/secret-broker.md §6.1): the daemon side of the secret broker. Slice 1 is the provider
// reveal gate in the vault; later slices add the control client's secrets requests, the backend over them and the wiring.
//
//   npm run build && node scripts/mutation/secret-broker.mjs "$PWD"
//
// Each mutant edits ONE compiled file under dist, runs the tests that must catch it, and restores the file (run.mjs). Lines
// with a fifth field are documented equivalents: they run and must survive. Not part of the gate: run it after a change to
// these files and state the result.
import { runMutants } from "./run.mjs";
const root = process.argv[2];
const V = `${root}/packages/vault/dist`;
const F = { v: `${V}/src/vault.js` };
const T = { v: [`${V}/test/provider-reveal.test.js`, `${V}/test/integration-reveal.test.js`, `${V}/test/vault.test.js`] };
const M = [
  // The provider reveal gate (design review 1 S1).
  ["v", "provider reveals ungated under refuse", ' || weak === "refuse";', ";"],
  ["v", "every reveal gated, consent included", 'const gated = PURPOSE_KIND[purpose] === "integration" || weak === "refuse";', "const gated = true;"],
];
runMutants({ root, files: F, tests: T, mutants: M });
