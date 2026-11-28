// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { isAppOrigin } from "./stable-ids.js";

/**
 * The `webRequest` scheme filter of the app windows' session (ADR 0011 Decision 2): every request is cancelled unless it is for the
 * app origin, so the renderer has no network at all. Egress stays the daemon's (NET-GATE, the egress client). The CSP refuses the
 * same loads first; this filter is the second, independent layer, and it also covers what the CSP does not name.
 * `data:`, `blob:` and `filesystem:` never reach `onBeforeRequest` (they are not network): the CSP alone covers them.
 *
 * Only an unpackaged build may also allow `devtools:` (the DevTools front end); a packaged build has no DevTools (G-28,
 * `appWebPreferences`).
 */

/** Matches every URL Chromium reports to `onBeforeRequest`. */
export const WEB_REQUEST_FILTER = Object.freeze({ urls: Object.freeze(["<all_urls>"]) });

export function webRequestAllowed(url: unknown, options: { readonly devtools: boolean }): boolean {
  if (typeof url !== "string") return false;
  if (isAppOrigin(url)) return true;
  if (!options.devtools) return false;
  try {
    return new URL(url).protocol === "devtools:";
  } catch {
    return false;
  }
}

export interface WebRequestLike {
  onBeforeRequest(filter: { urls: readonly string[] }, listener: (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void): void;
}

/** Installs the filter. `onRefused` gets the refused URL's scheme only (for the closed-event log), never the URL. */
export function installSchemeFilter(webRequest: WebRequestLike, options: { readonly devtools: boolean; readonly onRefused?: (scheme: string) => void }): void {
  webRequest.onBeforeRequest(WEB_REQUEST_FILTER, (details, callback) => {
    const ok = webRequestAllowed(details?.url, options);
    if (!ok) options.onRefused?.(schemeOf(details?.url));
    callback({ cancel: !ok });
  });
}

const SCHEME = /^([a-z][a-z0-9+.-]{0,31}):/i;
const schemeOf = (url: unknown): string => (typeof url === "string" ? (SCHEME.exec(url)?.[1]?.toLowerCase() ?? "invalid") : "invalid");
