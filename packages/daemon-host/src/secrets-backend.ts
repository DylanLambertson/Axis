// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import type { CREDENTIAL_BACKENDS, CREDENTIAL_PROTECTIONS } from "@axis/protocol";
import { SECRETS_TIMEOUTS_MS, type RequestOptions, type SecretsAnswer, type SecretsAsk } from "./control/client.js";
import { SECRET_NAME_RE, type SecretMeta, type SecretsValue } from "./control/secrets-messages.js";

/**
 * The vault's `SecretBackend` over main's secret broker (PV-N0c-1, `docs/design/secret-broker.md` §3.4 and §3.5). It is typed
 * structurally, because only the two bindings may import `@axis/vault`; `bindings/providers.ts` assigns it to the vault's
 * `SecretBackend` (`asVaultBackend`), so the build fails if the two diverge. Every answer was parsed by the control client's
 * strict schemas; failures are one fixed `AxisError` (`E_UNAVAILABLE`, "The secret broker did not complete the request") with
 * a closed `reason` only, never main's text, a name or a value. The vault replaces any throw with its own `backend_failed`.
 *
 * - Ordering: a `put` or `remove` for ONE name leaves only after every earlier `put` or `remove` for it settled, so a rollback
 *   `remove` never overtakes the `put` it undoes. One that gave up waiting (and so never left) does not let a later one pass:
 *   the chain's tail waits for its predecessor too (review n0c1-2a r2 NIT-A). A `get` or `meta` waits only behind such a
 *   mutation (it must see its outcome) and otherwise goes straight to main, which orders requests by name itself. Other names
 *   are never held up.
 * - Bounds (gate 6; review n0c1-2a SF-1): per name, at most 4 reads and, separately, 4 mutations wait, so reads can never
 *   make a `put` or a rollback `remove` busy (r2 NIT-C); more fail `busy` at once. A waiting request's deadline runs from when
 *   it was asked, not from when it leaves, so with main hung on a name every caller fails within one timeout. What leaves
 *   counts against the control client's 8 outstanding.
 * - A `put` that main answered `failed`, that timed out, whose answer was refused, or that was cut off after it was SENT
 *   (dispose, channel close) is UNKNOWN: main's late operation may still write the record. The backend reconciles with ONE
 *   `get`, which main orders behind the late `put`. The same secret with the same `storedAt`, `label` and consent is this put:
 *   reported where the record says it landed (the vault then checks that against the backend its decision was made on).
 *   Anything else is reported failed and nothing is removed, so a rotation keeps the previous secret. When the `get` cannot
 *   tell, the put stays unknown: reported failed, with the closed event `secrets.put_unknown`. Never retried. A put that never
 *   left the daemon, or that main answered `refused`, `corrupt` or `not_found`, is certain (main writes nothing then: the
 *   handoff list of §3.4) and is not reconciled. The secret comparison is not constant-time: both values are already in this
 *   process (accepted, review N-3).
 * - `list` is tolerant (§3.5): a name the vault's rule refuses is dropped, with one closed event each, before the vault sees
 *   the list (the vault's `list` throws on any bad name). Malformed metadata, an over-long name or more than 256 entries
 *   still fail the whole list (the control schema). An answer the channel itself drops (over the control byte cap) is not
 *   seen at all: it fails at the request's timeout, still as a fixed failure (review N-2).
 */

type BackendId = (typeof CREDENTIAL_BACKENDS)[number];
type Protection = (typeof CREDENTIAL_PROTECTIONS)[number];

/** The vault's `BackendInfo`, `WrittenTo` and `EntryMeta`, restated (an absent label is absent, never `undefined`). */
export interface BrokerBackendInfo {
  readonly id: BackendId;
  readonly protection: Protection;
  readonly label: string;
}
export interface BrokerWrittenTo {
  readonly id: BackendId;
  readonly protection: Protection;
}
export interface BrokerEntryMeta {
  readonly label?: string;
  readonly storedAt: number;
  readonly backend: BackendId;
  readonly protection: Protection;
  readonly weakConsent: boolean;
}

export interface BrokerSecretBackend {
  info(): Promise<BrokerBackendInfo>;
  put(name: string, secret: string, meta: BrokerEntryMeta): Promise<BrokerWrittenTo>;
  get(name: string): Promise<{ readonly secret: string; readonly meta: BrokerEntryMeta } | undefined>;
  meta(name: string): Promise<BrokerEntryMeta | undefined>;
  remove(name: string): Promise<boolean>;
  list(): Promise<ReadonlyArray<{ readonly name: string; readonly meta: BrokerEntryMeta }>>;
}

/** The closed events (no name, no value). */
export type BrokerEvent = { readonly event: "secrets.put_landed_late" | "secrets.put_absent" | "secrets.put_unknown" | "secrets.list_name_dropped" };

export interface SecretsPort {
  secrets(ask: SecretsAsk, options?: RequestOptions): Promise<SecretsAnswer>;
}

export interface BrokerSecretBackendOptions {
  readonly client: SecretsPort;
  readonly onEvent?: (event: BrokerEvent) => void;
}

/** At most this many reads, and as many mutations, wait for one name (main keeps 4 queued in all, §3.4). */
export const MAX_WAITING_PER_NAME = 4;

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

/** A client rejection as a closed reason; `sent` is the client's own record of whether the message left (SF-3). */
function rejectionOf(e: unknown): { reason: Reason; sent: boolean } {
  const code = e instanceof AxisError ? e.code : undefined;
  const why = e instanceof AxisError ? e.detail["reason"] : undefined;
  const sent = e instanceof AxisError && e.detail["sent"] === true;
  if (code === "E_TIMEOUT") return { reason: "timeout", sent };
  if (code === "E_BACKPRESSURE") return { reason: "busy", sent };
  if (code === "E_CANCELLED") return { reason: "cancelled", sent };
  if (code === "E_UNAVAILABLE") return { reason: "closed", sent };
  if (why === "answer_invalid") return { reason: "invalid_answer", sent };
  return { reason: "failed", sent };
}

/** A parsed meta as the vault's shape: the label only when there is one. */
const entryMeta = (m: SecretMeta): BrokerEntryMeta => ({
  ...(m.label === undefined ? {} : { label: m.label }),
  storedAt: m.storedAt,
  backend: m.backend,
  protection: m.protection,
  weakConsent: m.weakConsent,
});

export function createBrokerSecretBackend(options: BrokerSecretBackendOptions): BrokerSecretBackend {
  return build(options, SECRETS_TIMEOUTS_MS);
}

/** TEST ONLY: the same backend with shorter daemon-side timeouts (never reachable from the composition: a pinned test). */
export function createBrokerSecretBackendForTest(options: BrokerSecretBackendOptions, timeoutsMs: { readonly slow: number; readonly fast: number }): BrokerSecretBackend {
  return build(options, timeoutsMs);
}

function build(options: BrokerSecretBackendOptions, timeoutsMs: { readonly slow: number; readonly fast: number }): BrokerSecretBackend {
  const { client } = options;
  const emit = (event: BrokerEvent["event"]): void => {
    try {
      options.onEvent?.({ event });
    } catch {
      // an observer never changes the outcome
    }
  };
  const budget = (a: SecretsAsk): number => (a.type === "secrets.get" || a.type === "secrets.put" ? timeoutsMs.slow : timeoutsMs.fast);
  /** Whether a failed request may have reached main; kept beside the error, never on it (review N-4). */
  const mayHaveActed = new WeakSet<AxisError>();

  /** One request, due `deadline` (monotonic ms). A client rejection becomes a fixed failure. */
  const ask = async (a: SecretsAsk, deadline: number): Promise<SecretsAnswer> => {
    const left = Math.ceil(deadline - performance.now());
    if (left < 1) throw fail("timeout"); // it waited its whole budget behind another request: never sent
    try {
      return await client.secrets(a, { timeoutMs: left });
    } catch (e) {
      const r = rejectionOf(e);
      const f = fail(r.reason);
      if (r.sent) mayHaveActed.add(f);
      throw f;
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

  // Per name: the tail of its put/remove chain (a promise that never rejects) and how many reads and mutations wait for it,
  // keyed `r:<name>` and `m:<name>` (Maps: a name like `constructor` is an ordinary key).
  const mutations = new Map<string, Promise<void>>();
  const waiting = new Map<string, number>();
  /** Wait until `before` settles or `deadline` passes; counted against the name's bound for its kind. */
  const waitFor = async (key: string, before: Promise<void>, deadline: number): Promise<void> => {
    const n = waiting.get(key) ?? 0;
    if (n >= MAX_WAITING_PER_NAME) throw fail("busy");
    waiting.set(key, n + 1);
    let timer: NodeJS.Timeout | undefined;
    try {
      const timedOut = new Promise<"timeout">((r) => {
        const t = setTimeout(() => r("timeout"), Math.max(0, deadline - performance.now())) as unknown as NodeJS.Timeout; // opaque handle under Code OSS's typings (ADR 0005)
        t.unref();
        timer = t;
      });
      if ((await Promise.race([before.then(() => "settled" as const), timedOut])) === "timeout") throw fail("timeout");
    } finally {
      clearTimeout(timer);
      const left = (waiting.get(key) ?? 1) - 1;
      if (left === 0) waiting.delete(key);
      else waiting.set(key, left);
    }
  };
  /** A put or remove: after the name's previous mutation, and the next one's predecessor. */
  const mutation = <T>(name: string, a: SecretsAsk, run: (deadline: number) => Promise<T>): Promise<T> => {
    const deadline = performance.now() + budget(a);
    const before = mutations.get(name);
    const mine = (async () => {
      if (before !== undefined) await waitFor(`m:${name}`, before, deadline);
      return run(deadline);
    })();
    // Settles when this one AND every earlier one settled: a request that gave up waiting never lets the next one pass.
    const tail = Promise.all([before, mine.catch(() => undefined)]).then(() => undefined);
    mutations.set(name, tail);
    void tail.then(() => {
      if (mutations.get(name) === tail) mutations.delete(name);
    });
    return mine;
  };
  /** A get or meta: behind a pending mutation of the name only; otherwise at once. */
  const read = async <T>(name: string, a: SecretsAsk, run: (deadline: number) => Promise<T>): Promise<T> => {
    const deadline = performance.now() + budget(a);
    const before = mutations.get(name);
    if (before !== undefined) await waitFor(`r:${name}`, before, deadline);
    return run(deadline);
  };

  const getNow = async (name: string, deadline: number): Promise<{ secret: string; meta: BrokerEntryMeta } | undefined> => {
    const v = valueOf(await ask({ type: "secrets.get", name }, deadline), "get");
    return v === "not_found" ? undefined : { secret: v.secret, meta: entryMeta(v.meta) };
  };

  /** The put's outcome is unknown: one `get`, ordered behind it by main, decides; never a retry. */
  const reconcile = async (name: string, secret: string, meta: BrokerEntryMeta): Promise<BrokerWrittenTo> => {
    let seen: { secret: string; meta: BrokerEntryMeta } | undefined;
    try {
      seen = await getNow(name, performance.now() + timeoutsMs.slow);
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
      const v = valueOf(await ask({ type: "secrets.info" }, performance.now() + timeoutsMs.fast), "info");
      if (v === "not_found") throw fail("invalid_answer");
      // An unavailable cipher protects nothing: the vault's weak policy then refuses every store.
      return { id: v.backend, protection: v.available ? v.protection : "none", label: LABELS[v.backend] };
    },
    put(name, secret, meta) {
      const a: SecretsAsk = { type: "secrets.put", name, secret, meta };
      return mutation(name, a, async (deadline) => {
        let answer: SecretsAnswer;
        try {
          answer = await ask(a, deadline);
        } catch (e) {
          if (!(e instanceof AxisError) || !mayHaveActed.has(e)) throw e; // never left the daemon: nothing to reconcile
          return reconcile(name, secret, meta);
        }
        if (!answer.ok && answer.error === "failed") return reconcile(name, secret, meta);
        const v = valueOf(answer, "put");
        if (v === "not_found") throw fail("invalid_answer");
        return { id: v.landedOn.backend, protection: v.landedOn.protection };
      });
    },
    get(name) {
      const a: SecretsAsk = { type: "secrets.get", name };
      return read(name, a, (deadline) => getNow(name, deadline));
    },
    meta(name) {
      const a: SecretsAsk = { type: "secrets.meta", name };
      return read(name, a, async (deadline) => {
        const v = valueOf(await ask(a, deadline), "meta");
        return v === "not_found" ? undefined : entryMeta(v.meta);
      });
    },
    remove(name) {
      const a: SecretsAsk = { type: "secrets.remove", name };
      return mutation(name, a, async (deadline) => {
        const v = valueOf(await ask(a, deadline), "remove");
        return v === "not_found" ? false : v.removed;
      });
    },
    async list() {
      const v = valueOf(await ask({ type: "secrets.list" }, performance.now() + timeoutsMs.fast), "list");
      if (v === "not_found") throw fail("invalid_answer");
      const kept: Array<{ name: string; meta: BrokerEntryMeta }> = [];
      for (const e of v.entries) {
        if (SECRET_NAME_RE.test(e.name)) kept.push({ name: e.name, meta: entryMeta(e.meta) });
        else emit("secrets.list_name_dropped");
      }
      return kept;
    },
  };
}
