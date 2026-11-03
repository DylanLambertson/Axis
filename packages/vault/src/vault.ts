// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ConsentVerifier, WeakStorageConsent } from "./consent.js";
import { VaultError } from "./errors.js";
import { NAME_RE } from "./names.js";
import {
  BACKEND_IDS,
  PROTECTIONS,
  SECRET_PURPOSES,
  type AccessEvent,
  type BackendId,
  type BackendInfo,
  type BackendReport,
  type ChangeEvent,
  type ConnectionInfo,
  type EntryMeta,
  type Protection,
  type SecretBackend,
  type SecretPurpose,
  type StoragePolicy,
} from "./types.js";

const SECRET_RE = /^[\x21-\x7e]{8,4096}$/;
const LABEL_RE = /^[\x20-\x7e]{1,64}$/;
/** Secrets no longer stored are forgotten oldest first beyond this many. A stored secret is never forgotten. */
const MAX_KNOWN_SECRETS = 1_024;

const BACKEND_SET: ReadonlySet<string> = new Set(BACKEND_IDS);
const PROTECTION_SET: ReadonlySet<string> = new Set(PROTECTIONS);
const PURPOSE_SET: ReadonlySet<string> = new Set(SECRET_PURPOSES);
/** Backends that never protect, whatever they claim. */
const ALWAYS_WEAK: ReadonlySet<string> = new Set(["basic_text", "unknown"]);

export interface VaultOptions {
  readonly backend: SecretBackend;
  /**
   * What to do on a backend with no protection: ask for consent (default) or
   * refuse outright.
   */
  readonly weakPolicy?: "consent" | "refuse";
  /**
   * Checks and spends a `WeakStorageConsent` (from `createConsentAuthority`).
   * Without one no consent is ever accepted, so a weak backend always fails
   * with `consent_required`.
   */
  readonly consent?: ConsentVerifier;
  /** Audit hook for every `reveal`, without the secret (DMN-5). Failures are ignored. */
  readonly onAccess?: (event: AccessEvent) => void;
  /** Audit hook for every store and removal, without the secret (DMN-5). Failures are ignored. */
  readonly onChange?: (event: ChangeEvent) => void;
  readonly now?: () => number;
}

export interface StoreOptions {
  readonly label?: string;
  /** Required on a backend with no protection: the user's consent for this connection and this backend. */
  readonly consent?: WeakStorageConsent;
}

/**
 * The connection vault: one secret per connection id, in a backend that is
 * checked on every store (PRV-1). It runs in the daemon only (PRV-2).
 */
export interface ConnectionVault {
  /** The current backend and whether a store would be allowed now. For the UI. */
  backend(): Promise<BackendReport>;
  store(connectionId: string, secret: string, options?: StoreOptions): Promise<ConnectionInfo>;
  /** The plaintext, for the daemon's provider call only. Never forward it. */
  reveal(connectionId: string, purpose: SecretPurpose): Promise<string>;
  /** Everything but the secret. */
  info(connectionId: string): Promise<ConnectionInfo | undefined>;
  list(): Promise<readonly ConnectionInfo[]>;
  remove(connectionId: string): Promise<boolean>;
  /**
   * Every secret stored or revealed in this process, rotated and removed ones
   * included (up to a bound; a secret that is still stored is never dropped),
   * so a late echo of an old key is still redacted. For the guard's redactor
   * only: the same trust boundary as `reveal`. After a restart it holds only
   * what `reveal` has returned since.
   */
  knownSecrets(): readonly string[];
}

/**
 * What a backend reports about itself, treated as untrusted. Unknown ids and
 * claims fail closed; `ephemeral` is accepted from the memory backend only, and
 * `basic_text` and `unknown` never count as protected.
 */
function normalizeInfo(raw: unknown): BackendInfo {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const id: BackendId = typeof o["id"] === "string" && BACKEND_SET.has(o["id"]) ? (o["id"] as BackendId) : "unknown";
  return { id, protection: normalizeProtection(id, o["protection"]), label: typeof o["label"] === "string" && LABEL_RE.test(o["label"]) ? o["label"] : id };
}

function normalizeProtection(id: BackendId, claimed: unknown): Protection {
  if (ALWAYS_WEAK.has(id)) return "none";
  if (id === "memory") return "ephemeral";
  if (typeof claimed !== "string" || !PROTECTION_SET.has(claimed)) return "none";
  return claimed === "ephemeral" ? "none" : (claimed as Protection);
}

function policyOf(info: BackendInfo, weak: "consent" | "refuse"): StoragePolicy {
  if (info.protection !== "none") return "allowed";
  return weak === "refuse" ? "refused" : "consent_required";
}

async function backendCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw new VaultError("backend_failed");
  }
}

/** Entry metadata from a backend, validated field by field. Anything off is a fixed backend failure. */
function readMeta(raw: unknown): EntryMeta {
  try {
    if (typeof raw !== "object" || raw === null) throw new Error();
    const o = raw as Record<string, unknown>;
    const backend = o["backend"];
    const protection = o["protection"];
    const storedAt = o["storedAt"];
    const weakConsent = o["weakConsent"];
    const label = o["label"];
    if (typeof backend !== "string" || !BACKEND_SET.has(backend)) throw new Error();
    if (typeof protection !== "string" || !PROTECTION_SET.has(protection)) throw new Error();
    if (typeof storedAt !== "number" || !Number.isFinite(storedAt) || storedAt < 0) throw new Error();
    if (typeof weakConsent !== "boolean") throw new Error();
    if (label !== undefined && (typeof label !== "string" || !LABEL_RE.test(label))) throw new Error();
    return {
      ...(label === undefined ? {} : { label }),
      storedAt,
      backend: backend as BackendId,
      protection: normalizeProtection(backend as BackendId, protection),
      weakConsent,
    };
  } catch {
    throw new VaultError("backend_failed");
  }
}

export function createVault(options: VaultOptions): ConnectionVault {
  // Captured once: whoever holds the options object later cannot swap them (N-E).
  const backend = options.backend;
  const consentVerifier = options.consent;
  const weak = options.weakPolicy ?? "consent";
  const now = options.now ?? ((): number => Date.now());
  const known = new Set<string>();
  /** The secret currently stored (or last revealed) for each connection: these are never forgotten. */
  const live = new Map<string, string>();
  /** Connections whose write landed somewhere weaker and could not be removed: shown as weak, never revealed (SF-2). */
  const quarantine = new Map<string, BackendInfo>();

  const remember = (secret: string): void => {
    known.add(secret);
    if (known.size <= MAX_KNOWN_SECRETS) return;
    const keep = new Set(live.values());
    for (const s of known) {
      if (!keep.has(s)) {
        known.delete(s);
        break;
      }
    }
  };

  const notify = <E>(hook: ((e: E) => void) | undefined, event: E): void => {
    try {
      hook?.(event);
    } catch {
      // An audit sink failure must not change the outcome.
    }
  };

  const currentInfo = async (): Promise<BackendInfo> => normalizeInfo(await backendCall(() => backend.info()));

  const checkName = (id: unknown): string => {
    if (typeof id !== "string" || !NAME_RE.test(id)) throw new VaultError("invalid_name");
    return id;
  };

  /** What the UI shows: protection is what the backend reported at store time, not a guess from its name. */
  const describe = (connectionId: string, meta: EntryMeta, current: BackendInfo): ConnectionInfo => {
    const q = quarantine.get(connectionId);
    return {
      connectionId,
      ...(meta.label === undefined ? {} : { label: meta.label }),
      storedAt: meta.storedAt,
      backend: q?.id ?? meta.backend,
      protection: q?.protection ?? meta.protection,
      weakConsent: q === undefined ? meta.weakConsent : false,
      // A different backend, or the same one now reporting a different protection (a locked keyring), both count (N-F).
      backendChanged: q !== undefined || current.id !== meta.backend || current.protection !== meta.protection,
    };
  };

  /** Remove a stray copy, retrying once. */
  const removeCopy = async (name: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await backend.remove(name);
        return true;
      } catch {
        // Try once more, then give up.
      }
    }
    return false;
  };

  const vault: ConnectionVault = {
    async backend() {
      const info = await currentInfo();
      return { ...info, policy: policyOf(info, weak), persistent: info.protection !== "ephemeral" };
    },

    async store(connectionId, secret, opts = {}) {
      const name = checkName(connectionId);
      if (typeof secret !== "string" || !SECRET_RE.test(secret)) throw new VaultError("invalid_secret");
      if (opts.label !== undefined && (typeof opts.label !== "string" || !LABEL_RE.test(opts.label))) throw new VaultError("invalid_secret");

      let info: BackendInfo;
      try {
        // PRV-1: the backend is asked on every store, never cached.
        info = await currentInfo();
      } catch (e) {
        notify(options.onChange, { action: "store", connectionId: name, outcome: "error" } satisfies ChangeEvent);
        throw e;
      }
      const event = (outcome: ChangeEvent["outcome"], weakConsent = false): ChangeEvent => ({ action: "store", connectionId: name, outcome, backend: info.id, protection: info.protection, weakConsent });
      const policy = policyOf(info, weak);
      let weakConsent = false;
      if (policy === "refused") {
        notify(options.onChange, event("refused"));
        throw new VaultError("backend_refused");
      }
      if (policy === "consent_required") {
        // Checked and spent in one synchronous step, bound to this connection and this backend (S2, S3).
        if (opts.consent === undefined || consentVerifier?.redeem(opts.consent, { connectionId: name, backend: info.id }) !== true) {
          notify(options.onChange, event("refused"));
          throw new VaultError("consent_required");
        }
        weakConsent = true;
      }

      // Known before the write, so a failure that echoes it is still redacted.
      remember(secret);
      const meta: EntryMeta = {
        ...(opts.label === undefined ? {} : { label: opts.label }),
        storedAt: now(),
        backend: info.id,
        protection: info.protection,
        weakConsent,
      };
      let wrote: BackendInfo | undefined;
      try {
        const raw = await backend.put(name, secret, meta);
        // A backend that does not say where it wrote is treated as having written somewhere else (N-C).
        if (typeof raw === "object" && raw !== null) {
          wrote = normalizeInfo({ id: (raw as { id?: unknown }).id, protection: (raw as { protection?: unknown }).protection });
        }
      } catch {
        notify(options.onChange, event("error", weakConsent));
        throw new VaultError("backend_failed");
      }
      if (wrote === undefined || wrote.id !== info.id || wrote.protection !== info.protection) {
        // The write landed somewhere other than the backend the decision was made on (S4): do not keep it.
        live.delete(name);
        if (await removeCopy(name)) {
          notify(options.onChange, event("error", weakConsent));
        } else {
          // The weak copy is still there. Show it as weak and refuse to reveal it until it is stored again or removed (SF-2).
          quarantine.set(name, wrote ?? { id: "unknown", protection: "none", label: "unknown" });
          notify(options.onChange, event("rollback_failed", weakConsent));
        }
        throw new VaultError("backend_changed");
      }
      quarantine.delete(name);
      live.set(name, secret);
      notify(options.onChange, event("ok", weakConsent));
      return describe(name, meta, info);
    },

    async reveal(connectionId, purpose) {
      const name = checkName(connectionId);
      if (typeof purpose !== "string" || !PURPOSE_SET.has(purpose)) throw new VaultError("invalid_secret");
      const audit = (outcome: AccessEvent["outcome"]): void => notify(options.onAccess, { connectionId: name, purpose, outcome });
      if (quarantine.has(name)) {
        audit("error");
        throw new VaultError("backend_changed");
      }
      let entry: Awaited<ReturnType<SecretBackend["get"]>>;
      try {
        entry = await backend.get(name);
      } catch {
        audit("error");
        throw new VaultError("backend_failed");
      }
      if (entry === undefined) {
        audit("not_found");
        throw new VaultError("not_found");
      }
      const secret = (() => {
        try {
          return entry.secret;
        } catch {
          return undefined;
        }
      })();
      if (typeof secret !== "string" || secret.length === 0) {
        audit("error");
        throw new VaultError("backend_failed");
      }
      live.set(name, secret);
      remember(secret);
      audit("ok");
      return secret;
    },

    async info(connectionId) {
      const name = checkName(connectionId);
      const raw = await backendCall(() => backend.meta(name));
      if (raw === undefined) return undefined;
      const meta = readMeta(raw);
      return describe(name, meta, await currentInfo());
    },

    async list() {
      const current = await currentInfo();
      const entries = await backendCall(() => backend.list());
      try {
        if (!Array.isArray(entries)) throw new Error();
        return entries.map((e) => {
          const n = (e as { name?: unknown }).name;
          if (typeof n !== "string" || !NAME_RE.test(n)) throw new Error();
          return describe(n, readMeta((e as { meta?: unknown }).meta), current);
        });
      } catch {
        throw new VaultError("backend_failed");
      }
    },

    async remove(connectionId) {
      const name = checkName(connectionId);
      let removed: boolean;
      try {
        removed = await backend.remove(name);
      } catch {
        notify(options.onChange, { action: "remove", connectionId: name, outcome: "error" } satisfies ChangeEvent);
        throw new VaultError("backend_failed");
      }
      live.delete(name);
      quarantine.delete(name);
      notify(options.onChange, { action: "remove", connectionId: name, outcome: "ok" } satisfies ChangeEvent);
      return removed;
    },

    knownSecrets() {
      return [...known];
    },
  };
  return Object.freeze(vault);
}
