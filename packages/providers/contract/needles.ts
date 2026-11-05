// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/** Every 12-character window of the credential, so a partial echo is caught too (NS5). */
export const CREDENTIAL_WINDOW = 12;

/** Shortest test credential: shorter ones would get no 12-character windows (R4). */
export const MIN_CREDENTIAL_LENGTH = 16;
export const MIN_CANARY_LENGTH = 8;

/**
 * What the leak checks look for: the canary, the credential, every
 * 12-character window of it, and its common transformed forms, so an echo
 * through an `Authorization: Basic` header, a URL or a case change is caught
 * too (R3).
 */
export function needlesFor(canary: string, credential: string): string[] {
  const out = new Set<string>([canary, credential]);
  for (let i = 0; i + CREDENTIAL_WINDOW <= credential.length; i++) out.add(credential.slice(i, i + CREDENTIAL_WINDOW));
  const bytes = Buffer.from(credential, "utf8");
  out.add(bytes.toString("base64"));
  out.add(bytes.toString("base64").replace(/=+$/, ""));
  out.add(bytes.toString("base64url"));
  out.add(encodeURIComponent(credential));
  out.add(credential.toUpperCase());
  out.add(credential.toLowerCase());
  return [...out].filter((n) => n.length > 0);
}
