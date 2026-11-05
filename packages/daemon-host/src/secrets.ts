// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Redactor } from "@axis/audit";

/**
 * Register the host's own secrets with the process `Redactor` (design section 3, step 5 is the vault's; this covers
 * the gap between the `init` message and that step). `Redactor.registerSecret` already adds the URL-encoded, base64,
 * hex and JSON-escaped forms of the text it is given, so the key is registered as its base64url text (the form on
 * the control channel) and as the standard base64 and hex of its bytes (padded or not, either case).
 */
export function registerHostSecrets(redactor: Redactor, attestationKey: Uint8Array): void {
  const bytes = Buffer.from(attestationKey);
  const std = bytes.toString("base64");
  const hex = bytes.toString("hex");
  const forms = new Set([bytes.toString("base64url"), std, std.replace(/=+$/, ""), hex, hex.toUpperCase()]);
  for (const form of forms) {
    redactor.registerSecret(form);
  }
}
