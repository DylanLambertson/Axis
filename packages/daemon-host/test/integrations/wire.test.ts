// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The wire mapping of net-read-slice.md §4: every closed code of each lower layer maps to a contract reason, `cancelled` or
// `internal`, and each reason to its envelope code. Table-driven over the lower layers' own code lists, so a new code fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { INTEGRATIONS_REASONS, isIntegrationsRefusal } from "@axis/protocol";
import { VAULT_CODES, VAULT_REASON } from "../../src/bindings/integrations.js";
import { COMPOSE_REFUSALS } from "../../src/net/compose-request.js";
import { EGRESS_ERROR_TEXT } from "../../src/net/egress-errors.js";
import { AUDIT_REQUEST_REASONS, COMPOSE_REASON, EGRESS_REASON, MATCH_REASON, TARGET_REASON, reasonIn, wireCode, type IntegrationReason } from "../../src/integrations/wire.js";

const valid = (r: IntegrationReason): boolean => r === "cancelled" || r === "internal" || isIntegrationsRefusal(wireCode(r), r);

test("every egress code is mapped, exactly as the note's table says", () => {
  assert.deepEqual(Object.keys(EGRESS_REASON).sort(), Object.keys(EGRESS_ERROR_TEXT).sort());
  const expected: Record<string, [string, string | undefined]> = {
    aborted: ["E_CANCELLED", undefined],
    connect_failed: ["E_UNAVAILABLE", "network_unavailable"],
    tls_failed: ["E_UNAVAILABLE", "network_unavailable"],
    unresolved: ["E_UNAVAILABLE", "network_unavailable"],
    first_byte_timeout: ["E_TIMEOUT", "timeout"],
    total_timeout: ["E_TIMEOUT", "timeout"],
    http_status: ["E_UNAVAILABLE", "upstream_status"],
    json_invalid: ["E_UNAVAILABLE", "response_invalid"],
    json_too_deep: ["E_UNAVAILABLE", "response_depth_exceeded"],
    response_headers_too_large: ["E_UNAVAILABLE", "headers_too_large"],
    address_refused: ["E_UNAVAILABLE", "address_refused"],
    redirect_refused: ["E_UNAVAILABLE", "redirect_refused"],
    encoding_refused: ["E_UNAVAILABLE", "encoding_refused"],
    response_too_large: ["E_UNAVAILABLE", "response_too_large"],
    rate_limited: ["E_UNAVAILABLE", "rate_limited"],
    busy: ["E_CONFLICT", "busy"],
    request_too_large: ["E_INVALID_ARGUMENT", "request_too_large"],
    request_refused: ["E_INTERNAL", undefined],
    not_authorized: ["E_INTERNAL", undefined],
    method_refused: ["E_INTERNAL", undefined],
    target_refused: ["E_INTERNAL", undefined],
    header_refused: ["E_INTERNAL", undefined],
  };
  assert.deepEqual(Object.keys(expected).sort(), Object.keys(EGRESS_ERROR_TEXT).sort());
  for (const [code, [wire, reason]] of Object.entries(expected)) {
    const r = EGRESS_REASON[code as keyof typeof EGRESS_REASON];
    assert.equal(wireCode(r), wire, code);
    if (reason !== undefined) assert.equal(r, reason, code);
  }
});

test("every composition, target, match and vault code is mapped to a valid reason", () => {
  assert.deepEqual(Object.keys(COMPOSE_REASON).sort(), [...COMPOSE_REFUSALS].sort());
  assert.deepEqual(Object.keys(VAULT_REASON).sort(), [...VAULT_CODES].sort());
  for (const table of [EGRESS_REASON, COMPOSE_REASON, TARGET_REASON, MATCH_REASON, VAULT_REASON]) {
    for (const [code, r] of Object.entries(table)) assert.ok(valid(r), `${code} -> ${r}`);
  }
  assert.equal(VAULT_REASON.not_found, "not_connected");
  assert.equal(VAULT_REASON.weak_entry, "needs_reconnect");
  assert.equal(VAULT_REASON.backend_changed, "needs_reconnect");
  assert.equal(VAULT_REASON.backend_failed, "internal");
  assert.equal(COMPOSE_REASON.argument_refused, "argument_refused");
  assert.equal(COMPOSE_REASON.path_refused, "path_refused");
  assert.equal(COMPOSE_REASON.template_invalid, "internal");
  assert.equal(TARGET_REASON.origin_not_declared, "origin_refused");
});

test("the service's own reasons have the note's envelope codes", () => {
  for (const [r, code] of [
    ["not_connected", "E_CONFLICT"], ["needs_reconnect", "E_CONFLICT"], ["audit_unavailable", "E_CONFLICT"], ["credential_echoed", "E_UNAVAILABLE"],
    ["response_invalid", "E_UNAVAILABLE"], ["not_found", "E_NOT_FOUND"], ["operation_kind_mismatch", "E_INVALID_ARGUMENT"], ["cancelled", "E_CANCELLED"], ["internal", "E_INTERNAL"],
  ] as const) assert.equal(wireCode(r), code, r);
});

test("an unknown or inherited code fails closed to internal", () => {
  for (const code of ["", "constructor", "toString", "__proto__", 7, undefined, null]) assert.equal(reasonIn(EGRESS_REASON, code), "internal", String(code));
  assert.equal(reasonIn(EGRESS_REASON, "tls_failed"), "network_unavailable");
});

test("the audit reason set is ok, cancelled, internal and the contract reasons, nothing else", () => {
  assert.deepEqual([...AUDIT_REQUEST_REASONS].sort(), ["cancelled", "internal", "ok", ...INTEGRATIONS_REASONS].sort());
});
