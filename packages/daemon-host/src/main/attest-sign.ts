// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * Main's attestation signer (ticket X1b, `docs/design/main-answers.md` section 2). It runs in Electron main, so it imports no
 * `@axis/*` package and no Node module (the MAC function is injected): the canonical text of daemon-host section 6.1 is rebuilt
 * here for the one shape main signs, a flat identity of strings and booleans. `test/main-sign.test.ts` signs random identities
 * here and with the daemon's own `signAttestation` and requires byte-equal text and a pass of the daemon's verifier, so the two
 * cannot drift.
 */

export const MAIN_ATTESTATION_TAG = "axis.attest/1";

/** The identity main vouches for (the daemon's `identitySchema` judges it again). */
export interface MainIdentity {
  readonly connectionId: string;
  readonly windowId: string;
  readonly actorId: string;
  readonly actor: "user";
  readonly workspaceId?: string;
  readonly trusted: boolean;
  readonly clientKind: "desktop";
}

export interface MainAttestation {
  readonly identity: Readonly<Record<string, string | boolean>>;
  readonly issuedAt: number;
  readonly mac: string;
}

/** HMAC-SHA256 of the UTF-8 text under the key (the seam passes `crypto.createHmac`). Must return 32 bytes. */
export type HmacSha256 = (key: Uint8Array, text: string) => Uint8Array;

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding (no Buffer: this file runs in main without Node imports). */
export function base64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64URL[a >> 2];
    out += B64URL[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += B64URL[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += B64URL[c & 63];
  }
  return out;
}

/** The plain copy of the identity, with only the fields main may set and no `undefined` (it would not survive the wire). */
function plainIdentity(identity: MainIdentity): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {
    connectionId: identity.connectionId,
    windowId: identity.windowId,
    actorId: identity.actorId,
    actor: identity.actor,
    trusted: identity.trusted,
    clientKind: identity.clientKind,
  };
  if (identity.workspaceId !== undefined) out["workspaceId"] = identity.workspaceId;
  for (const v of Object.values(out)) if (typeof v !== "string" && typeof v !== "boolean") throw new Error("unsignable identity");
  return out;
}

/** `canonicalJson(["axis.attest/1", identity, issuedAt])` for a flat identity: keys sorted by UTF-16 code unit, no whitespace. */
export function attestationText(identity: Readonly<Record<string, string | boolean>>, issuedAt: number): string {
  const body = Object.keys(identity)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(identity[k])}`)
    .join(",");
  return `[${JSON.stringify(MAIN_ATTESTATION_TAG)},{${body}},${JSON.stringify(issuedAt)}]`;
}

/** Sign. Throws (fixed text, no value) on an unsafe time, a short key or a MAC that is not 32 bytes. */
export function signMainAttestation(hmac: HmacSha256, key: Uint8Array, identity: MainIdentity, issuedAt: number): MainAttestation {
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("unsignable time");
  if (key.length < 32) throw new Error("short key");
  const plain = plainIdentity(identity);
  const mac = hmac(key, attestationText(plain, issuedAt));
  if (mac.length !== 32) throw new Error("bad mac length");
  return { identity: plain, issuedAt, mac: base64url(mac) };
}
