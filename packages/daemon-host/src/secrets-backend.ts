// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import type { CREDENTIAL_BACKENDS, CREDENTIAL_PROTECTIONS } from "@axis/protocol";
import type { RequestOptions, SecretsAnswer, SecretsAsk } from "./control/client.js";
import { SECRET_NAME_RE, type SecretMeta, type SecretsValue } from "./control/secrets-messages.js";

/**
 * The vault's `SecretBackend` over main's secret broker (PV-N0c-1, `docs/design/secret-broker.md` §3.4 and §3.5). It is typed
 * structurally: only the two bindings may import `@axis/vault`, so the providers binding is where this object is checked
 * against the vault's interface. Every answer was parsed by the control client's strict schemas; failures are one fixed
 * `AxisError` (`E_UNAVAILABLE`, "The secret broker did not complete the request") with a closed `reason`, never main's text,
 * a name or a value. The vault replaces any throw with its own `backend_failed` anyway.
 *
 * - Ordering: the daemon's own requests for ONE name leave in the order they were made, each after the previous one settled,
 *   so a rollback `remove` never overtakes the `put` it undoes. Other names are not held up.
 * - A `put` that main answered `failed`, or that timed out, or whose answer was refused, is UNKNOWN: main's late operation may
 *   still write the record. The backend reconciles with ONE `get` for that name, which main orders behind the late `put`.
 *   The same secret with the same `storedAt`, `label` and consent is this put: it is reported where the record says it landed
 *   (the vault then checks that against the backend its decision was made on). Anything else is reported failed and nothing
 *   is removed, so a rotation keeps the previous secret. When the `get` cannot tell either, the put stays unknown: reported
 *   failed, with the closed event `secrets.put_unknown`. Never retried. A `refused` put, or one the daemon never sent, is
 *   certain and not reconciled.
 * - `list` is tolerant (§3.5): a name the vault's rule refuses is dropped, with one closed event each, before the vault sees
 *   the list (the vault's `list` throws on any bad name). Malformed metadata, an over-long name or more than 256 entries
 *   still fail the whole list (the control schema).
 */

type BackendId = (typeof CREDENTIAL_BACKENDS)[number];
type Protection = (typeof CREDENTIAL_PROTECTIONS)[number];

/** The vault's `BackendInfo`, `WrittenTo` and entry shapes, restated. */
export interface BrokerBackendInfo {
  readonly id: BackendId;
  readonly protection: Protection;
  readonly label: string;
}
export interface BrokerWrittenTo {
  readonly id: BackendId;
  readonly protection: Protection;
}

export interface BrokerSecretBackend {
  info(): Promise<BrokerBackendInfo>;
  put(name: string, secret: string, meta: SecretMeta): Promise<BrokerWrittenTo>;
  get(name: string): Promise<{ readonly secret: string; readonly meta: SecretMeta } | undefined>;
  meta(name: string): Promise<SecretMeta | undefined>;
  remove(name: string): Promise<boolean>;
  list(): Promise<ReadonlyArray<{ readonly name: string; readonly meta: SecretMeta }>>;
}

/** The closed events (no name, no value). */
export type BrokerEvent = { readonly event: "secrets.put_landed_late" | "secrets.put_absent" | "secrets.put_unknown" | "secrets.list_name_dropped" };

export interface SecretsPort {
  secrets(ask: SecretsAsk, options?: RequestOptions): Promise<SecretsAnswer>;
}

export interface BrokerSecretBackendOptions {
  readonly client: SecretsPort;
  readonly onEvent?: (event: BrokerEvent) => void;
  /** Tests only: shorter daemon-side timeouts than the control client's defaults. */
  readonly timeoutsMs?: { readonly slow: number; readonly fast: number };
}

/** Fixed UI text per backend id (the vault keeps a label only when it is plain ASCII). */
const LABELS: Readonly<Record<BackendId, string>> = Object.freeze({
  macos_keychain: "macOS Keychain",
  windows_dpapi: "Windows DPAPI",
  gnome_libsecret: "GNOME libsecret",
  kwallet: "KWallet",
  kwallet5: "KWallet 5",
  kwallet6: "KWallet 6",
  basic_text: "Basic text",
  unknown: "Unknown",
  memory: "Memory",
});

type Reason = "refused" | "corrupt" | "failed" | "unknown" | "invalid_answer" | "timeout" | "closed" | "busy" | "cancelled";

const fail = (reason: Reason): AxisError => new AxisError("E_UNAVAILABLE", "The secret broker did not complete the request", { reason });

/** A client rejection, as a closed reason. Only a request that certainly never reached main is `certain`. */
function rejectionOf(e: unknown): { reason: Reason; certain: boolean } {
  const code = e instanceof AxisError ? e.code : undefined;
  const why = e instanceof AxisError ? e.detail["reason"] : undefined;
  if (code === "E_TIMEOUT") return { reason: "timeout", certain: false };
  if (code === "E_BACKPRESSURE") return { reason: "busy", certain: true };
  if (code === "E_CANCELLED") return { reason: "cancelled", certain: false };
  if (code === "E_UNAVAILABLE") return { reason: "closed", certain: why === "client_closed" };
  if (why === "answer_invalid") return { reason: "invalid_answer", certain: false };
  return { reason: "failed", certain: false };
}

export function createBrokerSecretBackend(options: BrokerSecretBackendOptions): BrokerSecretBackend {
  const { client } = options;
  const emit = (event: BrokerEvent["event"]): void => {
    try {
      options.onEvent?.({ event });
    } catch {
      // an observer never changes the outcome
    }
  };
  const timeoutFor = (ask: SecretsAsk): RequestOptions => {
    const t = options.timeoutsMs;
    if (t === undefined) return {};
    return { timeoutMs: ask.type === "secrets.get" || ask.type === "secrets.put" ? t.slow : t.fast };
  };

  /** One request; a client rejection becomes a fixed failure carrying whether main may have acted on it. */
  const ask = async (a: SecretsAsk): Promise<SecretsAnswer> => {
    try {
      return await client.secrets(a, timeoutFor(a));
    } catch (e) {
      const r = rejectionOf(e);
      throw Object.assign(fail(r.reason), { certain: r.certain });
    }
  };
  const valueOf = <O extends SecretsValue["op"]>(answer: SecretsAnswer, op: O): Extract<SecretsValue, { op: O }> | "not_found" => {
    if (answer.ok) {
      if (answer.value.op !== op) throw fail("invalid_answer");
      return answer.value as Extract<SecretsValue, { op: O }>;
    }
    if (answer.error === "not_found") return "not_found";
    throw fail(answer.error);
  };

  // One chain per name: each request for a name starts after the previous one settled (success or failure).
  const chains = new Map<string, Promise<unknown>>();
  const serial = <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const before = chains.get(name) ?? Promise.resolve();
    const mine = before.then(run); // `before` is a tail, which never rejects
    const tail = mine.then(
      () => undefined,
      () => undefined,
    );
    chains.set(name, tail);
    void tail.then(() => {
      if (chains.get(name) === tail) chains.delete(name);
    });
    return mine;
  };

  const getNow = async (name: string): Promise<{ secret: string; meta: SecretMeta } | undefined> => {
    const v = valueOf(await ask({ type: "secrets.get", name }), "get");
    return v === "not_found" ? undefined : { secret: v.secret, meta: v.meta };
  };

  /** The put's outcome is unknown: one `get`, ordered behind it by main, decides; never a retry. */
  const reconcile = async (name: string, secret: string, meta: SecretMeta): Promise<BrokerWrittenTo> => {
    let seen: { secret: string; meta: SecretMeta } | undefined;
    try {
      seen = await getNow(name);
    } catch {
      emit("secrets.put_unknown");
      throw fail("unknown");
    }
    if (seen === undefined || seen.secret !== secret || seen.meta.storedAt !== meta.storedAt || seen.meta.label !== meta.label || seen.meta.weakConsent !== meta.weakConsent) {
      emit("secrets.put_absent");
      throw fail("failed");
    }
    emit("secrets.put_landed_late");
    return { id: seen.meta.backend, protection: seen.meta.protection };
  };

  return {
    async info() {
      const v = valueOf(await ask({ type: "secrets.info" }), "info");
      if (v === "not_found") throw fail("invalid_answer");
      // An unavailable cipher protects nothing: the vault's weak policy then refuses every store.
      return { id: v.backend, protection: v.available ? v.protection : "none", label: LABELS[v.backend] };
    },
    put(name, secret, meta) {
      return serial(name, async () => {
        let answer: SecretsAnswer;
        try {
          answer = await ask({ type: "secrets.put", name, secret, meta });
        } catch (e) {
          if ((e as { certain?: boolean }).certain === true) throw e; // never reached main: nothing to reconcile
          return reconcile(name, secret, meta);
        }
        if (!answer.ok && answer.error === "failed") return reconcile(name, secret, meta);
        const v = valueOf(answer, "put");
        if (v === "not_found") throw fail("invalid_answer");
        return { id: v.landedOn.backend, protection: v.landedOn.protection };
      });
    },
    get(name) {
      return serial(name, () => getNow(name));
    },
    meta(name) {
      return serial(name, async () => {
        const v = valueOf(await ask({ type: "secrets.meta", name }), "meta");
        return v === "not_found" ? undefined : v.meta;
      });
    },
    remove(name) {
      return serial(name, async () => {
        const v = valueOf(await ask({ type: "secrets.remove", name }), "remove");
        return v === "not_found" ? false : v.removed;
      });
    },
    async list() {
      const v = valueOf(await ask({ type: "secrets.list" }), "list");
      if (v === "not_found") throw fail("invalid_answer");
      const kept: Array<{ name: string; meta: SecretMeta }> = [];
      for (const e of v.entries) {
        if (SECRET_NAME_RE.test(e.name)) kept.push({ name: e.name, meta: e.meta });
        else emit("secrets.list_name_dropped");
      }
      return kept;
    },
  };
}
