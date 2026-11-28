// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// Mutation run for PV-N0c-1 (docs/design/secret-broker.md §6.1): the daemon side of the secret broker. Slice 1 is the provider
// reveal gate in the vault; slice 2 (a) adds the control client's secrets requests and the backend over them; (b) the wiring.
//
//   npm run build && node scripts/mutation/secret-broker.mjs "$PWD"
//
// Each mutant edits ONE compiled file under dist, runs the tests that must catch it, and restores the file (run.mjs). Lines
// with a fifth field are documented equivalents: they run and must survive. Not part of the gate: run it after a change to
// these files and state the result.
import { runMutants } from "./run.mjs";
const root = process.argv[2];
const V = `${root}/packages/vault/dist`;
const H = `${root}/packages/daemon-host/dist`;
const F = { v: `${V}/src/vault.js`, b: `${H}/src/secrets-backend.js`, c: `${H}/src/control/client.js` };
const BT = [`${H}/test/secrets-backend-put.test.js`, `${H}/test/secrets-backend-read.test.js`];
const T = {
  v: [`${V}/test/provider-reveal.test.js`, `${V}/test/integration-reveal.test.js`, `${V}/test/vault.test.js`],
  b: BT,
  c: [`${H}/test/secrets-client.test.js`, ...BT, `${H}/test/control-client.test.js`],
};
const M = [
  // The provider reveal gate (design review 1 S1).
  ["v", "provider reveals ungated under refuse", ' || weak === "refuse";', ";"],
  ["v", "every reveal gated, consent included", 'const gated = PURPOSE_KIND[purpose] === "integration" || weak === "refuse";', "const gated = true;"],

  // Slice 2 (a): put-unknown reconciliation (§3.4).
  ["b", "a failed put is not reconciled", 'if (!answer.ok && answer.error === "failed")\n                    return reconcile(name, secret, meta);', ""],
  ["b", "a timed-out put is not reconciled", "throw e; // never reached main: nothing to reconcile\n                    return reconcile(name, secret, meta);", "throw e; // never reached main: nothing to reconcile\n                    throw e;"],
  ["b", "a put never sent is reconciled anyway", "if (e.certain === true)\n", "if (false)\n"],
  ["b", "a busy request counted as maybe sent", 'return { reason: "busy", certain: true };', 'return { reason: "busy", certain: false };'],
  ["b", "reconciliation ignores the secret", "seen.secret !== secret || ", ""],
  ["b", "reconciliation ignores storedAt", " || seen.meta.storedAt !== meta.storedAt", ""],
  ["b", "reconciliation ignores the label", " || seen.meta.label !== meta.label", ""],
  ["b", "reconciliation ignores the consent", " || seen.meta.weakConsent !== meta.weakConsent", ""],
  ["b", "a late landing reported where the put asked", "return { id: seen.meta.backend, protection: seen.meta.protection };", "return { id: meta.backend, protection: meta.protection };"],
  ["b", "an undecided reconciliation reported as absent", 'emit("secrets.put_unknown");\n            throw fail("unknown");', 'throw fail("failed");'],
  // Same-name ordering.
  ["b", "requests for a name do not wait for the previous one", "const mine = before.then(run);", "const mine = Promise.resolve().then(run);"],
  ["b", "remove leaves without the name's chain", 'remove(name) {\n            return serial(name, async () => {', "remove(name) {\n            return (async () => {"],
  // Reads, info and the tolerant list.
  ["b", "an unavailable cipher reported as protected", 'protection: v.available ? v.protection : "none"', "protection: v.protection"],
  ["b", "the list keeps names the vault refuses", "if (SECRET_NAME_RE.test(e.name))", "if (true)"],
  ["b", "the backend's own op check", "if (answer.value.op !== op)", "if (false)", "the control client refuses an answer of another op first (secrets-client.test)"],
  // The control client.
  ["c", "a ninth request is sent", "if (this.#secretsOutstanding >= MAX_SECRETS_OUTSTANDING && !this.#disposed) {", "if (false) {"],
  ["c", "a settled request keeps its slot", "            this.#secretsOutstanding -= 1;\n", "\n"],
  ["c", "get and put wait only 10 s", 'ask.type === "secrets.get" || ask.type === "secrets.put" ? SECRETS_TIMEOUTS_MS.slow', "false ? SECRETS_TIMEOUTS_MS.slow"],
  ["c", "an answer of another op accepted", "m.value.op === op)", "true)"],
  ["c", "a malformed answer waits for the timer", "            this.#refuseSecretsAnswer(raw);\n", "\n"],
];
runMutants({ root, files: F, tests: T, mutants: M });
