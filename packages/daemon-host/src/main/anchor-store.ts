// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * Main's store of the audit anchor (ticket X1c, `docs/design/main-answers.md` section 3.1, `docs/packages.md` "Audit anchor").
 * The record is the text `axis.anchor/1 {"hash":"<64 hex>","seq":<n>}` encrypted with the OS-protected cipher (`safeStorage` in
 * the product) and kept in a file main owns, outside the daemon's data directory.
 *
 * `read()` says "absent" ONLY when the file does not exist and the cipher is a secure backend; every other failure (an insecure
 * or missing backend, an I/O error, a decrypt failure, a record that is not exactly the format) is `unavailable`, which main
 * answers with silence, so the host starts degraded instead of taking an unreadable record for a first start. Runs in main: the
 * cipher and the file are injected.
 */

export interface AnchorHead {
  readonly seq: number;
  readonly hash: string;
}

/** The OS-protected cipher. `status` is `secure` only for a real OS backend (never Linux `basic_text`). */
export interface AnchorCipher {
  status(): "secure" | "insecure" | "unavailable";
  encrypt(plain: string): Uint8Array;
  decrypt(data: Uint8Array): string;
}

/** The record file. `read` returns `null` only when the file does not exist; `write` returns only once the bytes are durable. */
export interface AnchorFile {
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
}

export const ANCHOR_UNAVAILABLE = ["insecure_backend", "read_failed", "decrypt_failed", "corrupt"] as const;
export type AnchorUnavailable = (typeof ANCHOR_UNAVAILABLE)[number];

export type AnchorRead =
  | { readonly kind: "anchor"; readonly head: AnchorHead }
  | { readonly kind: "absent" }
  | { readonly kind: "unavailable"; readonly reason: AnchorUnavailable };

export interface AnchorStore {
  read(): Promise<AnchorRead>;
  /** Encrypt and write durably. Throws (fixed text) when the backend is not secure or the write failed. */
  write(head: AnchorHead): Promise<void>;
}

export const ANCHOR_RECORD_TAG = "axis.anchor/1";
const HASH = /^[0-9a-f]{64}$/;
const RECORD = /^axis\.anchor\/1 \{"hash":"([0-9a-f]{64})","seq":([1-9][0-9]{0,15})\}$/;

export function isAnchorHead(v: unknown): v is AnchorHead {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return Object.keys(o).length === 2 && typeof o["hash"] === "string" && HASH.test(o["hash"]) && Number.isSafeInteger(o["seq"]) && (o["seq"] as number) >= 1;
}

/** The plain text of a record (canonical: keys sorted). */
export function anchorRecordText(head: AnchorHead): string {
  if (!isAnchorHead({ seq: head.seq, hash: head.hash })) throw new Error("bad anchor");
  return `${ANCHOR_RECORD_TAG} {"hash":"${head.hash}","seq":${head.seq}}`;
}

/** Parse a record's plain text strictly; anything else is `undefined`. */
export function parseAnchorRecord(text: string): AnchorHead | undefined {
  const m = RECORD.exec(text);
  if (m === null) return undefined;
  const seq = Number(m[2]);
  return Number.isSafeInteger(seq) ? { seq, hash: m[1] as string } : undefined;
}

export function createAnchorStore(cipher: AnchorCipher, file: AnchorFile): AnchorStore {
  const secure = (): boolean => {
    try {
      return cipher.status() === "secure";
    } catch {
      return false;
    }
  };
  return {
    async read(): Promise<AnchorRead> {
      if (!secure()) return { kind: "unavailable", reason: "insecure_backend" };
      let data: Uint8Array | null;
      try {
        data = await file.read();
      } catch {
        return { kind: "unavailable", reason: "read_failed" };
      }
      if (data === null) return { kind: "absent" };
      let text: string;
      try {
        text = cipher.decrypt(data);
      } catch {
        return { kind: "unavailable", reason: "decrypt_failed" };
      }
      const head = typeof text === "string" ? parseAnchorRecord(text) : undefined;
      return head === undefined ? { kind: "unavailable", reason: "corrupt" } : { kind: "anchor", head };
    },
    async write(head: AnchorHead): Promise<void> {
      if (!secure()) throw new Error("anchor backend not secure");
      const data = cipher.encrypt(anchorRecordText(head));
      await file.write(data);
    },
  };
}
