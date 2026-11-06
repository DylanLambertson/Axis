// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * A minimal RFC 6455 server codec for the web host (ticket W1). It accepts only what the host needs and refuses the
 * rest with a close code: client frames must be masked, the RSV bits must be zero (no extension is ever negotiated),
 * messages are text in one frame (binary and fragmentation are refused), control frames are unfragmented and at most
 * 125 bytes, lengths use the shortest encoding, and text must be valid UTF-8. A frame whose header announces more than
 * `maxPayload` bytes is refused before its payload is buffered, so a decoder holds at most one frame plus one chunk.
 * Server frames are never masked.
 */

export const CLOSE = Object.freeze({
  normal: 1000,
  goingAway: 1001,
  protocol: 1002,
  unsupported: 1003,
  invalidData: 1007,
  policy: 1008,
  tooBig: 1009,
  internal: 1011,
  tryAgain: 1013,
});
export type CloseCode = (typeof CLOSE)[keyof typeof CLOSE];

export type InboundFrame =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "ping"; readonly payload: Buffer }
  | { readonly kind: "pong" }
  | { readonly kind: "close" };

/** A frame the codec refuses. Carries the close code only, never frame content. */
export class WsProtocolError extends Error {
  readonly closeCode: CloseCode;
  constructor(closeCode: CloseCode) {
    super("WebSocket frame refused");
    this.closeCode = closeCode;
  }
}

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
const MAX_CONTROL = 125;

export class FrameDecoder {
  readonly #maxPayload: number;
  readonly #utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  #buf: Buffer = Buffer.alloc(0);
  #done = false;

  constructor(maxPayload: number) {
    if (!Number.isSafeInteger(maxPayload) || maxPayload < MAX_CONTROL) throw new RangeError("maxPayload");
    this.#maxPayload = maxPayload;
  }

  /** Bytes held while waiting for the rest of a frame. */
  get buffered(): number {
    return this.#buf.length;
  }

  /**
   * Feed bytes from the socket; returns the complete frames in order. Throws `WsProtocolError` on the first refused
   * frame, after which the decoder accepts nothing more. After a close frame the rest is ignored.
   */
  push(chunk: Buffer): InboundFrame[] {
    if (this.#done) return [];
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    const out: InboundFrame[] = [];
    try {
      for (;;) {
        const frame = this.#next();
        if (frame === undefined) break;
        out.push(frame);
        if (frame.kind === "close") {
          this.#done = true;
          this.#buf = Buffer.alloc(0);
          break;
        }
      }
    } catch (e) {
      this.#done = true;
      this.#buf = Buffer.alloc(0);
      throw e;
    }
    return out;
  }

  #next(): InboundFrame | undefined {
    const b = this.#buf;
    if (b.length < 2) return undefined;
    const b0 = b[0] as number;
    const b1 = b[1] as number;
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    if ((b0 & 0x70) !== 0 || (b1 & 0x80) === 0) throw new WsProtocolError(CLOSE.protocol);
    const control = opcode >= 0x8;
    if (control && opcode !== OP_CLOSE && opcode !== OP_PING && opcode !== OP_PONG) throw new WsProtocolError(CLOSE.protocol);
    if (!control && opcode !== OP_TEXT && opcode !== OP_BINARY && opcode !== OP_CONT) throw new WsProtocolError(CLOSE.protocol);
    if (opcode === OP_BINARY || opcode === OP_CONT || (opcode === OP_TEXT && !fin)) throw new WsProtocolError(CLOSE.unsupported);
    if (control && !fin) throw new WsProtocolError(CLOSE.protocol);
    const len7 = b1 & 0x7f;
    let offset = 2;
    let length = len7;
    if (len7 === 126) {
      if (b.length < 4) return undefined;
      length = b.readUInt16BE(2);
      offset = 4;
      if (length < 126) throw new WsProtocolError(CLOSE.protocol);
    } else if (len7 === 127) {
      if (b.length < 10) return undefined;
      const big = b.readBigUInt64BE(2);
      offset = 10;
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new WsProtocolError(CLOSE.protocol);
      length = Number(big);
      if (length < 65_536) throw new WsProtocolError(CLOSE.protocol);
    }
    if (control && length > MAX_CONTROL) throw new WsProtocolError(CLOSE.protocol);
    if (length > this.#maxPayload) throw new WsProtocolError(CLOSE.tooBig);
    const total = offset + 4 + length;
    if (b.length < total) return undefined;
    const mask = b.subarray(offset, offset + 4);
    const payload = Buffer.from(b.subarray(offset + 4, total));
    for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] as number) ^ (mask[i & 3] as number);
    this.#buf = b.subarray(total);
    switch (opcode) {
      case OP_TEXT: {
        let text: string;
        try {
          text = this.#utf8.decode(payload);
        } catch {
          throw new WsProtocolError(CLOSE.invalidData);
        }
        return { kind: "text", text };
      }
      case OP_PING:
        return { kind: "ping", payload };
      case OP_PONG:
        return { kind: "pong" };
      default:
        if (length === 1) throw new WsProtocolError(CLOSE.protocol);
        return { kind: "close" };
    }
  }
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const header = n < 126 ? Buffer.alloc(2) : n < 65_536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  if (n < 126) header[1] = n;
  else if (n < 65_536) {
    header[1] = 126;
    header.writeUInt16BE(n, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([header, payload]);
}

export const encodeText = (text: string): Buffer => encodeFrame(OP_TEXT, Buffer.from(text, "utf8"));
export const encodePong = (payload: Buffer): Buffer => encodeFrame(OP_PONG, payload.subarray(0, MAX_CONTROL));
/** A close frame with a code and no reason text. */
export function encodeClose(code: CloseCode): Buffer {
  const p = Buffer.alloc(2);
  p.writeUInt16BE(code, 0);
  return encodeFrame(OP_CLOSE, p);
}
