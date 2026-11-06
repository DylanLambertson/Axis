// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomUUID } from "node:crypto";
import type { Connection } from "@axis/daemon";
import { lookupMethod, responseEnvelopeSchema, welcomeSchema, type Welcome } from "@axis/protocol";
import type { TestSupervisor } from "./test-supervisor.js";

/**
 * The typed client of the headless slice (plan section 1.1). It speaks the envelope of `@axis/protocol` over a virtual connection
 * of the supervisor's mux: `hello`/`welcome`, request, cancel. Every answer is parsed with the protocol's own response envelope,
 * and an `ok` answer is parsed again with the method's response schema, so a handler that drifts from its contract fails the test
 * that called it. Idempotency keys are UUIDv4. Event frames (`axis.events/1`) are collected in `frames`; `ack` grants credit.
 */
export interface Answer {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string; readonly details?: Record<string, unknown> | undefined; readonly retryable?: boolean };
}

/** A generous bound (not an assertion about speed): a host that has not answered by now is stuck. */
const CALL_BOUND_MS = 30_000;

export const newKey = (): string => randomUUID();

/** Every frame any client received, as JSON text: the "appears in no response" checks read it. */
export const transcript: string[] = [];

export class TestClient {
  readonly welcome: Welcome;
  readonly #conn: Connection;
  readonly #pending = new Map<string, (m: unknown) => void>();
  /** Every event frame received (messages with `sub`), in arrival order. */
  readonly frames: Array<{ sub: string; seq?: number; event?: Record<string, unknown>; resync?: unknown; end?: unknown }> = [];
  #n = 0;

  private constructor(conn: Connection, welcome: Welcome) {
    this.#conn = conn;
    this.welcome = welcome;
    conn.onMessage((m) => this.#receive(m));
    // A connection that closes (the host died) fails every call still waiting.
    conn.onClose(() => this.#failAll("the connection closed"));
  }

  #failAll(why: string): void {
    for (const [id, resolve] of [...this.#pending]) {
      this.#pending.delete(id);
      resolve({ __failed: why });
    }
  }

  /** Connect with `attestation` (a fresh `user` one by default), send `hello` for every contract the protocol has, and wait for `welcome`. */
  static async open(sup: TestSupervisor, attestation = sup.attest()): Promise<TestClient> {
    const conn = sup.connect(attestation);
    const first = new Promise<unknown>((resolve) => {
      conn.onMessage(function once(m: unknown) {
        resolve(m);
      });
    });
    conn.send({ type: "hello", protocolVersions: [1], contracts: ALL_CONTRACTS.map((id) => ({ id, versions: [1] })) });
    const welcome = welcomeSchema.parse(await first);
    return new TestClient(conn, welcome);
  }

  #receive(raw: unknown): void {
    transcript.push(JSON.stringify(raw));
    if (typeof raw === "object" && raw !== null && "sub" in raw) {
      this.frames.push(raw as TestClient["frames"][number]);
      return;
    }
    const id = (raw as { id?: unknown } | null)?.id;
    if (typeof id !== "string") return;
    const resolve = this.#pending.get(id);
    if (resolve !== undefined) {
      this.#pending.delete(id);
      resolve(raw);
    }
  }

  /** One request. `key` is the idempotency key (`true` makes a fresh one). */
  call(contract: string, method: string, payload: unknown, key?: string | true): Promise<Answer> {
    const id = `r${++this.#n}`;
    const idempotencyKey = key === true ? newKey() : key;
    const spec = lookupMethod(contract, 1, method);
    return new Promise<Answer>((resolve, reject) => {
      const timer = setTimeout(() => (this.#pending.delete(id), reject(new Error(`${contract}.${method}: no answer within ${CALL_BOUND_MS} ms`))), CALL_BOUND_MS);
      timer.unref();
      this.#pending.set(id, (raw) => {
        clearTimeout(timer);
        if (typeof raw === "object" && raw !== null && "__failed" in raw) return reject(new Error(`${contract}.${method}: ${String((raw as { __failed: unknown }).__failed)}`));
        const parsed = responseEnvelopeSchema.safeParse(raw);
        if (!parsed.success) return reject(new Error(`${contract}.${method}: the answer is not a response envelope`));
        if (!parsed.data.ok) return resolve({ ok: false, error: parsed.data.error as NonNullable<Answer["error"]> });
        const checked = spec?.response.safeParse(parsed.data.result);
        if (checked !== undefined && !checked.success) return reject(new Error(`${contract}.${method}: the result breaks its contract`));
        resolve({ ok: true, result: parsed.data.result });
      });
      this.#conn.send({ v: 1, id, contract, contractVersion: 1, method, payload, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
    });
  }

  /** `call`, and the result (the test fails when the call did not succeed). */
  async ok<T = Record<string, unknown>>(contract: string, method: string, payload: unknown, key?: string | true): Promise<T> {
    const a = await this.call(contract, method, payload, key);
    if (!a.ok) throw new Error(`${contract}.${method} failed: ${a.error?.code ?? "?"} ${String(a.error?.details?.["reason"] ?? "")}`);
    return a.result as T;
  }

  /** Credit for a subscription: acknowledges every frame of it up to `seq`. */
  ack(sub: string, seq: number): void {
    this.#conn.send({ v: 1, ack: sub, seq });
  }

  close(): void {
    this.#failAll("the client was closed");
    this.#conn.close();
  }
}

const ALL_CONTRACTS = ["axis.worktrees", "axis.projects", "axis.approvals", "axis.audit", "axis.cli-runs", "axis.providers", "axis.git", "axis.review", "axis.events"] as const;

/** The result of an answer that must have succeeded; the failure names the closed code and reason (never a message). */
export function resultOf<T = Record<string, unknown>>(a: Answer, what: string): T {
  if (!a.ok) throw new Error(`${what} failed: ${JSON.stringify(a.error)}`);
  return a.result as T;
}

/** Poll `pred` until it holds, yielding to the event loop between tries. It ends by condition, never by a fixed wait. */
export async function until(pred: () => boolean | Promise<boolean>, what: string, limit = 5000): Promise<void> {
  for (let i = 0; i < limit; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`gave up waiting for ${what}`);
}
