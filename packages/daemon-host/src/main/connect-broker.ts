// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { base64url, type MainIdentity } from "./attest-sign.js";

/**
 * Main's half of the renderer connect handshake (ticket X1b, `docs/design/main-answers.md` section 2, ADR 0003 D1.3, threat
 * model EL-3). The overlay turns a `vscode:axisConnect` IPC event into a `ConnectSender` (what main itself knows about the
 * sender: never anything the renderer said, except the nonce) and calls `connect`. The broker checks the sender, rate limits per
 * window, builds the identity, and asks the supervisor to sign and post it with one end of a fresh channel; the other end goes
 * back to the renderer. Every refusal is a closed reason, both ends of a channel that was made are closed, and nothing throws.
 * Runs in Electron main: no `electron`, no `@axis/*` package, no Node module.
 */

export const CONNECT_REFUSALS = ["bad_nonce", "not_code_window", "bad_frame", "not_main_frame", "destroyed", "rate_limited", "not_ready"] as const;
export type ConnectRefusal = (typeof CONNECT_REFUSALS)[number];

/** What main knows about the sender of `vscode:axisConnect`. */
export interface ConnectSender {
  /** `IWindowsMainService.getWindowByWebContents(sender)?.id`: undefined for an auxiliary window, a webview or anything else. */
  readonly codeWindowId: number | undefined;
  /** `event.senderFrame?.url`. */
  readonly frameUrl: string | undefined;
  /** `event.senderFrame === event.sender.mainFrame`. */
  readonly isMainFrame: boolean;
  /** `event.sender.isDestroyed()`. */
  readonly destroyed: boolean;
}

/** Two entangled ports (Electron `MessageChannelMain`). */
export interface PortPair<P> {
  readonly daemonEnd: P;
  readonly rendererEnd: P;
}

export interface ConnectBrokerOptions<P> {
  readonly supervisor: { connect(identity: MainIdentity, port: unknown): boolean };
  readonly createChannel: () => PortPair<P>;
  readonly closePort: (port: P) => void;
  readonly randomBytes: (n: number) => Uint8Array;
  /** The workbench URLs main loads (`FileAccess.asBrowserUri(...workbench.html)`, and the `-dev` one unbuilt). */
  readonly workbenchUrls: readonly string[];
  /** The window's Workspace Trust answer now; `false` when main cannot tell. Must not throw (a throw is `false`). */
  readonly windowTrusted: (codeWindowId: number) => boolean;
  /** Monotonic milliseconds (the rate limit). */
  readonly now: () => number;
  readonly onEvent?: (event: "connect_refused" | "connected", reason?: ConnectRefusal) => void;
  readonly burst?: number;
  readonly refillPerMinute?: number;
  readonly maxWindows?: number;
}

export type ConnectOutcome<P> = { readonly ok: true; readonly port: P; readonly windowId: string } | { readonly ok: false; readonly reason: ConnectRefusal };

const NONCE = /^[A-Za-z0-9-]{1,64}$/;
const DEFAULT_BURST = 5;
const DEFAULT_REFILL_PER_MINUTE = 10;
const DEFAULT_MAX_WINDOWS = 256;

/** The identity's window id for a code window. */
export const windowIdOf = (codeWindowId: number): string => `w${codeWindowId}`;

/** True when `url` is one of the expected workbench URLs: same scheme, host and path, no credentials or port; query and fragment ignored. */
export function isWorkbenchFrame(url: string | undefined, expected: readonly string[]): boolean {
  if (typeof url !== "string" || url === "") return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "vscode-file:" || u.host !== "vscode-app" || u.username !== "" || u.password !== "" || u.port !== "") return false;
  return expected.some((e) => {
    try {
      const x = new URL(e);
      return x.protocol === u.protocol && x.host === u.host && x.pathname === u.pathname;
    } catch {
      return false;
    }
  });
}

interface Bucket {
  tokens: number;
  at: number;
}

export class ConnectBroker<P> {
  readonly #o: ConnectBrokerOptions<P>;
  readonly #burst: number;
  readonly #refillMs: number;
  readonly #maxWindows: number;
  readonly #buckets = new Map<number, Bucket>();
  /** Windows that hold at least one brokered connection: window id -> code window id. */
  readonly #windows = new Map<string, number>();

  constructor(options: ConnectBrokerOptions<P>) {
    this.#o = options;
    this.#burst = options.burst ?? DEFAULT_BURST;
    this.#refillMs = 60_000 / (options.refillPerMinute ?? DEFAULT_REFILL_PER_MINUTE);
    this.#maxWindows = options.maxWindows ?? DEFAULT_MAX_WINDOWS;
  }

  /** Check the sender and broker a connection. Never throws. */
  connect(sender: ConnectSender, nonce: unknown): ConnectOutcome<P> {
    const refused = (reason: ConnectRefusal): ConnectOutcome<P> => {
      this.#emit("connect_refused", reason);
      return { ok: false, reason };
    };
    if (typeof nonce !== "string" || !NONCE.test(nonce)) return refused("bad_nonce");
    const id = sender.codeWindowId;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) return refused("not_code_window");
    if (!isWorkbenchFrame(sender.frameUrl, this.#o.workbenchUrls)) return refused("bad_frame");
    if (sender.isMainFrame !== true) return refused("not_main_frame");
    if (sender.destroyed !== false) return refused("destroyed");
    if (!this.#take(id)) return refused("rate_limited");

    let trusted = false;
    try {
      trusted = this.#o.windowTrusted(id) === true;
    } catch {
      trusted = false;
    }
    const windowId = windowIdOf(id);
    let pair: PortPair<P>;
    try {
      pair = this.#o.createChannel();
    } catch {
      return refused("not_ready");
    }
    let sent = false;
    try {
      const bytes = this.#o.randomBytes(16);
      if (bytes.length === 16) {
        const identity: MainIdentity = { connectionId: base64url(bytes), windowId, actorId: "local-user", actor: "user", trusted, clientKind: "desktop" };
        sent = this.#o.supervisor.connect(identity, pair.daemonEnd);
      }
    } catch {
      sent = false;
    }
    if (!sent) {
      this.#close(pair.daemonEnd);
      this.#close(pair.rendererEnd);
      return refused("not_ready");
    }
    this.#windows.set(windowId, id);
    this.#emit("connected");
    return { ok: true, port: pair.rendererEnd, windowId };
  }

  /** The code window id behind an identity's window id, while that window is open and has connected. */
  codeWindowOf(windowId: string): number | undefined {
    return this.#windows.get(windowId);
  }

  /** Main closed the window: it can no longer be the target of a dialog or a trust answer, and its bucket goes. */
  windowClosed(codeWindowId: number): void {
    this.#windows.delete(windowIdOf(codeWindowId));
    this.#buckets.delete(codeWindowId);
  }

  #take(id: number): boolean {
    const now = this.#o.now();
    let b = this.#buckets.get(id);
    if (b === undefined) {
      if (this.#buckets.size >= this.#maxWindows && !this.#evictFull(now)) return false;
      b = { tokens: this.#burst, at: now };
      this.#buckets.set(id, b);
    }
    const elapsed = Math.max(0, now - b.at);
    b.tokens = Math.min(this.#burst, b.tokens + elapsed / this.#refillMs);
    b.at = Math.max(b.at, now);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Drop the oldest bucket that has refilled completely (forgetting it changes nothing). None: the table is full, refuse. */
  #evictFull(now: number): boolean {
    for (const [id, b] of this.#buckets) {
      if (b.tokens + Math.max(0, now - b.at) / this.#refillMs >= this.#burst) {
        this.#buckets.delete(id);
        return true;
      }
    }
    return false;
  }

  #close(port: P): void {
    try {
      this.#o.closePort(port);
    } catch {
      // already closed
    }
  }

  #emit(event: "connect_refused" | "connected", reason?: ConnectRefusal): void {
    try {
      this.#o.onEvent?.(event, reason);
    } catch {
      // an observer never changes the outcome
    }
  }
}
