// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * `openExternal` is decided in main (EL-5; ADR 0011 Decision 2). The renderer sends only a URL; main does not take its word about
 * where the link came from (run output, a message, a Monaco hover, an xterm.js OSC 8 link or a page), so EVERY link gets main's
 * confirmation with its full URL before anything opens.
 *
 * - Only `http:`, `https:` and `mailto:`. `file:`, `javascript:`, the app scheme and every custom scheme are refused.
 * - The raw text must be printable ASCII without spaces, at most 2048 characters: no control, bidirectional or look-alike
 *   characters can reach the dialog. A renderer passes `new URL(x).href`, which is already ASCII (punycode hosts, percent-encoded
 *   paths).
 * - `http(s)` needs a host and no user name or password (`https://bank.example@evil.example/` is refused).
 * - The dialog shows the normalised `href`, the one string that is then opened.
 * - One confirmation per window at a time; a second request while one waits is `busy`. The window must still be registered when
 *   the user answers, or nothing opens.
 * - The confirmation is a main dialog outside the challenge tiers (ADR 0011 Decision 5 item 2): its copy never calls itself an
 *   approval.
 * - Events carry closed reasons only, never the URL (a link can hold a token).
 */

export const EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);
export const MAX_EXTERNAL_URL = 2048;

export const EXTERNAL_REFUSALS = ["not_string", "too_long", "bad_chars", "bad_url", "scheme", "credentials", "no_host", "busy", "no_window", "declined", "failed"] as const;
export type ExternalRefusal = (typeof EXTERNAL_REFUSALS)[number];

export type ExternalDecision = { readonly ok: true; readonly href: string } | { readonly ok: false; readonly reason: ExternalRefusal };

const PRINTABLE = /^[\x21-\x7e]+$/;

/** Pure: is this a link main may offer to open, and the exact text to show and open. */
export function decideExternal(input: unknown): ExternalDecision {
  if (typeof input !== "string" || input === "") return { ok: false, reason: "not_string" };
  if (input.length > MAX_EXTERNAL_URL) return { ok: false, reason: "too_long" };
  if (!PRINTABLE.test(input)) return { ok: false, reason: "bad_chars" };
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  if (!EXTERNAL_PROTOCOLS.has(u.protocol)) return { ok: false, reason: "scheme" };
  if (u.protocol === "mailto:") {
    if (u.pathname === "") return { ok: false, reason: "no_host" };
  } else {
    if (u.username !== "" || u.password !== "") return { ok: false, reason: "credentials" };
    if (u.hostname === "") return { ok: false, reason: "no_host" };
  }
  const href = u.href;
  if (href.length > MAX_EXTERNAL_URL || !PRINTABLE.test(href)) return { ok: false, reason: "too_long" };
  return { ok: true, href };
}

/** What main's dialog shows. Cancel is the default and the cancel answer; the URL is the detail, in full. */
export interface ExternalConfirmation {
  readonly message: string;
  readonly detail: string;
  readonly buttons: readonly [string, string];
  readonly defaultId: 0;
  readonly cancelId: 0;
  readonly noLink: true;
}

export function externalConfirmation(href: string): ExternalConfirmation {
  return Object.freeze({
    message: "Open this link in your browser?",
    detail: href,
    buttons: Object.freeze(["Cancel", "Open link"]) as readonly [string, string],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
}

export interface ExternalOpenerOptions {
  /** Main's dialog for the window: true only for the Open button. A closed window must resolve false. */
  readonly confirm: (windowId: number, confirmation: ExternalConfirmation) => Promise<boolean>;
  /** `shell.openExternal(href)`. */
  readonly open: (href: string) => Promise<void>;
  /** The window registry's `has`. */
  readonly isWindow: (windowId: number) => boolean;
  readonly onEvent?: (event: "external_refused" | "external_opened", reason?: ExternalRefusal) => void;
}

export type ExternalOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: ExternalRefusal };

export function createExternalOpener(options: ExternalOpenerOptions): { open(windowId: number, input: unknown): Promise<ExternalOutcome>; windowClosed(windowId: number): void } {
  const waiting = new Set<number>();
  const refuse = (reason: ExternalRefusal): ExternalOutcome => {
    options.onEvent?.("external_refused", reason);
    return { ok: false, reason };
  };
  return {
    async open(windowId, input) {
      if (!options.isWindow(windowId)) return refuse("no_window");
      const d = decideExternal(input);
      if (!d.ok) return refuse(d.reason);
      if (waiting.has(windowId)) return refuse("busy");
      waiting.add(windowId);
      let yes: boolean;
      try {
        yes = (await options.confirm(windowId, externalConfirmation(d.href))) === true;
      } catch {
        return refuse("failed");
      } finally {
        waiting.delete(windowId);
      }
      if (!yes) return refuse("declined");
      if (!options.isWindow(windowId)) return refuse("no_window");
      try {
        await options.open(d.href);
      } catch {
        return refuse("failed");
      }
      options.onEvent?.("external_opened");
      return { ok: true };
    },
    windowClosed(windowId) {
      waiting.delete(windowId);
    },
  };
}
