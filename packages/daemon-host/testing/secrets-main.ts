// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { SecretMeta } from "../src/control/secrets-messages.js";

/**
 * TEST ONLY: main's side of the secret broker (`docs/design/secret-broker.md` §3.4) as an in-memory model, for the daemon-side
 * tests of PV-N0c-1. It keeps main's ordering rules, which the daemon's reconciliation relies on:
 * - one operation per name at a time; a later request for the same name waits behind it (at most `maxQueued` wait in all);
 * - each request's budget starts when it is accepted: a request still waiting, or still working, at its budget answers
 *   `failed` at once, but a running operation keeps its name until its work settles, so a late `put` lands before any later
 *   request for that name runs;
 * - at most `maxOutstanding` requests in all (running, waiting, and timed out but not settled); more answer `failed`.
 * The test sets how long each operation's work takes (`workMs`, `Infinity` for a hang), whether it fails without writing
 * (`failWork`), and may replace any answer with raw bytes (`rawAnswer`). It is not a real keyring and stores no file.
 */

export type SecretsOp = "info" | "put" | "get" | "meta" | "remove" | "list";
type Message = { readonly type: string; readonly requestId: string; readonly [k: string]: unknown };
type Reply = (answer: unknown) => void;

export interface FakeSecretsMainOptions {
  /** Main's budget per request, in ms. Defaults: 60 s for `get` and `put`, 5 s for the rest (§3.4). */
  readonly budgetMs?: Partial<Record<SecretsOp, number>>;
  readonly maxQueued?: number;
  readonly maxOutstanding?: number;
}

export class FakeSecretsMain {
  readonly entries = new Map<string, { secret: string; meta: SecretMeta }>();
  info: { backend: SecretMeta["backend"]; protection: SecretMeta["protection"]; available: boolean } = { backend: "gnome_libsecret", protection: "os_protected", available: true };
  /** Every request main accepted, in arrival order. */
  readonly seen: Message[] = [];
  /** Every operation whose work ran, in the order it STARTED (name-ordered per name). */
  readonly started: Array<{ op: SecretsOp; name: string | undefined; requestId: string }> = [];
  /** How long an operation's work takes (ms; `Infinity` never settles). Default 0. */
  workMs: (op: SecretsOp, name: string | undefined) => number = () => 0;
  /** When true for an operation, its work fails and writes nothing (answered `failed`). */
  failWork: (op: SecretsOp, name: string | undefined) => boolean = () => false;
  /**
   * The protection `get` and `meta` report for a stored entry, as main reads it from the ciphertext (handoff H-6); default the
   * stored metadata's own.
   */
  readProtection: (name: string) => SecretMeta["protection"] | undefined = () => undefined;
  /** Replace the answer: return the raw object to send, `null` to send nothing, `undefined` for the normal answer. */
  rawAnswer: (m: Message, normal: unknown) => unknown = () => undefined;
  readonly #budget: Record<SecretsOp, number>;
  readonly #maxQueued: number;
  readonly #maxOutstanding: number;
  readonly #held = new Map<string, Promise<void>>();
  #queued = 0;
  #outstanding = 0;

  constructor(options: FakeSecretsMainOptions = {}) {
    this.#budget = { info: 5_000, put: 60_000, get: 60_000, meta: 5_000, remove: 5_000, list: 5_000, ...options.budgetMs };
    this.#maxQueued = options.maxQueued ?? 4;
    this.#maxOutstanding = options.maxOutstanding ?? 8;
  }

  /** True for a control message this model answers. */
  static handles(m: { readonly type: string }): boolean {
    return m.type.startsWith("secrets.");
  }

  /** Take one request; `reply` is called at most once, with the answer to send. */
  handle(m: Message, reply: Reply): void {
    this.seen.push(m);
    const op = m.type.slice("secrets.".length) as SecretsOp;
    const name = typeof m["name"] === "string" ? (m["name"] as string) : undefined;
    let answered = false;
    const send = (answer: unknown): void => {
      if (answered) return;
      answered = true;
      const raw = this.rawAnswer(m, answer);
      if (raw === null) return;
      reply(raw === undefined ? answer : raw);
    };
    const failed = { type: "secrets.result", requestId: m.requestId, ok: false, error: "failed" };
    if (this.#outstanding >= this.#maxOutstanding) return send(failed);
    if (op === "info") return send({ type: "secrets.result", requestId: m.requestId, ok: true, value: { op: "info", ...this.info } });
    const before = name === undefined ? undefined : this.#held.get(name);
    if (before !== undefined && this.#queued >= this.#maxQueued) return send(failed);
    this.#outstanding += 1;
    const timer = setTimeout(() => send(failed), this.#budget[op]);
    let release: () => void = () => undefined;
    const mine = new Promise<void>((r) => void (release = r));
    if (name !== undefined) this.#held.set(name, mine);
    if (before !== undefined) this.#queued += 1;
    void (async () => {
      if (before !== undefined) {
        await before;
        this.#queued -= 1;
      }
      if (answered) return this.#settle(name, mine, release, timer); // its budget ran out while it waited: it never runs
      this.started.push({ op, name, requestId: m.requestId });
      const ms = this.workMs(op, name);
      if (ms === Infinity) return; // a hung operation pins its name and its outstanding slot for good
      if (ms > 0) await new Promise((r) => setTimeout(r, ms));
      send(this.failWork(op, name) ? failed : this.#do(op, m, name));
      this.#settle(name, mine, release, timer);
    })();
  }

  #settle(name: string | undefined, mine: Promise<void>, release: () => void, timer: NodeJS.Timeout): void {
    clearTimeout(timer);
    this.#outstanding -= 1;
    if (name !== undefined && this.#held.get(name) === mine) this.#held.delete(name);
    release();
  }

  /** A fresh copy (no shared reference inside an answer, handoff H-7) with the protection read from the "ciphertext". */
  #read(name: string, meta: SecretMeta): SecretMeta {
    const p = this.readProtection(name);
    return { ...meta, ...(p === undefined ? {} : { protection: p }) };
  }

  #do(op: SecretsOp, m: Message, name: string | undefined): unknown {
    const ok = (value: unknown) => ({ type: "secrets.result", requestId: m.requestId, ok: true, value });
    const notFound = { type: "secrets.result", requestId: m.requestId, ok: false, error: "not_found" };
    const e = name === undefined ? undefined : this.entries.get(name);
    switch (op) {
      case "put": {
        const meta = m["meta"] as SecretMeta;
        // The vault's contract (handoff H-4): refuse, never write, when the write would land elsewhere than the decision.
        const elsewhere = meta.backend !== this.info.backend || meta.protection !== this.info.protection;
        if (!this.info.available || this.info.protection === "none" || elsewhere) return { type: "secrets.result", requestId: m.requestId, ok: false, error: "refused" };
        this.entries.set(name as string, { secret: m["secret"] as string, meta: { ...meta } });
        return ok({ op: "put", landedOn: { backend: this.info.backend, protection: this.info.protection } });
      }
      case "get":
        return e === undefined ? notFound : ok({ op: "get", secret: e.secret, meta: this.#read(name as string, e.meta) });
      case "meta":
        return e === undefined ? notFound : ok({ op: "meta", meta: this.#read(name as string, e.meta) });
      case "remove":
        return ok({ op: "remove", removed: this.entries.delete(name as string) });
      case "list":
        return ok({ op: "list", entries: [...this.entries].map(([n, v]) => ({ name: n, meta: this.#read(n, v.meta) })) });
      default:
        return { type: "secrets.result", requestId: m.requestId, ok: false, error: "failed" };
    }
  }
}
