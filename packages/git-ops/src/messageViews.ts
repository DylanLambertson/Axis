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
  eucjp: "euc-jp",
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

function decoder(label: string): InstanceType<typeof TextDecoder> | undefined {
  try {
    return new TextDecoder(ALIASES[label.toLowerCase()] ?? label, { fatal: true, ignoreBOM: true });
  } catch {
    return undefined;
  }
}

function decodes(bytes: Buffer, label: string): string | undefined {
  try {
    return decoder(label)?.decode(bytes);
  } catch {
    return undefined;
  }
}

/** ESC sequences (ESC, intermediate bytes, a final byte) and other control characters, as the ISO-2022 family shifts with them. */
function withoutShifts(bytes: Buffer): string {
  return bytes.toString("latin1").replace(/\u001b[\u0020-\u002f]*[\u0030-\u007e]?/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/**
 * `raw` is the commit object as the runner returned it, one character per byte (it was asked for `raw`; the scan
 * refuses a runner that did not say it complied).
 *
 * Git decodes the whole object, headers included, from the first `encoding` header, so that is what is scanned, once.
 * If that decode fails the commit is refused: git's decoder is not Node's (it accepts shift sequences Node rejects), so
 * a failure here does not mean git shows the text undecoded, and nothing weaker (the message alone, say) is scanned
 * instead. More than one `encoding` header is refused too (git never writes two, and each would cost a full decode).
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
  const text = decodes(bytes, label);
  if (text === undefined) return { views: [plain], undecodable: true };
  const views = [plain, text];
  // The ISO-2022 family is stateful, so also read the bytes with every shift sequence and control character removed.
  if (decoder(label)?.encoding === "iso-2022-jp") views.push(withoutShifts(bytes));
  return { views: [...new Set(views)], undecodable: false };
}
