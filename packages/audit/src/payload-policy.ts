// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { canonicalize, type JsonValue } from "./canonical.js";
import { summarizeContent } from "./redact.js";

/** A stored payload never exceeds this many canonical-JSON characters. */
export const MAX_PAYLOAD_CHARS = 8192;
const MAX_FIELD_CHARS = 256;

const POLICY_KEYS = ["tier", "sideEffect", "connectionId", "decision", "reason", "replay", "phase", "code"] as const;

/**
 * Keys each action may store (ADR 0003 D5: payloads are not logged by default;
 * `targetSummary`-style facts only). Values must be scalars. Everything else
 * is replaced by a count (`_omitted`) and anything non-scalar under an allowed
 * key by its length and SHA-256. An action with no entry stores only a
 * content summary. Phase 1b adds its own entries.
 */
export const DEFAULT_PAYLOAD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  "worktree.create": ["workspaceId", "projectId", "branch", "baseRef", "baseSha"],
  "worktree.remove": ["workspaceId", "deleteBranch", "backupRef", "dirty"],
  "git.commit": ["workspaceId", "fileCount", "sha"],
  "git.push": ["workspaceId", "remote", "branch", "ok"],
  "git.discard": ["workspaceId", "fileCount", "backupRef"],
  "tier4.challenge": ["phase", "op", "ref", "tier", "reason", "decision", "awaitingNative", "state"],
  "tier4.execute": ["phase", "op", "ref", "tier", "reason", "approvedBy", "errorName", "code", ...POLICY_KEYS],
  "policy.decision": [...POLICY_KEYS],
  "rpc.execute": [...POLICY_KEYS],
  "journal.recovery": ["from", "to", "reason", "kind", "workspaceId", "projectId", "count"],
};

const isScalar = (v: JsonValue): v is string | number | boolean | null =>
  v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/**
 * `[content]` is a length plus an UNSALTED SHA-256 of the redacted payload. A
 * salt would not help here: it would have to live in the database (and then
 * travels with any copy of it) or in a key store the daemon owns, and anyone
 * who can read the file as the same user already reads everything the hash
 * stands for no better than before. What the hash protects is the log's
 * plaintext (nothing readable is stored), not the guessability of a
 * low-entropy value that no rule caught. If a later phase stores summaries
 * for such values, hash with an HMAC under a daemon-held key instead.
 */
function summary(value: JsonValue): JsonValue {
  return { "[content]": summarizeContent(canonicalize(value)) };
}

/**
 * Reduce an already-redacted payload to what the action's allowlist permits.
 * Deterministic, so the stored form (and its hash) is stable.
 */
export function applyPayloadPolicy(
  action: string,
  payload: JsonValue,
  allowlist: Readonly<Record<string, readonly string[]>>,
  /** Applied to every string that is stored, so no free-text field is ever kept verbatim whatever the caller did before. */
  redactString: (s: string) => string,
): JsonValue {
  if (payload === null) return null;
  const allowed = Object.hasOwn(allowlist, action) ? allowlist[action] : undefined;
  if (!allowed || typeof payload !== "object" || Array.isArray(payload)) return summary(payload);
  const input = payload as Record<string, JsonValue>;
  const out: Record<string, JsonValue> = {};
  let omitted = 0;
  for (const key of Object.keys(input).sort()) {
    const value = input[key] as JsonValue;
    if (!allowed.includes(key)) {
      omitted++;
    } else if (isScalar(value)) {
      const text = typeof value === "string" ? redactString(value) : value;
      out[key] = typeof text === "string" && text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)}[TRUNCATED:${text.length}]` : text;
    } else {
      out[key] = summary(value);
    }
  }
  if (omitted > 0) out["_omitted"] = omitted;
  return canonicalize(out).length > MAX_PAYLOAD_CHARS ? summary(out) : out;
}
