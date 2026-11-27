// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { AuditEventInput, Redactor } from "@axis/audit";
import { resultValueSchema, type Integration } from "@axis/protocol";
import type { IntegrationsVault } from "../bindings/integrations.js";
import { CompositionError, composeRequest, type ArgValue } from "../net/compose-request.js";
import { EgressError } from "../net/egress-errors.js";
import { parseJsonBody } from "../net/egress-limits.js";
import { declaredOrigins, egressTarget } from "../net/host.js";
import { Credential, authorize, matchTarget, type AuthorizedRequest } from "../net/url-pattern.js";
import { echoInParsed, echoInRaw, echoNeedles } from "./echo.js";
import { CONNECTORS, connectorOf, operationOf, type Connector } from "./registry.js";
import { COMPOSE_REASON, EGRESS_REASON, IntegrationRefusal, MATCH_REASON, TARGET_REASON, reasonIn, type IntegrationReason } from "./wire.js";

/**
 * `axis.integrations/1` list, status and read for the built-in connectors (docs/design/net-read-slice.md). The steps of §4 in
 * order; every failure is an `IntegrationRefusal` with a closed reason. Once the `integration.credential` row is written, the
 * epilogue writes exactly one `integration.request` row on every exit path that follows.
 *
 * With no vault (no secret backend in the composition: production until PV-N0c, §7), nothing is revealed, sent or audited:
 * list and status show every connector `available`, and read is `not_connected`.
 */

/** What the service sends through: the egress client's authorized send, and nothing else of it. */
export interface IntegrationsSender {
  sendAuthorized(req: AuthorizedRequest, extra?: { readonly signal?: AbortSignal }): Promise<{ readonly status: number; readonly headers: Readonly<Record<string, string | string[] | undefined>>; readonly body: Buffer }>;
}

export interface IntegrationsServiceDeps {
  /** Absent: no secret backend in the composition. */
  readonly vault: IntegrationsVault | undefined;
  readonly sender: IntegrationsSender;
  readonly redactor: Pick<Redactor, "registerSecret">;
  readonly audit: { append(event: AuditEventInput): void };
  /** Monotonic milliseconds. */
  readonly now: () => number;
  /** TEST ONLY: another registry (the composition never passes one). */
  readonly connectors?: Readonly<Record<string, Connector>>;
}

export interface ReadInput {
  readonly projectId: string;
  readonly integrationId: string;
  readonly operation: string;
  readonly args?: Readonly<Record<string, ArgValue>>;
}

export interface IntegrationsService {
  list(projectId: string): Promise<Integration[]>;
  status(projectId: string, integrationId: string): Promise<Integration>;
  read(input: ReadInput, signal: AbortSignal): Promise<{ readonly status: number; readonly result: unknown }>;
}

const refuse = (reason: IntegrationReason): never => {
  throw new IntegrationRefusal(reason);
};
const entryOf = (id: string): string => `integration:${id}`;

export function createIntegrationsService(deps: IntegrationsServiceDeps): IntegrationsService {
  const registry = deps.connectors ?? CONNECTORS;
  const { vault, sender, redactor, audit, now } = deps;

  /** The state from the entry's metadata only (no decryption). A backend failure is not a state: `internal`. */
  const describe = async (c: Connector): Promise<Integration> => {
    let state: Integration["state"] = "available";
    if (vault !== undefined) {
      let info: Awaited<ReturnType<IntegrationsVault["info"]>>;
      try {
        info = await vault.info(entryOf(c.id));
      } catch {
        return refuse("internal");
      }
      if (info !== undefined) state = info.protection === "none" || info.backendChanged ? "needs_reconnect" : "connected";
    }
    return {
      id: c.id,
      label: c.label,
      origins: [...c.origins],
      operations: Object.entries(c.operations).map(([operation, op]) => ({ operation, write: op.kind !== "read" })),
      declaredScopes: [...c.declaredScopes],
      grantedScopes: [],
      state,
    };
  };

  const append = (event: AuditEventInput): boolean => {
    try {
      audit.append(event);
      return true;
    } catch {
      return false;
    }
  };

  return {
    list: async () => Promise.all(Object.values(registry).map(describe)),

    status: async (_projectId, integrationId) => describe(connectorOf(registry, integrationId) ?? refuse("not_found")),

    async read(input, signal) {
      const started = now();
      if (vault === undefined) return refuse("not_connected");
      const connector = connectorOf(registry, input.integrationId) ?? refuse("not_found");
      const op = operationOf(connector, input.operation) ?? refuse("not_found");
      if (op.kind !== "read") return refuse("operation_kind_mismatch");
      const origin = connector.origins[0] ?? refuse("internal");
      let composed: ReturnType<typeof composeRequest>;
      try {
        composed = composeRequest(op.template, connector.id, origin, input.args ?? {});
      } catch (e) {
        return refuse(e instanceof CompositionError ? reasonIn(COMPOSE_REASON, e.reason) : "internal");
      }
      const target = egressTarget(composed.url, declaredOrigins(connector.origins));
      if (typeof target === "string") return refuse(reasonIn(TARGET_REASON, target));
      const matched = matchTarget(composed, target);
      if (typeof matched === "string") return refuse(reasonIn(MATCH_REASON, matched));
      if (signal.aborted) return refuse("cancelled");

      // Step 4: the vault's reveal gate refuses a weak or moved entry; the connector's shape is checked before any use.
      let token: string;
      try {
        token = await vault.reveal(entryOf(connector.id));
      } catch (e) {
        return refuse(e instanceof IntegrationRefusal ? e.reason : "internal");
      }
      if (!connector.tokenShape.test(token)) return refuse("needs_reconnect");
      const header = `Bearer ${token}`;
      // Step 5: registered at once, before anything else uses the value. The redactor only grows.
      try {
        redactor.registerSecret(token);
        redactor.registerSecret(header);
      } catch {
        return refuse("internal");
      }
      const needles = echoNeedles(header, token);
      const base = { integrationId: connector.id, operation: input.operation, projectId: input.projectId };
      // Step 6: the credential row before attach; nothing is sent without it.
      if (!append({ actor: "user", action: "integration.credential", target: entryOf(connector.id), outcome: "success", payload: { ...base, actorKind: "user", purpose: "integration_request" } })) {
        return refuse("audit_unavailable");
      }

      let failure: IntegrationRefusal | undefined;
      let out: { readonly status: number; readonly result: unknown } | undefined;
      let status: number | undefined;
      let bytesOut = 0;
      let bytesIn = 0;
      try {
        if (signal.aborted) refuse("cancelled");
        const request = authorize(matched, new Credential(header, { integration: connector.id, origin }));
        // Charged once the send starts: the composed request target (path and ?query, as on the request line) and the body.
        bytesOut = Buffer.byteLength(composed.url.slice(origin.length), "utf8") + (composed.body?.byteLength ?? 0);
        let res: Awaited<ReturnType<IntegrationsSender["sendAuthorized"]>>;
        try {
          res = await sender.sendAuthorized(request, { signal });
        } catch (e) {
          return refuse(e instanceof EgressError ? reasonIn(EGRESS_REASON, e.code) : signal.aborted ? "cancelled" : "internal");
        }
        status = res.status;
        // What reached the handler: the body the client returned (the client's errors carry no counters; RR-87).
        bytesIn = res.body.byteLength;
        // Step 8, first scan: the raw headers and body, before any parse.
        if (echoInRaw(res.headers, res.body, needles)) refuse("credential_echoed");
        let parsed: unknown;
        try {
          parsed = parseJsonBody(res.body);
        } catch (e) {
          return refuse(e instanceof EgressError ? reasonIn(EGRESS_REASON, e.code) : "response_invalid");
        }
        // Step 8, second scan: every key and string of the parsed tree.
        if (echoInParsed(parsed, needles)) refuse("credential_echoed");
        const reduced = op.result.safeParse(parsed);
        if (!reduced.success) refuse("response_invalid");
        const result: unknown = reduced.data;
        if (echoInParsed(result, needles)) refuse("credential_echoed");
        if (!resultValueSchema.safeParse(result).success) refuse("response_invalid");
        out = { status: res.status, result };
      } catch (e) {
        failure = e instanceof IntegrationRefusal ? e : new IntegrationRefusal(signal.aborted ? "cancelled" : "internal");
      } finally {
        // Step 10, the epilogue: one request row on every exit after the credential row. Its failure discards any result.
        const reason = failure?.reason ?? (out === undefined ? "internal" : "ok");
        const durationMs = Math.max(0, Math.round(now() - started));
        const written = append({
          actor: "user",
          action: "integration.request",
          target: entryOf(connector.id),
          outcome: reason === "ok" ? "success" : "failure",
          payload: { ...base, ...(status === undefined ? {} : { status }), bytesOut, bytesIn, durationMs, reason },
        });
        if (!written) failure = failure?.reason === "cancelled" ? failure : new IntegrationRefusal("audit_unavailable");
      }
      if (failure !== undefined) throw failure;
      return out ?? refuse("internal");
    },
  };
}

/** The exact payload keys of the two rows (audit payload policy): nothing else is ever stored. */
export const INTEGRATIONS_PAYLOAD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "integration.credential": Object.freeze(["integrationId", "operation", "projectId", "actorKind", "purpose"]),
  "integration.request": Object.freeze(["integrationId", "operation", "projectId", "status", "bytesOut", "bytesIn", "durationMs", "reason"]),
});
