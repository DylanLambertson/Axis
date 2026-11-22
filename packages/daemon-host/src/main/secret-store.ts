// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * Main's secret broker store (ticket PV-N0a, `docs/design/secret-broker.md` §3). Runs in main: the cipher (`safeStorage` in the
 * product), the record files, the timers and the clock are injected, and this file imports no `@axis/*` package and no Node
 * module. It answers the six `secrets.*` requests with a value or one closed error, and never puts a secret, a path or an
 * exception's text into an answer or an event.
 *
 * - **Records:** one file per entry, `<lower-case hex of the name's UTF-8>.v1`, holding strict JSON `{ v: 1, meta, ct }`; `ct` is
 *   the base64 of the cipher's output over the frame `axis.secret/1\n<name>\n<secret>`. A read requires the exact frame and the
 *   file's own name, so a record copied under another entry's name is `corrupt`.
 * - **Weak backends store nothing** (§3.3): an unavailable cipher, or a Linux `basic_text` or `unknown` backend, refuses every
 *   `put`; on Linux the ciphertext itself must start with `v11` (a keyring key), so a session switched to the hardcoded key
 *   (`v10`) is refused too. On macOS and Windows protection comes from the platform report, never from a prefix.
 * - **Bounds** (§3.4): one request per name at a time, the next for the same name queues behind it; at most 4 run at once and at
 *   most 4 wait, more answer `failed`. Each request has a budget (60 s for `get` and `put` on macOS and Linux, where an unlock may
 *   prompt; 5 s otherwise); past it the answer is `failed` (the operation may still finish: the daemon's vault treats that as a
 *   failed write and rolls back).
 */

export type CipherBackend = "macos_keychain" | "windows_dpapi" | "gnome_libsecret" | "kwallet" | "kwallet5" | "kwallet6" | "basic_text" | "unknown";
export type Protection = "os_protected" | "none";

/** The OS cipher as main sees it now. */
export interface SecretCipher {
  /** `available` false when encryption cannot be used at all. On Linux `backend` is `getSelectedStorageBackend()`. */
  status(): { readonly available: boolean; readonly backend: CipherBackend };
  encrypt(plain: string): Uint8Array;
  decrypt(data: Uint8Array): string;
}

/** The record folder (`secret-files.ts`). Every method throws on anything unusual; the store turns a throw into a closed error. */
export interface SecretFiles {
  /** The folder is a real directory owned by the user, mode 0700, not a symlink; creates it when absent. Throws otherwise. */
  check(): Promise<void>;
  /** The bytes of `file`, or null when it does not exist. Throws for a symlink, a non-regular file, a wrong mode or an oversize file. */
  read(file: string): Promise<Uint8Array | null>;
  /** Durable atomic write of `file` (0600). */
  write(file: string, data: Uint8Array): Promise<void>;
  /** True when `file` was removed, false when it did not exist. */
  remove(file: string): Promise<boolean>;
  /** The names of the regular files in the folder. */
  names(): Promise<readonly string[]>;
  /** Remove leftover temporary files of interrupted writes; returns how many. */
  cleanup(): Promise<number>;
}

export interface SecretTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const SECRET_ERRORS = ["not_found", "refused", "corrupt", "failed"] as const;
export type SecretError = (typeof SECRET_ERRORS)[number];

export interface StoredMeta {
  readonly label?: string;
  readonly storedAt: number;
  readonly backend: string;
  readonly protection: string;
  readonly weakConsent: boolean;
}

export type SecretRequest =
  | { readonly type: "secrets.info" }
  | { readonly type: "secrets.put"; readonly name: string; readonly secret: string; readonly meta: StoredMeta }
  | { readonly type: "secrets.get"; readonly name: string }
  | { readonly type: "secrets.meta"; readonly name: string }
  | { readonly type: "secrets.remove"; readonly name: string }
  | { readonly type: "secrets.list" };

export type SecretValue =
  | { readonly op: "info"; readonly backend: CipherBackend; readonly protection: Protection; readonly available: boolean }
  | { readonly op: "put"; readonly landedOn: { readonly backend: CipherBackend; readonly protection: Protection } }
  | { readonly op: "get"; readonly secret: string; readonly meta: StoredMeta }
  | { readonly op: "meta"; readonly meta: StoredMeta }
  | { readonly op: "remove"; readonly removed: boolean }
  | { readonly op: "list"; readonly entries: ReadonlyArray<{ readonly name: string; readonly meta: StoredMeta }> };

export type SecretAnswer = { readonly ok: true; readonly value: SecretValue } | { readonly ok: false; readonly error: SecretError };

/** Closed event names only: never a name, a secret or a path. */
export type SecretEvent = "secret_refused_weak" | "secret_refused_prefix" | "secret_corrupt" | "secret_failed" | "secret_timeout" | "secret_overloaded" | "secret_name_ignored";

export interface SecretStoreOptions {
  readonly cipher: SecretCipher;
  readonly files: SecretFiles;
  readonly platform: string;
  readonly timers: SecretTimers;
  readonly onEvent?: (event: SecretEvent) => void;
  /** Overrides for tests. */
  readonly budgets?: { readonly slowMs?: number; readonly fastMs?: number };
}

export interface SecretStore {
  /** At main's start, before the first request: check the folder and remove leftover temporary files. Never throws. */
  start(): Promise<void>;
  handle(request: SecretRequest): Promise<SecretAnswer>;
}

export const SECRET_FRAME_TAG = "axis.secret/1";
export const MAX_RECORD_BYTES = 16_384;
export const MAX_ENTRIES = 256;
export const MAX_RUNNING = 4;
export const MAX_WAITING = 4;
export const SLOW_BUDGET_MS = 60_000;
export const FAST_BUDGET_MS = 5_000;
const NAME_RE = /^(?:integration:)?[a-z0-9][a-z0-9._-]{0,63}$/;
const NAME_MAX = 100;
const SECRET_RE = /^[\x21-\x7e]{8,4096}$/;
const LABEL_RE = /^[\x20-\x7e]{1,64}$/;
const FILE_RE = /^((?:[0-9a-f]{2}){1,100})\.v1$/;
const BACKENDS: ReadonlySet<string> = new Set(["macos_keychain", "windows_dpapi", "gnome_libsecret", "kwallet", "kwallet5", "kwallet6", "basic_text", "unknown", "memory"]);
const PROTECTIONS: ReadonlySet<string> = new Set(["os_protected", "none", "ephemeral"]);
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

class Refusal extends Error {
  constructor(readonly code: SecretError, readonly event?: SecretEvent) {
    super(code);
  }
}

export const validName = (name: unknown): name is string => typeof name === "string" && name.length <= NAME_MAX && NAME_RE.test(name);

/** The record file of a name: the lower-case hex of its UTF-8 bytes (names are ASCII) and `.v1`. */
export function fileOf(name: string): string {
  let hex = "";
  for (let i = 0; i < name.length; i++) hex += name.charCodeAt(i).toString(16).padStart(2, "0");
  return `${hex}.v1`;
}

/** The name of a record file, only when the file name is the canonical form of a valid name; else null. */
export function nameOf(file: string): string | null {
  const m = FILE_RE.exec(file);
  if (m === null) return null;
  const hex = m[1] as string;
  let name = "";
  for (let i = 0; i < hex.length; i += 2) name += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return validName(name) && fileOf(name) === file ? name : null;
}

export function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : B64[c & 63];
  }
  return out;
}

export function unbase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => (text[i + k] === "=" ? 0 : B64.indexOf(text[i + k] as string)));
    const n = ((v[0] as number) << 18) | ((v[1] as number) << 12) | ((v[2] as number) << 6) | (v[3] as number);
    for (const byte of [(n >> 16) & 255, (n >> 8) & 255, n & 255]) if (o < out.length) out[o++] = byte;
  }
  return base64(out) === text ? out : null;
}

function utf8(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0x7e) throw new Refusal("corrupt");
    out[i] = c;
  }
  return out;
}

function ascii(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) {
    if (b > 0x7e) throw new Refusal("corrupt", "secret_corrupt");
    s += String.fromCharCode(b);
  }
  return s;
}

function cleanMeta(v: unknown): StoredMeta | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.some((k) => !["label", "storedAt", "backend", "protection", "weakConsent"].includes(k))) return null;
  const { label, storedAt, backend, protection, weakConsent } = o;
  if (label !== undefined && (typeof label !== "string" || !LABEL_RE.test(label))) return null;
  if (!Number.isSafeInteger(storedAt) || (storedAt as number) < 0) return null;
  if (typeof backend !== "string" || !BACKENDS.has(backend) || typeof protection !== "string" || !PROTECTIONS.has(protection) || typeof weakConsent !== "boolean") return null;
  return { ...(label === undefined ? {} : { label: label as string }), storedAt: storedAt as number, backend, protection, weakConsent };
}

export function createSecretStore(options: SecretStoreOptions): SecretStore {
  const { cipher, files, platform, timers } = options;
  const linux = platform === "linux";
  const slowMs = options.budgets?.slowMs ?? SLOW_BUDGET_MS;
  const fastMs = options.budgets?.fastMs ?? FAST_BUDGET_MS;
  const emit = (e: SecretEvent): void => {
    try {
      options.onEvent?.(e);
    } catch {
      // an event sink never changes an answer
    }
  };

  /** The backend now, its protection, and whether a store may happen at all. */
  const now = (): { backend: CipherBackend; protection: Protection; available: boolean; strong: boolean } => {
    const s = cipher.status();
    const platformBackend: CipherBackend = platform === "darwin" ? "macos_keychain" : platform === "win32" ? "windows_dpapi" : s.backend;
    const strong = s.available && platformBackend !== "basic_text" && platformBackend !== "unknown";
    return { backend: platformBackend, protection: strong ? "os_protected" : "none", available: s.available, strong };
  };

  /** Linux only: what the ciphertext says about its key. */
  const prefixProtection = (ct: Uint8Array): Protection => {
    if (ct.length >= 3 && ct[0] === 0x76 && ct[1] === 0x31 && ct[2] === 0x31) return "os_protected"; // "v11"
    if (ct.length >= 3 && ct[0] === 0x76 && ct[1] === 0x31 && ct[2] === 0x30) return "none"; // "v10"
    throw new Refusal("corrupt", "secret_corrupt");
  };

  const parseRecord = (bytes: Uint8Array): { meta: StoredMeta; ct: Uint8Array } => {
    let v: unknown;
    try {
      v = JSON.parse(ascii(bytes));
    } catch (e) {
      if (e instanceof Refusal) throw e;
      throw new Refusal("corrupt", "secret_corrupt");
    }
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Refusal("corrupt", "secret_corrupt");
    const o = v as Record<string, unknown>;
    if (Object.keys(o).length !== 3 || o["v"] !== 1 || typeof o["ct"] !== "string") throw new Refusal("corrupt", "secret_corrupt");
    const meta = cleanMeta(o["meta"]);
    const ct = unbase64(o["ct"]);
    if (meta === null || ct === null || ct.length === 0) throw new Refusal("corrupt", "secret_corrupt");
    return { meta, ct };
  };

  /** The protection to report for a stored record: from the prefix on Linux, from the platform elsewhere. */
  const reported = (meta: StoredMeta, ct: Uint8Array): StoredMeta => ({ ...meta, protection: linux ? prefixProtection(ct) : now().protection });

  const readRecord = async (name: string): Promise<{ meta: StoredMeta; ct: Uint8Array } | null> => {
    await files.check();
    const bytes = await files.read(fileOf(name));
    if (bytes === null) return null;
    if (bytes.length === 0 || bytes.length > MAX_RECORD_BYTES) throw new Refusal("corrupt", "secret_corrupt");
    return parseRecord(bytes);
  };

  const run = async (r: SecretRequest): Promise<SecretValue> => {
    switch (r.type) {
      case "secrets.info": {
        const n = now();
        return { op: "info", backend: n.backend, protection: n.protection, available: n.available };
      }
      case "secrets.put": {
        const n = now();
        if (!n.strong) throw new Refusal("refused", "secret_refused_weak");
        // The vault decided where the write lands; a write elsewhere is refused, never made (the SecretBackend contract).
        if (r.meta.backend !== n.backend || r.meta.protection !== n.protection) throw new Refusal("refused", "secret_refused_weak");
        const ct = cipher.encrypt(`${SECRET_FRAME_TAG}\n${r.name}\n${r.secret}`);
        if (!(ct instanceof Uint8Array) || ct.length === 0) throw new Refusal("failed", "secret_failed");
        if (linux && prefixProtection(ct) !== "os_protected") throw new Refusal("refused", "secret_refused_prefix");
        await files.check();
        const record = utf8(JSON.stringify({ v: 1, meta: r.meta, ct: base64(ct) }));
        if (record.length > MAX_RECORD_BYTES) throw new Refusal("failed", "secret_failed");
        const existing = await files.read(fileOf(r.name));
        if (existing === null && (await files.names()).filter((f) => nameOf(f) !== null).length >= MAX_ENTRIES) throw new Refusal("refused");
        await files.write(fileOf(r.name), record);
        return { op: "put", landedOn: { backend: n.backend, protection: n.protection } };
      }
      case "secrets.get": {
        const rec = await readRecord(r.name);
        if (rec === null) throw new Refusal("not_found");
        const meta = reported(rec.meta, rec.ct);
        let plain: string;
        try {
          plain = cipher.decrypt(rec.ct);
        } catch {
          throw new Refusal("failed", "secret_failed");
        }
        const head = `${SECRET_FRAME_TAG}\n${r.name}\n`;
        const secret = typeof plain === "string" && plain.startsWith(head) ? plain.slice(head.length) : "";
        if (!SECRET_RE.test(secret)) throw new Refusal("corrupt", "secret_corrupt");
        return { op: "get", secret, meta };
      }
      case "secrets.meta": {
        const rec = await readRecord(r.name);
        if (rec === null) throw new Refusal("not_found");
        return { op: "meta", meta: reported(rec.meta, rec.ct) };
      }
      case "secrets.remove": {
        await files.check();
        return { op: "remove", removed: await files.remove(fileOf(r.name)) };
      }
      case "secrets.list": {
        await files.check();
        const entries: Array<{ name: string; meta: StoredMeta }> = [];
        for (const f of await files.names()) {
          const name = nameOf(f);
          if (name === null) {
            if (/\.v1$/.test(f)) emit("secret_name_ignored");
            continue;
          }
          if (entries.length >= MAX_ENTRIES) break;
          const rec = await readRecord(name).catch(() => null);
          if (rec === null) {
            emit("secret_name_ignored");
            continue;
          }
          try {
            entries.push({ name, meta: reported(rec.meta, rec.ct) });
          } catch {
            emit("secret_name_ignored");
          }
        }
        return { op: "list", entries };
      }
    }
  };

  // ---- bounds: one per name, at most MAX_RUNNING at once, at most MAX_WAITING waiting --------------------------------
  const busyNames = new Set<string>();
  let running = 0;
  const waiting: Array<{ key: string; start: () => void }> = [];

  const keyOf = (r: SecretRequest): string => ("name" in r ? `n:${r.name}` : `*:${r.type}`);
  const canStart = (key: string): boolean => running < MAX_RUNNING && !busyNames.has(key);
  const pump = (): void => {
    for (let i = 0; i < waiting.length; i++) {
      const w = waiting[i] as { key: string; start: () => void };
      if (canStart(w.key)) {
        waiting.splice(i, 1);
        i -= 1;
        w.start();
      }
    }
  };

  const budgetOf = (r: SecretRequest): number => ((r.type === "secrets.get" || r.type === "secrets.put") && (platform === "darwin" || platform === "linux") ? slowMs : fastMs);

  const execute = (r: SecretRequest, key: string): Promise<SecretAnswer> => {
    running += 1;
    busyNames.add(key);
    return new Promise<SecretAnswer>((resolve) => {
      let done = false;
      const finish = (a: SecretAnswer): void => {
        if (done) return;
        done = true;
        resolve(a);
      };
      const timer = timers.setTimeout(() => {
        emit("secret_timeout");
        finish({ ok: false, error: "failed" });
      }, budgetOf(r));
      run(r)
        .then((value) => finish({ ok: true, value }))
        .catch((e: unknown) => {
          if (e instanceof Refusal) {
            if (e.event !== undefined) emit(e.event);
            finish({ ok: false, error: e.code });
          } else {
            emit("secret_failed");
            finish({ ok: false, error: "failed" });
          }
        })
        .finally(() => {
          timers.clearTimeout(timer);
          running -= 1;
          busyNames.delete(key);
          pump();
        });
    });
  };

  return {
    async start(): Promise<void> {
      try {
        await files.check();
        await files.cleanup();
      } catch {
        emit("secret_failed");
      }
    },
    handle(request: SecretRequest): Promise<SecretAnswer> {
      if (typeof request !== "object" || request === null) return Promise.resolve({ ok: false, error: "failed" });
      if ("name" in request && !validName(request.name)) return Promise.resolve({ ok: false, error: "failed" });
      if (request.type === "secrets.put") {
        const meta = cleanMeta(request.meta);
        if (meta === null || typeof request.secret !== "string" || !SECRET_RE.test(request.secret)) return Promise.resolve({ ok: false, error: "failed" });
      }
      const key = keyOf(request);
      if (canStart(key) && !waiting.some((w) => w.key === key)) return execute(request, key);
      if (waiting.length >= MAX_WAITING) {
        emit("secret_overloaded");
        return Promise.resolve({ ok: false, error: "failed" });
      }
      return new Promise<SecretAnswer>((resolve) => {
        waiting.push({ key, start: () => void execute(request, key).then(resolve) });
      });
    },
  };
}
