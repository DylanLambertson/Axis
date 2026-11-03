// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * Where a secret lives. `basic_text` is Electron's Linux fallback with a
 * hardcoded key; `unknown` is anything the platform did not name; `memory` is
 * the test backend.
 */
export const BACKEND_IDS = [
  "macos_keychain",
  "windows_dpapi",
  "gnome_libsecret",
  "kwallet",
  "basic_text",
  "unknown",
  "memory",
] as const;
export type BackendId = (typeof BACKEND_IDS)[number];

/** `os_protected`: the OS guards the key. `none`: no real protection. `ephemeral`: never persisted. */
export const PROTECTIONS = ["os_protected", "none", "ephemeral"] as const;
export type Protection = (typeof PROTECTIONS)[number];

export interface BackendInfo {
  readonly id: BackendId;
  readonly protection: Protection;
  /** Short text for the UI, for example "macOS Keychain". */
  readonly label: string;
}

/** Non-secret facts stored beside a secret. */
export interface EntryMeta {
  readonly label?: string;
  readonly storedAt: number;
  readonly backend: BackendId;
  readonly weakConsent: boolean;
}

/**
 * The seam for the real OS-backed storage (Electron `safeStorage` through the
 * main-process secret broker, ADR 0003 D1.6). One implementation per platform,
 * added with the daemon wiring; none ships in this package. Implementations
 * throw anything on failure: the vault replaces it with a fixed error.
 */
export interface SecretBackend {
  /** Asked on every store (PRV-1): the backend can change between calls. */
  info(): Promise<BackendInfo>;
  put(name: string, secret: string, meta: EntryMeta): Promise<void>;
  get(name: string): Promise<{ readonly secret: string; readonly meta: EntryMeta } | undefined>;
  /** Metadata without decrypting. */
  meta(name: string): Promise<EntryMeta | undefined>;
  remove(name: string): Promise<boolean>;
  list(): Promise<ReadonlyArray<{ readonly name: string; readonly meta: EntryMeta }>>;
}

export type StoragePolicy = "allowed" | "consent_required" | "refused";

/** What the UI shows about the current backend. */
export interface BackendReport extends BackendInfo {
  readonly policy: StoragePolicy;
  /** False for the in-memory backend. */
  readonly persistent: boolean;
}

/** What the UI shows about one stored connection credential. Never the secret. */
export interface ConnectionInfo {
  readonly connectionId: string;
  readonly label?: string;
  readonly storedAt: number;
  readonly backend: BackendId;
  readonly protection: Protection;
  /** Stored on a weak backend with the user's consent. */
  readonly weakConsent: boolean;
  /** The current backend differs from the one the secret was stored under. */
  readonly backendChanged: boolean;
}

/** Why the daemon asks for a secret. A closed set so every access is auditable. */
export const SECRET_PURPOSES = ["provider_request", "validate_connection"] as const;
export type SecretPurpose = (typeof SECRET_PURPOSES)[number];

export interface AccessEvent {
  readonly connectionId: string;
  readonly purpose: SecretPurpose;
  readonly outcome: "ok" | "not_found" | "error";
}
