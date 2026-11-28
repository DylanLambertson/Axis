// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { realpath, stat, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { APP_HOST, APP_SCHEME } from "./stable-ids.js";
import { securityHeaders } from "./csp.js";

/**
 * The app scheme handler (ADR 0011 Decision 2): serves the renderer bundle from one fixed root directory for `axis-app://shell/`.
 * Main wires `handle` into `protocol.handle(APP_SCHEME, ...)` and turns the result into a `Response`.
 *
 * - Only `GET` and `HEAD`, only the app host, no credentials, no port. The query and fragment are ignored.
 * - Every path segment must match a strict allow-list: letters, digits and `._+@-`, starting with a letter or digit and not
 *   ending with a dot. That refuses `..`, `.`, hidden files, percent-encoding (so no encoded `/`, `\` or NUL), `:` (Windows drive
 *   and stream names), spaces and empty segments. Windows device names (`CON`, `NUL`, `COM1`, ...) are refused too.
 * - Only extensions in the MIME map are served; the type comes from the map, never from the file, and `nosniff` is set.
 * - The file is resolved with `realpath` and must be a regular file strictly inside the real bundle root, so a link inside the
 *   bundle cannot point out of it.
 * - Every response, error or not, carries the CSP and the other security headers; an error body is fixed text and never names
 *   the path.
 */

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+@-]{0,127}$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;
const MAX_SEGMENTS = 16;
/** The largest file served (the Monaco chunk is the biggest; well below this). */
export const MAX_APP_FILE_BYTES = 32 * 1024 * 1024;

/** Extension (lower case, no dot) to Content-Type. Anything else is not found. */
export const APP_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
});

export type AppPathRefusal = 400 | 404 | 405;

/** The bundle-relative segments and the Content-Type of a request, or the status to answer. Pure. */
export function resolveAppPath(url: string, method: string): { readonly ok: true; readonly segments: readonly string[]; readonly contentType: string } | { readonly ok: false; readonly status: AppPathRefusal } {
  if (method !== "GET" && method !== "HEAD") return { ok: false, status: 405 };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, status: 400 };
  }
  if (u.protocol !== `${APP_SCHEME}:` || u.hostname !== APP_HOST || u.username !== "" || u.password !== "" || u.port !== "") return { ok: false, status: 400 };
  const path = u.pathname === "/" || u.pathname === "" ? "/index.html" : u.pathname;
  if (!path.startsWith("/")) return { ok: false, status: 400 };
  const segments = path.slice(1).split("/");
  if (segments.length > MAX_SEGMENTS) return { ok: false, status: 404 };
  for (const s of segments) {
    if (!SEGMENT.test(s) || s.endsWith(".") || WINDOWS_DEVICE.test(s)) return { ok: false, status: 404 };
  }
  const last = segments[segments.length - 1] as string;
  const dot = last.lastIndexOf(".");
  const ext = dot <= 0 ? "" : last.slice(dot + 1).toLowerCase();
  const contentType = Object.hasOwn(APP_MIME_TYPES, ext) ? APP_MIME_TYPES[ext] : undefined;
  if (contentType === undefined) return { ok: false, status: 404 };
  return { ok: true, segments: Object.freeze(segments), contentType };
}

/** The file access the handler needs; `nodeAppFiles()` in production, a fake in tests. */
export interface AppFiles {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile(): boolean; readonly size: number }>;
  readFile(path: string): Promise<Uint8Array>;
}

export function nodeAppFiles(): AppFiles {
  return { realpath: (p) => realpath(p), stat: (p) => stat(p), readFile: (p) => readFile(p) };
}

export interface AppResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Null for `HEAD`. An error's body is fixed text. */
  readonly body: Uint8Array | null;
}

export interface AppSchemeOptions {
  /** The bundle root main computed from its own install location; never from a renderer or the environment. */
  readonly root: string;
  /** `buildCsp(...)`. */
  readonly csp: string;
  readonly files?: AppFiles;
  /** Closed reasons only, never the path. */
  readonly onRefused?: (status: number) => void;
}

const STATUS_TEXT: Readonly<Record<number, string>> = Object.freeze({ 400: "Bad request", 404: "Not found", 405: "Method not allowed" });

export function createAppSchemeHandler(options: AppSchemeOptions): { handle(request: { readonly url: string; readonly method: string }): Promise<AppResponse> } {
  const files = options.files ?? nodeAppFiles();
  const base = securityHeaders(options.csp);
  let realRoot: Promise<string> | undefined;
  // The real root is resolved once; a failure is not cached, so a root that appears later is served.
  const rootPath = (): Promise<string> => {
    if (realRoot === undefined) {
      const p = files.realpath(options.root);
      realRoot = p;
      p.catch(() => {
        if (realRoot === p) realRoot = undefined;
      });
    }
    return realRoot;
  };
  const refuse = (status: AppPathRefusal): AppResponse => {
    options.onRefused?.(status);
    return {
      status,
      headers: Object.freeze({ ...base, "Content-Type": "text/plain; charset=utf-8" }),
      body: new TextEncoder().encode(STATUS_TEXT[status] ?? "Error"),
    };
  };
  return {
    async handle(request) {
      const r = resolveAppPath(request.url, request.method);
      if (!r.ok) return refuse(r.status);
      try {
        const root = await rootPath();
        const real = await files.realpath(join(root, ...r.segments));
        if (!real.startsWith(`${root}${sep}`)) return refuse(404);
        const st = await files.stat(real);
        if (!st.isFile() || st.size > MAX_APP_FILE_BYTES) return refuse(404);
        const headers = Object.freeze({ ...base, "Content-Type": r.contentType });
        if (request.method === "HEAD") return { status: 200, headers, body: null };
        const body = await files.readFile(real);
        if (body.byteLength > MAX_APP_FILE_BYTES) return refuse(404);
        return { status: 200, headers, body };
      } catch {
        // A missing file, a broken link or an unreadable root: not found, with nothing about why.
        return refuse(404);
      }
    },
  };
}
