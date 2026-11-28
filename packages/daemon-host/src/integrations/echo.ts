// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { secretForms } from "@axis/audit";

/**
 * RESPONSE-ECHO (docs/design/net-read-slice.md §4 step 8, §4.2): two scans for the credential in a response, both before any
 * reply, event or log.
 *
 * - The FIRST scan reads the exact bytes the egress client collected: every header name and value, and the whole body. The
 *   client sends no `Accept-Encoding` and refuses any `Content-Encoding` but identity, Node removes the chunk framing, and the
 *   body is joined before the scan, so a token split across chunks is whole here. The body is searched as bytes and as
 *   UTF-8 text, so an invalid byte sequence cannot split a match.
 * - The SECOND scan reads every key and string value of the parsed JSON tree, and of the reduced result: a token whose
 *   characters are all `\uXXXX` escapes is not in the raw bytes and only becomes the token after the parse.
 *
 * The needles are every form `secretForms` gives for the header value and for the token (raw, NFC and NFD, JSON-escaped,
 * URL-encoded in either case, hex in either case, base64 and base64url padded or not): the list the redactor scrubs, so the
 * listed forms cannot drift apart. Not found: a token split across two fields, base64 at a byte offset other than 0, or any
 * other transformation; that is the note's stated residual.
 */
export interface EchoNeedles {
  readonly text: readonly string[];
  readonly bytes: readonly Buffer[];
}

export function echoNeedles(header: string, token: string): EchoNeedles {
  const text = [...new Set([...secretForms(header), ...secretForms(token)])];
  return Object.freeze({ text: Object.freeze(text), bytes: Object.freeze(text.map((t) => Buffer.from(t, "utf8"))) });
}

const holds = (s: string, n: EchoNeedles): boolean => n.text.some((t) => s.includes(t));

/** The first scan: true when any header name or value, or the body, holds a needle. */
export function echoInRaw(headers: Readonly<Record<string, string | readonly string[] | undefined>>, body: Uint8Array, n: EchoNeedles): boolean {
  for (const [name, value] of Object.entries(headers)) {
    if (holds(name, n)) return true;
    for (const v of typeof value === "string" ? [value] : (value ?? [])) if (holds(v, n)) return true;
  }
  const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (n.bytes.some((b) => buf.indexOf(b) !== -1)) return true;
  return holds(buf.toString("utf8"), n);
}

/**
 * The second scan: true when any key or string in `value` holds a needle. Iterative, so no depth can exhaust the stack (the
 * parse is already capped at depth 64); anything that is not a plain JSON value is not walked into.
 */
export function echoInParsed(value: unknown, n: EchoNeedles): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") {
      if (holds(v, n)) return true;
    } else if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else if (typeof v === "object" && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        if (holds(k, n)) return true;
        stack.push(x);
      }
    }
  }
  return false;
}
