// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/** A provider connection id (the original rule; `@axis/protocol` `CONNECTION_NAME` is the same pattern). */
export const PROVIDER_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The prefix of an integration's entry name (ADR 0009 decision 5). */
export const INTEGRATION_PREFIX = "integration:";

/**
 * Every vault entry name: a provider connection id, or `integration:` followed by an id under the same rule. At most 76
 * characters, inside the secret broker's 100 (`docs/design/secret-broker.md` 3.1). No other `:` and no other prefix.
 */
export const NAME_RE = /^(?:integration:)?[a-z0-9][a-z0-9._-]{0,63}$/;

/** What an entry holds: a provider credential or an integration credential. Each purpose reveals one kind only. */
export type EntryKind = "provider" | "integration";

/** The kind of a name that already passed `NAME_RE`. */
export function entryKind(name: string): EntryKind {
  return name.startsWith(INTEGRATION_PREFIX) ? "integration" : "provider";
}
