// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// Mutation run for PV-N0c-1 (docs/design/secret-broker.md §6.1): the daemon side of the secret broker. Slice 1 is the provider
// reveal gate in the vault; slice 2 (a) adds the control client's secrets requests and the backend over them; (b) the wiring
// behind the composition option, the startup reveal, and the provider and integrations canaries through the broker.
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
const F = {
  v: `${V}/src/vault.js`,
  b: `${H}/src/secrets-backend.js`,
  c: `${H}/src/control/client.js`,
  w: `${H}/src/compose.js`,
  s: `${H}/src/compose-secrets.js`,
  p: `${H}/src/bindings/providers.js`,
};
const SLICE = `${H}/test/slice/secrets-broker.test.js`;
const PROVIDERS = `${H}/test/secrets-broker-providers.test.js`;
const BT = [`${H}/test/secrets-backend-put.test.js`, `${H}/test/secrets-backend-read.test.js`];
const T = {
  v: [`${V}/test/provider-reveal.test.js`, `${V}/test/integration-reveal.test.js`, `${V}/test/vault.test.js`],
  b: BT,
  c: [`${H}/test/secrets-client.test.js`, ...BT, `${H}/test/control-client.test.js`],
  w: [SLICE, `${H}/test/compose.test.js`, `${H}/test/integrations/handlers.test.js`],
  s: [SLICE, `${H}/test/compose.test.js`, PROVIDERS],
  p: [PROVIDERS, SLICE],
};
const M = [
  // The provider reveal gate (design review 1 S1).
  ["v", "provider reveals ungated under refuse", ' || weak === "refuse";', ";"],
  ["v", "every reveal gated, consent included", 'const gated = PURPOSE_KIND[purpose] === "integration" || weak === "refuse";', "const gated = true;"],

  // Slice 2 (a): put-unknown reconciliation (§3.4) and certainty from whether the request was sent (review SF-3).
  ["b", "a failed put is not reconciled", 'if (!answer.ok && answer.error === "failed")\n                    return reconcile(name, secret, meta);', ""],
  ["b", "a sent put cut off is not reconciled", "throw e; // never left the daemon: nothing to reconcile\n                    return reconcile(name, secret, meta);", "throw e; // never left the daemon: nothing to reconcile\n                    throw e;"],
  ["b", "a put never sent is reconciled anyway", "|| !mayHaveActed.has(e))", "|| false)"],
  ["b", "every failed request counted as maybe sent", "if (r.sent)\n                mayHaveActed.add(f);", "mayHaveActed.add(f);"],
  ["b", "no failed request counted as maybe sent", "if (r.sent)\n                mayHaveActed.add(f);", ";"],
  ["c", "the client never records that it sent", "if (mark !== undefined)\n                    mark.sent = true;", ";"],
  ["b", "reconciliation ignores the secret", "seen.secret !== secret || ", ""],
  ["b", "reconciliation ignores storedAt", " || seen.meta.storedAt !== meta.storedAt", ""],
  ["b", "reconciliation ignores the label", " || seen.meta.label !== meta.label", ""],
  ["b", "reconciliation ignores the consent", " || seen.meta.weakConsent !== meta.weakConsent", ""],
  ["b", "a late landing reported where the put asked", "return { id: seen.meta.backend, protection: seen.meta.protection };", "return { id: meta.backend, protection: meta.protection };"],
  ["b", "an undecided reconciliation reported as absent", 'emit("secrets.put_unknown");\n            throw fail("unknown");', 'throw fail("failed");'],
  // Same-name ordering and its bounds (review SF-1).
  ["b", "puts and removes for a name do not wait for the previous one", "const before = mutations.get(name);\n        const mine = (async () => {", "const before = undefined;\n        const mine = (async () => {"],
  ["b", "a read does not wait for a pending mutation", "const before = mutations.get(name);\n        if (before !== undefined)\n            await waitFor(`r:${name}`, before, deadline);\n        return run(deadline);", "return run(deadline);"],
  ["b", "the per-name wait is unbounded", "if (n >= MAX_WAITING_PER_NAME)", "if (false)"],
  ["b", "a put that gave up waiting lets the next one pass", "Promise.all([before, mine.catch(() => undefined)])", "Promise.all([mine.catch(() => undefined)])"],
  ["b", "reads and mutations share one waiting count", "await waitFor(`m:${name}`, before, deadline);", "await waitFor(`r:${name}`, before, deadline);"],
  ["b", "a waiting request has no deadline of its own", 'setTimeout(() => r("timeout"), Math.max(0, deadline - performance.now()))', 'setTimeout(() => r("timeout"), 2147483647)'],
  ["b", "a request that used its budget waiting is still sent", "if (left < 1)\n            throw fail(\"timeout\");", ";", "the wait itself fails at the deadline first, and a 0 ms budget is refused unsent by the client (timeout_range)"],
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

  // Slice 2 (b): the option's guard (zero sends when off), the one backend for both bindings, the startup reveal.
  ["w", "the wiring built with the option off", "secretBrokerWiring(options.secretBroker, control, logger)", 'secretBrokerWiring(options.secretBroker ?? { connectionId: "anthropic-main" }, control, logger)'],
  ["s", "the wiring's own guard dropped", "if (option === undefined)\n        return undefined;", 'if (option === undefined)\n        option = { connectionId: "anthropic-main" };'],
  ["w", "the startup reveal never started", "void broker.startup((signal) => providers.validateStored(signal));", ";"],
  ["w", "the integrations binding without the broker backend", "backend: viaBroker ?? options.integrations?.vaultBackend", "backend: options.integrations?.vaultBackend"],
  // Review b: the rollback the vault uses, the bounded startup wait, and the stop at shutdown.
  ["p", "the broker vault's rollback back to 5 s", "rollbackTimeoutMs: conn.vault.rollbackTimeoutMs", "rollbackTimeoutMs: 5000"],
  ["p", "provider requests do not wait for the startup reveal", 'if (purpose === "provider_request")\n            await afterStartup();', ""],
  ["p", "the startup reveal ignores shutdown", "if (signal?.aborted === true)\n", "if (false)\n"],
  ["s", "stop does not tell the reveal", "halt.abort();", ";"],
  ["w", "a second backend beside the broker accepted", 'refuseComposition("secret_broker_conflict");', ";"],
  ["p", "provider reveals under consent (the weak-entry refusal off)", '...(conn.vault === undefined ? { weakPolicy: "consent" } : { weakPolicy: "refuse", rollbackTimeoutMs: conn.vault.rollbackTimeoutMs })', '...{ weakPolicy: "consent" }'],
  ["p", "the composition's vault policy dropped on the way in", "...(o.pricing === undefined ? {} : { pricing: o.pricing }), ...vault }", "...(o.pricing === undefined ? {} : { pricing: o.pricing }) }"],
  ["p", "integration entries revealed at start", '.filter((id) => !id.startsWith("integration:"))', ""],
  ["p", "a startup failure audited under the wrong connection", 'audited(purpose, e instanceof VaultError ? e.code : "backend_failed", id);', 'audited(purpose, e instanceof VaultError ? e.code : "backend_failed");'],
  ["p", "the startup validation stops at the first failure", "                // audited by apiKey; that connection stays unvalidated, nothing is retried\n", "                break;\n"],
];
runMutants({ root, files: F, tests: T, mutants: M });
