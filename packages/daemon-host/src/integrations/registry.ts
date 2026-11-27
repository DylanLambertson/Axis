// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import type { OperationTemplate } from "../net/compose-request.js";

/**
 * The built-in connectors (docs/design/net-read-slice.md §2): a frozen, daemon-only constant. Declared origins, scopes and
 * operations live ONLY here; no request, reply, setting or renderer value can add or change them. Plugin-contributed connectors
 * are PV-K's. Each operation's `result` reduces the service's JSON to a few named fields: anything it does not name is dropped,
 * and the reply is the reduced value, never the upstream object.
 */

export interface ReadOperation {
  readonly kind: "read";
  readonly template: OperationTemplate;
  /** Parses the upstream JSON and returns the reduced result (`safeParse` failure: `response_invalid`). */
  readonly result: z.ZodType;
}

/** The shape of an operation that is not a read (none is built in yet: `write` is planned). */
export interface WriteOperation {
  readonly kind: "write";
  readonly template: OperationTemplate;
}

export type Operation = ReadOperation | WriteOperation;

export interface Connector {
  readonly id: string;
  readonly label: string;
  /** Punycode HTTPS origins; the credential attaches to these and nothing else. */
  readonly origins: readonly string[];
  readonly declaredScopes: readonly string[];
  readonly auth: "bearer";
  /** The credential's shape, checked on every reveal before it is registered or used. */
  readonly tokenShape: RegExp;
  readonly operations: Readonly<Record<string, Operation>>;
}

/** A bounded single line of text from the service. */
const text = (max: number) => z.string().max(max);

/** One pull request or issue as the reply carries it: four named fields, nothing else from the upstream object. */
const item = z
  .object({
    number: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    title: text(512),
    state: z.enum(["open", "closed"]),
    user: z.object({ login: z.string().regex(/^[A-Za-z0-9-]{1,39}$/) }),
  })
  .transform((v) => ({ number: v.number, title: v.title, state: v.state, author: v.user.login }));

const OWNER = { kind: "id", pattern: /^[A-Za-z0-9-]{1,39}$/ } as const;
const REPO = { kind: "id", pattern: /^[A-Za-z0-9._-]{1,100}$/ } as const;

const github: Connector = {
  id: "github",
  label: "GitHub",
  origins: ["https://api.github.com"],
  // Named by PV-N3's review; the slice records and checks none of them (scope recording is PV-N2).
  declaredScopes: ["repo:status", "read:org"],
  auth: "bearer",
  // Visible ASCII only, so a header value can never carry a space, a control character or a line break.
  tokenShape: /^[\x21-\x7e]{20,255}$/,
  operations: {
    pulls_list: {
      kind: "read",
      template: {
        method: "GET",
        path: [{ literal: "repos" }, { arg: "owner", type: OWNER }, { arg: "repo", type: REPO }, { literal: "pulls" }],
        query: [
          { key: "state", arg: "state", type: { kind: "enum", values: ["open", "closed", "all"] }, required: false },
          { key: "per_page", arg: "perPage", type: { kind: "int", min: 1, max: 100 }, required: false },
        ],
      },
      result: z.array(item).max(100).transform((items) => ({ items })),
    },
    issue_get: {
      kind: "read",
      template: {
        method: "GET",
        path: [{ literal: "repos" }, { arg: "owner", type: OWNER }, { arg: "repo", type: REPO }, { literal: "issues" }, { arg: "number", type: { kind: "int", min: 1 } }],
      },
      result: item,
    },
  },
};

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !(value instanceof RegExp) && !(value instanceof z.ZodType) && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export const CONNECTORS: Readonly<Record<string, Connector>> = deepFreeze({ github });

/** The connector, own entries only (an inherited key such as `constructor` is not one). */
export function connectorOf(registry: Readonly<Record<string, Connector>>, id: string): Connector | undefined {
  return Object.hasOwn(registry, id) ? registry[id] : undefined;
}

/** The operation of a connector, own entries only. */
export function operationOf(connector: Connector, id: string): Operation | undefined {
  return Object.hasOwn(connector.operations, id) ? connector.operations[id] : undefined;
}
