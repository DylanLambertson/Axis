// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PSH-1: a commit message is pushed as bytes, so a pattern scanner that reads UTF-8 text is bypassed by an encoding.
// This turns the raw commit object into every plain-text reading of it that a secret could hide behind.

export interface MessageViews {
  /** Text to hand the scanner. The first is the plain UTF-8 reading, and the only one for an ordinary message. */
  readonly views: readonly string[];
  /**
   * The object holds a NUL byte or bytes that are not valid UTF-8. Git itself never writes either into a message it
   * creates, so the object was built to avoid a scanner. The extra views are best effort; the caller refuses.
   */
  readonly undecodable: boolean;
}

const NON_BYTE = /[^\u0000-ÿ]/;

function isUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function evenPart(b: Buffer): Buffer {
  return b.subarray(0, b.length - (b.length % 2));
}

/**
 * `raw` is the commit object as the runner returned it: one character per byte when the runner honoured `raw`.
 * A string with a character above 0xFF was already decoded (a runner that ignored `raw`); its UTF-8 bytes are used,
 * and a replacement character in it means a byte was lost, so it counts as undecodable.
 */
export function messageViews(raw: string): MessageViews {
  const decoded = NON_BYTE.test(raw);
  const bytes = decoded ? Buffer.from(raw, "utf8") : Buffer.from(raw, "latin1");
  const plain = bytes.toString("utf8");
  const undecodable = bytes.includes(0) || !isUtf8(bytes) || (decoded && raw.includes("�"));
  const views = [plain];
  if (undecodable) {
    // NUL padding and UTF-16 of ASCII text (either byte order, with or without a BOM, at any alignment) read as the
    // text itself once the NULs go; stray invalid bytes are dropped the same way.
    views.push(plain.replace(/[\u0000�]/g, ""));
    // The message follows the first blank line; a UTF-16 message is aligned to it, a BOM and all.
    const split = bytes.indexOf("\n\n");
    const body = split < 0 ? bytes : bytes.subarray(split + 2);
    const bom = body.length >= 2 ? body.readUInt16BE(0) : 0;
    const text = evenPart(bom === 0xfeff || bom === 0xfffe ? body.subarray(2) : body);
    views.push(Buffer.from(text).toString("utf16le"), Buffer.from(text).swap16().toString("utf16le"));
  }
  return { views: [...new Set(views)], undecodable };
}
