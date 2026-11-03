// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { makeError, type AxisError, type ErrorCode } from "@axis/protocol";

/** The closed set of vault failures. */
export const VAULT_ERROR_CODES = [
  "consent_required",
  "backend_refused",
  "backend_failed",
  "not_found",
  "invalid_name",
  "invalid_secret",
] as const;
export type VaultErrorCode = (typeof VAULT_ERROR_CODES)[number];

interface CodeInfo {
  readonly axis: ErrorCode;
  /** Fixed, user-safe text. Never built from a secret or from a backend's own error text. */
  readonly text: string;
}

const CODE_INFO: Readonly<Record<VaultErrorCode, CodeInfo>> = {
  consent_required: { axis: "E_POLICY_DENIED", text: "This storage backend gives no protection; storing the credential needs explicit consent." },
  backend_refused: { axis: "E_POLICY_DENIED", text: "This storage backend gives no protection and is refused." },
  backend_failed: { axis: "E_UNAVAILABLE", text: "The credential storage backend failed." },
  not_found: { axis: "E_NOT_FOUND", text: "No credential is stored for this connection." },
  invalid_name: { axis: "E_INVALID_ARGUMENT", text: "The connection id is invalid." },
  invalid_secret: { axis: "E_INVALID_ARGUMENT", text: "The credential or its label is invalid." },
};

/** The one error type the vault throws: fixed text, a code, nothing else. No `cause`. */
export class VaultError extends Error {
  override readonly name = "VaultError";
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode) {
    super(CODE_INFO[code].text);
    this.code = code;
    Object.freeze(this);
  }
}

export function toAxisVaultError(e: VaultError, correlationId: string): AxisError {
  return makeError(CODE_INFO[e.code].axis, e.message, correlationId, { vaultCode: e.code });
}
