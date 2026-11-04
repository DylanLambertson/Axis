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

function declaredEncodings(header: string): string[] {
  const out: string[] = [];
  for (const line of header.split("\n")) {
    const m = /^encoding (.+)$/.exec(line);
    if (m) out.push((m[1] as string).trim());
  }
  return out;
}

function decodes(bytes: Buffer, label: string): string | undefined {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * `raw` is the commit object as the runner returned it, one character per byte (it was asked for `raw`; the scan
 * refuses a runner that did not say it complied).
 */
export function messageViews(raw: string): MessageViews {
  const bytes = Buffer.from(raw, "latin1");
  const plain = bytes.toString("utf8");
  if (bytes.includes(0)) return { views: [plain], undecodable: true };
  const split = bytes.indexOf("\n\n");
  const header = (split < 0 ? bytes : bytes.subarray(0, split)).toString("latin1");
  const body = split < 0 ? Buffer.alloc(0) : bytes.subarray(split + 2);
  const labels = declaredEncodings(header).filter((l) => !UTF8.test(l));
  if (labels.length === 0) {
    return { views: [plain], undecodable: decodes(bytes, "utf-8") === undefined };
  }
  // A declared encoding changes what every reader sees (git decodes it when it shows the message), so the decoded text is
  // what must be scanned. The headers are ASCII; the body is the part that is in that encoding.
  const views = [plain];
  for (const label of labels) {
    const text = decodes(body, label);
    if (text === undefined) return { views: [plain], undecodable: true };
    views.push(text);
  }
  return { views: [...new Set(views)], undecodable: false };
}
