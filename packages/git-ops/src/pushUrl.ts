// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// GIT-7: which URLs Axis will push to. The pty-side `protocol.*` allow-list in push.ts enforces the same set inside git.
import { denied, redactUrls } from "./errors.js";

/** The transports a push may use. `file` is a local path or file:// URL the user configured as a remote. */
export const PUSH_PROTOCOLS = ["https", "ssh", "git", "file"] as const;

/** `-c` pairs placed before `push`: everything is refused except the allow-listed transports (ext, fd and helpers included). */
export function protocolAllowList(): string[] {
  return ["-c", "protocol.allow=never", ...PUSH_PROTOCOLS.flatMap((p) => ["-c", `protocol.${p}.allow=always`])];
}

/** Throws E_POLICY_DENIED for a push URL that uses a remote helper, an unlisted transport or embedded credentials. */
export function assertPushUrl(url: string): void {
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(url)) throw denied("the remote uses a transport that Axis does not push to");
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1]?.toLowerCase();
  if (scheme !== undefined && !(PUSH_PROTOCOLS as readonly string[]).includes(scheme)) {
    throw denied(`the remote uses the ${scheme.slice(0, 20)} transport, which Axis does not push to`);
  }
  // Credentials belong to the user's credential helper or ssh keys, never to a URL: that includes a token used as the
  // user name (https://TOKEN@host/...). Only ssh keeps a user name, because `git@host` is how ssh remotes are written.
  const userinfo = /^[a-z][a-z0-9+.-]*:\/\/([^/\s]*)@/i.exec(url)?.[1];
  if (userinfo !== undefined && (scheme !== "ssh" || userinfo.includes(":"))) {
    throw denied(`the remote URL embeds credentials: ${redactUrls(url)}`);
  }
}
