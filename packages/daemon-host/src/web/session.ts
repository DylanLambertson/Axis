// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import type { Connection } from "@axis/daemon";
import { CLOSE, FrameDecoder, WsProtocolError, encodeClose, encodePong, encodeText, type CloseCode } from "./ws-codec.js";

/**
 * One browser socket after a successful upgrade, relayed onto one virtual connection of the supervisor's mux (ticket
 * W1, `docs/design/web-host-entry.md` W-6 and W-7). Browser text is parsed as JSON and handed to `connection.send`,
 * which wraps it as the `data` of a `frame` for this connection's id and checks it with the mux's plain-data walk, so a
 * browser message can never become a control message. Daemon messages are serialised and written as text frames.
 *
 * Every failure closes this one session with a closed code and no reason text: invalid frames (codec), invalid JSON
 * (1007), data the mux refuses (1008), a browser that does not read (1013, unsent bytes above `maxOutboundBytes`), the
 * daemon closing the connection (1000) or the channel going away (1001). Closing the session closes the connection,
 * and the reverse. Nothing here owns a timer; every listener added to the socket is removed when it ends.
 */

/** The parts of a `net.Socket` the session uses (structural, so this file loads no listener module). */
export interface SessionSocket {
  write(data: Buffer): boolean;
  end(callback?: () => void): unknown;
  destroy(): unknown;
  pause(): unknown;
  resume(): unknown;
  readonly writableLength: number;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "close" | "error" | "end", listener: () => void): unknown;
  off(event: "data", listener: (chunk: Buffer) => void): unknown;
  off(event: "close" | "error" | "end", listener: () => void): unknown;
}

export interface SessionOptions {
  readonly socket: SessionSocket;
  readonly connection: Connection;
  readonly maxFrameBytes: number;
  readonly maxOutboundBytes: number;
  /** Called after each message was handed to the connection (the host checks the channel backlog). */
  readonly forwarded: () => void;
  /** Called once when the session has ended, with the code it closed with. */
  readonly ended: (code: CloseCode) => void;
}

export class WebSession {
  readonly #o: SessionOptions;
  readonly #decoder: FrameDecoder;
  #closed = false;
  #paused = false;

  readonly #onData = (chunk: Buffer): void => this.#receive(chunk);
  readonly #onGone = (): void => this.close(CLOSE.goingAway, { graceful: false });

  constructor(options: SessionOptions) {
    this.#o = options;
    this.#decoder = new FrameDecoder(options.maxFrameBytes);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Attach to the socket and the connection; `head` is what the HTTP parser read past the upgrade request. */
  start(head: Buffer, paused: boolean): void {
    const { socket, connection } = this.#o;
    socket.on("data", this.#onData);
    socket.on("close", this.#onGone);
    socket.on("error", this.#onGone);
    socket.on("end", this.#onGone);
    connection.onMessage((m) => this.#toBrowser(m));
    // On a microtask: when the whole channel closed, the host's channel-close handler (1001) runs first.
    connection.onClose(() => queueMicrotask(() => this.close(CLOSE.normal)));
    if (paused) this.pause();
    if (head.length > 0) this.#receive(head);
  }

  /** Stop reading the socket (the channel backlog is full). */
  pause(): void {
    if (this.#closed || this.#paused) return;
    this.#paused = true;
    this.#o.socket.pause();
  }

  resume(): void {
    if (this.#closed || !this.#paused) return;
    this.#paused = false;
    this.#o.socket.resume();
  }

  /**
   * End the session: write a close frame (graceful) and end the socket, destroying it once it is flushed (or at once
   * when it cannot be flushed), and close the virtual connection. Idempotent.
   */
  close(code: CloseCode, { graceful = true }: { graceful?: boolean } = {}): void {
    if (this.#closed) return;
    this.#closed = true;
    const { socket, connection } = this.#o;
    socket.off("data", this.#onData);
    socket.off("close", this.#onGone);
    socket.off("error", this.#onGone);
    socket.off("end", this.#onGone);
    try {
      if (graceful) {
        socket.write(encodeClose(code));
        socket.end(() => void socket.destroy());
        if (socket.writableLength > 0) socket.destroy();
      } else socket.destroy();
    } catch {
      // The socket is already gone.
    }
    connection.close();
    this.#o.ended(code);
  }

  #receive(chunk: Buffer): void {
    if (this.#closed) return;
    let frames;
    try {
      frames = this.#decoder.push(chunk);
    } catch (e) {
      this.close(e instanceof WsProtocolError ? e.closeCode : CLOSE.protocol);
      return;
    }
    for (const f of frames) {
      if (this.#closed) return;
      if (f.kind === "close") return this.close(CLOSE.normal);
      if (f.kind === "ping") {
        this.#write(encodePong(f.payload));
        continue;
      }
      if (f.kind === "pong") continue;
      this.#fromBrowser(f.text);
    }
  }

  #fromBrowser(text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return this.close(CLOSE.invalidData);
    }
    try {
      this.#o.connection.send(value);
    } catch (e) {
      // The mux refused the data (shape, size, depth) or the channel is gone. Neither is echoed.
      return this.close(e instanceof AxisError && e.code === "E_UNAVAILABLE" ? CLOSE.goingAway : CLOSE.policy);
    }
    this.#o.forwarded();
  }

  #toBrowser(message: unknown): void {
    if (this.#closed) return;
    let text: string;
    try {
      text = JSON.stringify(message);
    } catch {
      return this.close(CLOSE.internal);
    }
    this.#write(encodeText(text));
  }

  #write(frame: Buffer): void {
    if (this.#closed) return;
    try {
      this.#o.socket.write(frame);
    } catch {
      return this.close(CLOSE.goingAway, { graceful: false });
    }
    // The mux has no per-connection flow control, so a browser that does not read is cut off rather than buffered.
    if (this.#o.socket.writableLength > this.#o.maxOutboundBytes) this.close(CLOSE.tryAgain, { graceful: false });
  }
}
