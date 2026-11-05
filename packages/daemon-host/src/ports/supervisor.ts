// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Unsubscribe } from "./common.js";

/**
 * The control channel to the supervisor (main, a test parent or a web server): the one plane whose messages are
 * supervisor-authenticated by construction (design section 6.3). It is deliberately untyped here: the message
 * unions are strict Zod schemas of the control layer (ticket H3), and every inbound message is `unknown` until
 * one of them accepts it. A client's byte stream is never delivered to this port.
 */
export interface SupervisorChannel {
  /** Send one message. Throws `E_UNAVAILABLE` when the channel is closed. */
  send(message: unknown): void;
  /** Receive messages, in order. */
  onMessage(handler: (message: unknown) => void): Unsubscribe;
  /** The channel closed (the supervisor went away). Called at most once. */
  onClose(handler: () => void): Unsubscribe;
}
