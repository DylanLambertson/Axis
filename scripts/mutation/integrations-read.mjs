// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// Mutation run for the PV-N1f read slice (docs/design/net-read-slice.md): the read flow, the two echo scans, every mapped wire
// code, the handlers and the project gate, the vault's reveal gate, the registry and the integrations binding.
//
//   npm run build && node scripts/mutation/integrations-read.mjs "$PWD"
//
// Each mutant edits ONE compiled file under dist, runs the tests that must catch it, and restores the file (run.mjs). The scan
// mutants also run the canary acceptance test through the real composition. Lines with a fifth field are documented
// equivalents: they run and must survive. Not part of the gate: run it after a change to these files and state the result.
import { runMutants } from "./run.mjs";
const root = process.argv[2];
const D = `${root}/packages/daemon-host/dist`;
const V = `${root}/packages/vault/dist`;
const F = {
  s: `${D}/src/integrations/service.js`, sc: `${D}/src/integrations/service.js`, w: `${D}/src/integrations/wire.js`, e: `${D}/src/integrations/echo.js`,
  h: `${D}/src/handlers/integrations.js`, r: `${D}/src/integrations/registry.js`, b: `${D}/src/bindings/integrations.js`, v: `${V}/src/vault.js`,
};
const UNIT = ["service", "echo", "wire", "registry", "handlers"].map((n) => `${D}/test/integrations/${n}.test.js`);
const CANARY = [`${D}/test/slice/integrations-canary.test.js`];
const T = { s: UNIT, sc: [...UNIT, ...CANARY], w: UNIT, e: UNIT, h: UNIT, r: UNIT, b: [...UNIT, ...CANARY], v: [`${V}/test/integration-reveal.test.js`, `${V}/test/namespaces.test.js`] };

/** Every mapped wire code: the reason is replaced by another, and the table-driven tests must notice. */
const WIRE = [
  ["aborted", "cancelled"], ["connect_failed", "network_unavailable"], ["tls_failed", "network_unavailable"], ["unresolved", "network_unavailable"],
  ["first_byte_timeout", "timeout"], ["total_timeout", "timeout"], ["http_status", "upstream_status"], ["json_invalid", "response_invalid"],
  ["json_too_deep", "response_depth_exceeded"], ["response_headers_too_large", "headers_too_large"], ["address_refused", "address_refused"],
  ["redirect_refused", "redirect_refused"], ["encoding_refused", "encoding_refused"], ["response_too_large", "response_too_large"],
  ["rate_limited", "rate_limited"], ["busy", "busy"], ["request_too_large", "request_too_large"], ["request_refused", "internal"],
  ["not_authorized", "internal"], ["method_refused", "internal"], ["target_refused", "internal"], ["header_refused", "internal"],
].map(([code, reason]) => {
  // `method_refused` is in the composition table too: the egress one is the entry followed by `target_refused`.
  const tail = code === "method_refused" ? "\n    target_refused" : "";
  return ["w", `wire: egress ${code}`, `    ${code}: "${reason}",${tail}`, `    ${code}: "${reason === "internal" ? "network_unavailable" : "internal"}",${tail}`];
});
// The vault table (in the integrations binding) and the composition and target tables: each pinned entry.
const TABLES = [
  ["b", "not_found", "not_connected"], ["b", "weak_entry", "needs_reconnect"], ["b", "backend_changed", "needs_reconnect"], ["b", "backend_failed", "internal"],
  ["w", "argument_refused", "argument_refused"], ["w", "path_refused", "path_refused"], ["w", "template_invalid", "internal"], ["w", "origin_not_declared", "origin_refused"],
].map(([key, code, reason]) => [key, `wire: ${code}`, `    ${code}: "${reason}",`, `    ${code}: "${reason === "internal" ? "network_unavailable" : "internal"}",`]);

const M = [
  // The read flow.
  ["s", "no-backend check", 'if (vault === undefined)\n                return refuse("not_connected");', ""],
  ["s", "write operation via read", 'if (op.kind !== "read")\n                return refuse("operation_kind_mismatch");', ""],
  ["s", "abort before the reveal", 'if (signal.aborted)\n                return refuse("cancelled");\n            // Step 4', "// Step 4"],
  ["s", "token shape", 'if (!connector.tokenShape.test(token))\n                return refuse("needs_reconnect");', ""],
  ["s", "token not registered", "redactor.registerSecret(token);\n", ""],
  ["s", "header not registered", "                redactor.registerSecret(header);\n", "", "the header value is `Bearer ` and the token, so the token's registration already redacts it in every form"],
  ["s", "credential row failure ignored", '{\n                return refuse("audit_unavailable");\n            }', "{\n            }"],
  ["s", "abort before the send", 'if (signal.aborted)\n                    refuse("cancelled");\n                const request', "const request"],
  ["s", "bytesOut charged before the send", "let bytesOut = 0;", 'let bytesOut = Buffer.byteLength(composed.url.slice(origin.length), "utf8");'],
  ["s", "bytesIn not counted", "bytesIn = res.body.byteLength;", ""],
  ["s", "egress code mapping", 'return refuse(e instanceof EgressError ? reasonIn(EGRESS_REASON, e.code) : signal.aborted ? "cancelled" : "internal");', 'return refuse("internal");'],
  ["s", "parse code mapping", 'return refuse(e instanceof EgressError ? reasonIn(EGRESS_REASON, e.code) : "response_invalid");', 'return refuse("internal");'],
  ["s", "vault refusal kept", 'return refuse(e instanceof IntegrationRefusal ? e.reason : "internal");', 'return refuse("internal");'],
  ["s", "compose code mapping", "reasonIn(COMPOSE_REASON, e.reason)", '"internal"'],
  ["sc", "first scan removed", 'if (echoInRaw(res.headers, res.body, needles))\n                    refuse("credential_echoed");', ""],
  ["sc", "second scan removed", 'if (echoInParsed(parsed, needles))\n                    refuse("credential_echoed");', ""],
  ["s", "reduced-result scan removed", 'if (echoInParsed(result, needles))\n                    refuse("credential_echoed");', "", "the reduced result holds only strings of the parsed tree, which the second scan already read"],
  ["s", "schema mismatch ignored", 'if (!reduced.success)\n                    refuse("response_invalid");', "", "with no reduced value the bounds check below refuses with the same reason"],
  ["s", "bounds check removed", 'if (!resultValueSchema.safeParse(result).success)\n                    refuse("response_invalid");', "", "the registry's schemas only produce values inside the contract's result bounds"],
  ["s", "epilogue failure ignored", 'if (!written)\n                    failure', "if (false)\n                    failure"],
  ["s", "cancel not kept over an audit failure", 'failure?.reason === "cancelled" ? failure : new', "false ? failure : new"],
  ["s", "request row outcome", 'outcome: reason === "ok" ? "success" : "failure",', 'outcome: "success",'],
  ["s", "request row status", "...(status === undefined ? {} : { status })", "...{}"],
  // The scans.
  ["e", "header names", "if (holds(name, n))\n            return true;", ""],
  ["e", "repeated header values", "typeof value === \"string\" ? [value] : (value ?? [])", "typeof value === \"string\" ? [value] : []"],
  ["e", "body bytes", "if (n.bytes.some((b) => buf.indexOf(b) !== -1))\n        return true;", "", "the needles are ASCII (the token shape is visible ASCII), and UTF-8 decoding never alters an ASCII byte, so the text search finds the same"],
  ["e", "body text", 'return holds(buf.toString("utf8"), n);', "return false;", "the byte search finds every needle the text search does, for ASCII needles"],
  ["e", "parsed keys", "if (holds(k, n))\n                    return true;", ""],
  ["e", "parsed arrays", "for (const x of v)\n                stack.push(x);", ""],
  // The wire tables.
  ...WIRE,
  ...TABLES,
  ["w", "cancelled code", 'if (reason === "cancelled")\n        return "E_CANCELLED";', ""],
  ["w", "own entries only", "Object.hasOwn(table, code)", "code in table"],
  // The handlers and the project gate.
  ["h", "project check", 'if (deps.journal.getProject(payload.projectId) === undefined)\n            return fail("not_found");', ""],
  ["h", "gate not asked", "const ticket = await deps.gate.admit({ projectId: p.projectId, caller: trustCallOf(context.identity), signal: context.signal });\n            consumeTicket(ticket, { projectId: p.projectId }, deps.now);\n", ""],
  ["h", "ticket not spent", "consumeTicket(ticket, { projectId: p.projectId }, deps.now);\n", ""],
  ["h", "untrusted mapping", 'return fail("untrusted");', 'return fail("internal");'],
  ["h", "desktop user re-check", 'if (context.identity.actor !== "user" || context.identity.clientKind !== "desktop")\n            return fail("not_found");', "", "defence in depth: the policy rows already refuse every caller but the user's desktop before the handler"],
  // The vault's reveal gate.
  ["v", "integration reveal ungated", "if (gated)\n                    current = await currentInfo();", ""],
  ["v", "revealed entry's metadata unchecked", "held = readMeta(entry.meta);", "held = entry.meta;"],
  ["v", "backend id compared", "held.backend !== current.id || ", ""],
  ["v", "entry protection none", 'held.protection === "none" || ', "", "an entry whose protection is none differs from a protected current backend, and a current backend of none is refused by its own comparison"],
  ["v", "current protection none", 'current.protection === "none" || ', "", "a current backend of none differs from a protected entry, and an entry of none is refused by its own comparison"],
  ["v", "protection equality", " || held.protection !== current.protection", "", "PROTECTIONS is os_protected, none and ephemeral; the memory backend is always ephemeral and any other id maps ephemeral to none, so two records with the same backend id and different protection include none, which the two clauses before refuse"],
  // The registry and the composition.
  ["r", "token shape length", "tokenShape: /^[\\x21-\\x7e]{20,255}$/,", "tokenShape: /^[\\x21-\\x7e]{1,255}$/,"],
  ["r", "registry not frozen", "            deepFreeze(v);", ""],
  ["b", "a vault without a backend", "if (backend === undefined)\n        return undefined;", ""],
  ["b", "vault errors kept closed", 'e instanceof VaultError ? reasonIn(VAULT_REASON, e.code) : "internal"', '"internal"'],
];

runMutants({ root, files: F, tests: T, mutants: M });
