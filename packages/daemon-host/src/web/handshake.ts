// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash, timingSafeEqual } from "node:crypto";
import type { WebHostAddress } from "./config.js";

/**
 * The checks on a WebSocket upgrade request (ticket W1, `docs/design/web-host-entry.md` W-2 to W-4), run before any
 * `101` is written. Pure: it reads the request line and headers and returns either the accept value or a refusal with
 * a status and a closed reason. Every header that matters must appear exactly once.
 *
 * - `GET /axis/1` over HTTP/1.1, no query string (a token must never travel in a URL);
 * - `Upgrade: websocket`, `Connection` naming `upgrade`, `Sec-WebSocket-Version: 13`, a 16-byte `Sec-WebSocket-Key`;
 * - `Host` equal to the bound loopback literal or `localhost`, with the bound port (DNS rebinding);
 * - `Origin` equal to one configured origin (cross-site WebSocket hijacking; no cookie is ever read);
 * - `Sec-WebSocket-Protocol` exactly `axis.v1` and `axis.auth.<token>`; the token is compared by SHA-256 digest with
 *   `timingSafeEqual`. The answer selects `axis.v1`, so the token is never echoed.
 */

export const WS_PATH = "/axis/1";
export const SUBPROTOCOL = "axis.v1";
export const AUTH_PREFIX = "axis.auth.";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TOKEN = /^axis\.auth\.([A-Za-z0-9_-]{43})$/;
const KEY = /^[A-Za-z0-9+/]{22}==$/;

export const UPGRADE_REFUSALS = [
  "bad_method",
  "bad_path",
  "bad_version",
  "bad_upgrade",
  "bad_key",
  "bad_host",
  "bad_origin",
  "bad_protocol",
  "bad_token",
] as const;
export type UpgradeRefusal = (typeof UPGRADE_REFUSALS)[number];

export interface UpgradeRequest {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly httpVersion: string;
  /** Header name (lower case) to every value received, as Node's `headersDistinct` gives them. */
  readonly headersDistinct: Readonly<Record<string, readonly string[] | undefined>>;
}

export interface UpgradeContext {
  readonly host: WebHostAddress;
  readonly port: number;
  readonly allowedOrigins: ReadonlySet<string>;
  /** SHA-256 of the token's UTF-8 bytes. */
  readonly tokenDigest: Uint8Array;
}

export type UpgradeCheck =
  | { readonly ok: true; readonly accept: string }
  | { readonly ok: false; readonly status: 400 | 403 | 404 | 426; readonly reason: UpgradeRefusal };

export const digestToken = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();
export const acceptValue = (key: string): string => createHash("sha1").update(key + WS_GUID, "latin1").digest("base64");

function single(req: UpgradeRequest, name: string): string | undefined {
  const v = req.headersDistinct[name];
  return v !== undefined && v.length === 1 ? v[0] : undefined;
}

const tokens = (value: string): string[] => value.split(",").map((t) => t.trim().toLowerCase()).filter((t) => t !== "");

export function allowedHosts(host: WebHostAddress, port: number): ReadonlySet<string> {
  return new Set([host === "::1" ? `[::1]:${port}` : `127.0.0.1:${port}`, `localhost:${port}`]);
}

export function checkUpgrade(req: UpgradeRequest, ctx: UpgradeContext): UpgradeCheck {
  const refuse = (status: 400 | 403 | 404 | 426, reason: UpgradeRefusal): UpgradeCheck => ({ ok: false, status, reason });
  if (req.method !== "GET") return refuse(400, "bad_method");
  if (req.url !== WS_PATH) return refuse(404, "bad_path");
  if (req.httpVersion !== "1.1") return refuse(400, "bad_version");
  const upgrade = single(req, "upgrade");
  const connection = req.headersDistinct["connection"];
  if (upgrade === undefined || upgrade.toLowerCase() !== "websocket") return refuse(426, "bad_upgrade");
  if (connection === undefined || !connection.some((c) => tokens(c).includes("upgrade"))) return refuse(426, "bad_upgrade");
  if (single(req, "sec-websocket-version") !== "13") return refuse(426, "bad_version");
  const key = single(req, "sec-websocket-key");
  if (key === undefined || !KEY.test(key) || Buffer.from(key, "base64").length !== 16) return refuse(400, "bad_key");
  const host = single(req, "host");
  if (host === undefined || !allowedHosts(ctx.host, ctx.port).has(host.toLowerCase())) return refuse(403, "bad_host");
  const origin = single(req, "origin");
  if (origin === undefined || !ctx.allowedOrigins.has(origin)) return refuse(403, "bad_origin");
  const offered = (req.headersDistinct["sec-websocket-protocol"] ?? []).flatMap((v) => v.split(",")).map((t) => t.trim());
  const auth = offered.filter((t) => t.startsWith(AUTH_PREFIX));
  if (offered.length !== 2 || !offered.includes(SUBPROTOCOL) || auth.length !== 1) return refuse(403, "bad_protocol");
  const m = TOKEN.exec(auth[0] as string);
  if (m === null) return refuse(403, "bad_protocol");
  const given = digestToken(m[1] as string);
  if (ctx.tokenDigest.length !== given.length || !timingSafeEqual(given, ctx.tokenDigest)) return refuse(403, "bad_token");
  return { ok: true, accept: acceptValue(key) };
}
