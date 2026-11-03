// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { VaultError } from "./errors.js";
import {
  BACKEND_IDS,
  PROTECTIONS,
  SECRET_PURPOSES,
  type AccessEvent,
  type BackendId,
  type BackendInfo,
  type BackendReport,
  type ConnectionInfo,
  type EntryMeta,
  type SecretBackend,
  type SecretPurpose,
  type StoragePolicy,
} from "./types.js";

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SECRET_RE = /^[\x21-\x7e]{8,4096}$/;
const LABEL_RE = /^[\x20-\x7e]{1,64}$/;
/** More distinct secrets than this in one process is not a normal use; the oldest are forgotten. */
const MAX_KNOWN_SECRETS = 1_024;

const BACKEND_SET: ReadonlySet<string> = new Set(BACKEND_IDS);
const PROTECTION_SET: ReadonlySet<string> = new Set(PROTECTIONS);
const PURPOSE_SET: ReadonlySet<string> = new Set(SECRET_PURPOSES);
/** Backends that never protect, whatever they claim. */
const ALWAYS_WEAK: ReadonlySet<BackendId> = new Set<BackendId>(["basic_text", "unknown"]);

/**
 * The user's consent to store a credential on a backend that gives no
 * protection (PRV-1). Only the approvals path creates one, after the user
 * resolves a native confirmation that names the backend (DMN-3: an agent
 * cannot resolve it). It names one backend and is spent by one `store`.
 */
export interface WeakStorageConsent {
  readonly backend: BackendId;
  readonly grantedAt: number;
}

const issued = new WeakSet<object>();

export function createWeakStorageConsent(backend: BackendId, grantedAt: number): WeakStorageConsent {
  const consent: WeakStorageConsent = Object.freeze({ backend, grantedAt });
  issued.add(consent);
  return consent;
}

export interface VaultOptions {
  readonly backend: SecretBackend;
  /**
   * What to do on a backend with no protection: ask for consent (default) or
   * refuse outright.
   */
  readonly weakPolicy?: "consent" | "refuse";
  /** Audit hook for every `reveal`, without the secret (DMN-5). Failures are ignored. */
  readonly onAccess?: (event: AccessEvent) => void;
  readonly now?: () => number;
}

export interface StoreOptions {
  readonly label?: string;
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
   * included, so a late echo of an old key is still redacted. For the
   * guard's redactor only: the same trust boundary as `reveal`.
   */
  knownSecrets(): readonly string[];
}

/** Treat a backend's answer as untrusted: unknown ids and claims fail closed. */
function normalizeInfo(raw: unknown): BackendInfo {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const id: BackendId = typeof o["id"] === "string" && BACKEND_SET.has(o["id"]) ? (o["id"] as BackendId) : "unknown";
  let protection = typeof o["protection"] === "string" && PROTECTION_SET.has(o["protection"]) ? (o["protection"] as BackendInfo["protection"]) : "none";
  if (ALWAYS_WEAK.has(id)) protection = "none";
  const label = typeof o["label"] === "string" && LABEL_RE.test(o["label"]) ? o["label"] : id;
  return { id, protection, label };
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

export function createVault(options: VaultOptions): ConnectionVault {
  const backend = options.backend;
  const weak = options.weakPolicy ?? "consent";
  const now = options.now ?? ((): number => Date.now());
  const spent = new WeakSet<object>();
  const known: string[] = [];

  const remember = (secret: string): void => {
    if (known.includes(secret)) return;
    known.push(secret);
    if (known.length > MAX_KNOWN_SECRETS) known.shift();
  };

  const currentInfo = async (): Promise<BackendInfo> => normalizeInfo(await backendCall(() => backend.info()));

  const checkName = (id: unknown): string => {
    if (typeof id !== "string" || !NAME_RE.test(id)) throw new VaultError("invalid_name");
    return id;
  };

  const describe = (connectionId: string, meta: EntryMeta, current: BackendInfo): ConnectionInfo => {
    const info: { -readonly [K in keyof ConnectionInfo]: ConnectionInfo[K] } = {
      connectionId,
      storedAt: meta.storedAt,
      backend: meta.backend,
      protection: ALWAYS_WEAK.has(meta.backend) ? "none" : meta.backend === "memory" ? "ephemeral" : "os_protected",
      weakConsent: meta.weakConsent,
      backendChanged: current.id !== meta.backend,
    };
    if (meta.label !== undefined) info.label = meta.label;
    return info;
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

      // PRV-1: the backend is asked on every store, never cached.
      const info = await currentInfo();
      const policy = policyOf(info, weak);
      let weakConsent = false;
      let consent: object | undefined;
      if (policy === "refused") throw new VaultError("backend_refused");
      if (policy === "consent_required") {
        const c = opts.consent;
        if (c === undefined || !issued.has(c) || spent.has(c) || c.backend !== info.id) throw new VaultError("consent_required");
        consent = c;
        weakConsent = true;
      }

      // Known before the write, so a failure that echoes it is still redacted.
      remember(secret);
      const meta: EntryMeta = {
        ...(opts.label === undefined ? {} : { label: opts.label }),
        storedAt: now(),
        backend: info.id,
        weakConsent,
      };
      await backendCall(() => backend.put(name, secret, meta));
      if (consent !== undefined) spent.add(consent);
      return describe(name, meta, info);
    },

    async reveal(connectionId, purpose) {
      const name = checkName(connectionId);
      if (typeof purpose !== "string" || !PURPOSE_SET.has(purpose)) throw new VaultError("invalid_secret");
      const audit = (outcome: AccessEvent["outcome"]): void => {
        try {
          options.onAccess?.({ connectionId: name, purpose, outcome });
        } catch {
          // An audit sink failure must not change the outcome.
        }
      };
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
      if (typeof entry.secret !== "string" || entry.secret.length === 0) {
        audit("error");
        throw new VaultError("backend_failed");
      }
      remember(entry.secret);
      audit("ok");
      return entry.secret;
    },

    async info(connectionId) {
      const name = checkName(connectionId);
      const meta = await backendCall(() => backend.meta(name));
      if (meta === undefined) return undefined;
      return describe(name, meta, await currentInfo());
    },

    async list() {
      const current = await currentInfo();
      const entries = await backendCall(() => backend.list());
      return entries.map((e) => describe(e.name, e.meta, current));
    },

    async remove(connectionId) {
      return backendCall(() => backend.remove(checkName(connectionId)));
    },

    knownSecrets() {
      return [...known];
    },
  };
  return Object.freeze(vault);
}
