// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { INTEGRATIONS_REASONS, INTEGRATIONS_REFUSALS, type IntegrationsRefusalCode } from "@axis/protocol";
import type { ComposeRefusal } from "../net/compose-request.js";
import type { EgressErrorCode } from "../net/egress-errors.js";
import type { TargetRefusal } from "../net/host.js";
import type { MatchRefusal } from "../net/url-pattern.js";

/**
 * Every outcome of the integrations service as one closed reason (docs/design/net-read-slice.md §4, the wire mapping): a
 * contract refusal reason (`INTEGRATIONS_REFUSALS`), or `cancelled` (`E_CANCELLED`) or `internal` (`E_INTERNAL`, fixed text).
 * The audit row's `reason` is this reason or `ok`: a set of its own, separate from the wire reasons it includes. Each table
 * below is a complete `Record` over the lower layer's closed codes, so a new code fails the build until it is mapped.
 */
export type IntegrationReason = (typeof INTEGRATIONS_REASONS)[number] | "cancelled" | "internal";
export const AUDIT_REQUEST_REASONS: readonly string[] = Object.freeze(["ok", "cancelled", "internal", ...INTEGRATIONS_REASONS]);

/** A closed refusal of the service: a reason only, never an argument, URL, header, body or credential. */
export class IntegrationRefusal extends Error {
  constructor(readonly reason: IntegrationReason) {
    super("integration request refused");
    this.name = "IntegrationRefusal";
  }
}

/** The envelope code of a reason: `E_CANCELLED`, `E_INTERNAL`, or the contract code whose list holds it. */
export function wireCode(reason: IntegrationReason): IntegrationsRefusalCode | "E_CANCELLED" | "E_INTERNAL" {
  if (reason === "cancelled") return "E_CANCELLED";
  if (reason === "internal") return "E_INTERNAL";
  for (const [code, reasons] of Object.entries(INTEGRATIONS_REFUSALS)) if ((reasons as readonly string[]).includes(reason)) return code as IntegrationsRefusalCode;
  return "E_INTERNAL";
}

/** The egress client's codes. The ones only a malformed request can raise are daemon bugs: the handler built the request. */
export const EGRESS_REASON: Readonly<Record<EgressErrorCode, IntegrationReason>> = Object.freeze({
  aborted: "cancelled",
  connect_failed: "network_unavailable",
  tls_failed: "network_unavailable",
  unresolved: "network_unavailable",
  first_byte_timeout: "timeout",
  total_timeout: "timeout",
  http_status: "upstream_status",
  json_invalid: "response_invalid",
  json_too_deep: "response_depth_exceeded",
  response_headers_too_large: "headers_too_large",
  address_refused: "address_refused",
  redirect_refused: "redirect_refused",
  encoding_refused: "encoding_refused",
  response_too_large: "response_too_large",
  rate_limited: "rate_limited",
  busy: "busy",
  request_too_large: "request_too_large",
  request_refused: "internal",
  not_authorized: "internal",
  method_refused: "internal",
  target_refused: "internal",
  header_refused: "internal",
});

/** Composition refusals: a caller's argument, or (template, integration, method, body) the daemon's own template. */
export const COMPOSE_REASON: Readonly<Record<ComposeRefusal, IntegrationReason>> = Object.freeze({
  argument_unknown: "argument_refused",
  argument_missing: "argument_refused",
  argument_type: "argument_refused",
  argument_refused: "argument_refused",
  argument_too_long: "argument_refused",
  non_ascii: "argument_refused",
  path_refused: "path_refused",
  origin_refused: "origin_refused",
  template_invalid: "internal",
  integration_refused: "internal",
  method_refused: "internal",
  body_refused: "internal",
});

/** The target check of the composed URL against the declared origins. */
export const TARGET_REASON: Readonly<Record<TargetRefusal, IntegrationReason>> = Object.freeze({
  not_https: "origin_refused",
  malformed: "origin_refused",
  userinfo: "origin_refused",
  ip_literal: "origin_refused",
  trailing_dot: "origin_refused",
  not_canonical: "origin_refused",
  origin_not_declared: "origin_refused",
});

/** The match of the parsed URL against the composed request: the URL did not read back as composed. */
export const MATCH_REASON: Readonly<Record<MatchRefusal, IntegrationReason>> = Object.freeze({
  target: "origin_refused",
  origin: "origin_refused",
  userinfo: "origin_refused",
  fragment: "path_refused",
  path: "path_refused",
  query: "path_refused",
  identity: "internal",
  already_matched: "internal",
});

/** A table lookup that fails closed: an unknown code is `internal`. */
export function reasonIn<K extends string>(table: Readonly<Record<K, IntegrationReason>>, code: unknown): IntegrationReason {
  return typeof code === "string" && Object.hasOwn(table, code) ? table[code as K] : "internal";
}
