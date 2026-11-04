// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PSH-1: a commit message is pushed as bytes, and git shows it decoded from the commit's `encoding` header, so a pattern
// scanner that reads the bytes as UTF-8 can be bypassed by a byte-level encoding. This turns the raw commit object into
// the text a reader would see. It does not catch valid-UTF-8 obfuscation (zero-width, bidi or fullwidth characters or
// control characters inside a key): the scan guards against accidental leaks, not against a determined author.

export interface MessageViews {
  /** Text to hand the scanner: the bytes read as UTF-8, plus the message decoded from its declared `encoding` when that is not UTF-8. */
  readonly views: readonly string[];
  /**
   * The message cannot be read reliably: it holds a NUL byte, or bytes that are invalid in the encoding it declares
   * (UTF-8 when it declares none), or it declares an encoding this runtime does not know. The caller refuses.
   */
  readonly undecodable: boolean;
}

const UTF8 = /^(?:utf-?8)$/i;

/** Labels git (through iconv) accepts that the WHATWG decoder does not know. */
const ALIASES: Readonly<Record<string, string>> = {
  cp932: "shift_jis",
  sjis: "shift_jis",
  eucjp: "euc-jp",
  "euc_jp": "euc-jp",
  cp936: "gbk",
  cp949: "euc-kr",
  euckr: "euc-kr",
  "iso-2022-jp-2": "iso-2022-jp",
};

/**
 * The `encoding` headers of a commit object, the way git reads them: only the header block (up to the first empty
 * line), a continuation line (leading space) belongs to the header above it, and the value is the rest of the line.
 */
function encodingHeaders(bytes: Buffer, end: number): string[] {
  const out: string[] = [];
  for (const line of bytes.subarray(0, end < 0 ? bytes.length : end).toString("latin1").split("\n")) {
    if (line.startsWith("encoding ")) out.push(line.slice(9).trim());
  }
  return out;
}

function decodes(bytes: Buffer, label: string): string | undefined {
  try {
    return new TextDecoder(ALIASES[label.toLowerCase()] ?? label, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * `raw` is the commit object as the runner returned it, one character per byte (it was asked for `raw`; the scan
 * refuses a runner that did not say it complied).
 *
 * Git decodes the whole object, headers included, from the first `encoding` header, so that is what is scanned, once.
 * More than one `encoding` header is refused (git never writes two, and each would cost a full decode).
 */
export function messageViews(raw: string): MessageViews {
  const bytes = Buffer.from(raw, "latin1");
  const plain = bytes.toString("utf8");
  if (bytes.includes(0)) return { views: [plain], undecodable: true };
  const split = bytes.indexOf("\n\n");
  const labels = encodingHeaders(bytes, split);
  if (labels.length > 1) return { views: [plain], undecodable: true };
  const label = labels[0];
  if (label === undefined || UTF8.test(label)) {
    return { views: [plain], undecodable: decodes(bytes, "utf-8") === undefined };
  }
  // Where the headers are not in that encoding, git shows them as they are (the plain reading) and decodes only the message.
  const text = decodes(bytes, label) ?? (split < 0 ? undefined : decodes(bytes.subarray(split + 2), label));
  if (text === undefined) return { views: [plain], undecodable: true };
  return { views: text === plain ? [plain] : [plain, text], undecodable: false };
}
