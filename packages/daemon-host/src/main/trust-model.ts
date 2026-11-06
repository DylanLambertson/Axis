// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * The repository side of `trust.check` (ticket X1c, `docs/design/main-answers.md` section 3.3): is a repository path equal to or
 * inside a folder the Workspace Trust model marks trusted? The model is upstream's application-shared storage value
 * `content.trust.model.key`, `{ uriTrustInfo: [{ uri, trusted }] }`, where `uri` is a serialised `URI` (`scheme`, `authority`,
 * `path`) or its string form. Only local `file:` URIs without an authority count. Anything that does not parse is no trust.
 * Comparison is per path segment, case-insensitive on macOS and Windows. Pure.
 */

export const TRUST_STORAGE_KEY = "content.trust.model.key";
const MAX_MODEL_CHARS = 1_048_576;
const MAX_ENTRIES = 10_000;

type Platform = "darwin" | "linux" | "win32";

/** The local path of a trusted `file:` URI in upstream form, or `undefined`. */
function filePathOf(uri: unknown, platform: Platform): string | undefined {
  let scheme: unknown;
  let authority: unknown;
  let path: unknown;
  if (typeof uri === "string") {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      return undefined;
    }
    scheme = u.protocol.replace(/:$/, "");
    authority = u.host;
    try {
      path = decodeURIComponent(u.pathname);
    } catch {
      return undefined;
    }
  } else if (typeof uri === "object" && uri !== null) {
    ({ scheme, authority, path } = uri as Record<string, unknown>);
  } else return undefined;
  if (scheme !== "file" || (authority !== undefined && authority !== "") || typeof path !== "string" || !path.startsWith("/")) return undefined;
  if (platform === "win32") {
    const m = /^\/([A-Za-z]:)(\/.*)?$/.exec(path);
    if (m === null) return undefined;
    return `${m[1]}${(m[2] ?? "/").replace(/\//g, "\\")}`;
  }
  return path;
}

/** The trusted local folders of a stored model; `[]` for anything that does not parse. */
export function trustedFolders(model: string | undefined, platform: Platform): string[] {
  if (typeof model !== "string" || model.length > MAX_MODEL_CHARS) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(model);
  } catch {
    return [];
  }
  const list = (parsed as { uriTrustInfo?: unknown } | null)?.uriTrustInfo;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list.slice(0, MAX_ENTRIES)) {
    if (typeof entry !== "object" || entry === null || (entry as { trusted?: unknown }).trusted !== true) continue;
    const p = filePathOf((entry as { uri?: unknown }).uri, platform);
    if (p !== undefined) out.push(p);
  }
  return out;
}

/** The segments of an absolute path, or `undefined` for a relative one, one with `.`/`..` segments or a NUL. */
function segments(path: string, platform: Platform): string[] | undefined {
  if (path.includes("\0")) return undefined;
  const fold = platform === "linux" ? path : path.toLowerCase();
  let rest: string;
  let root: string;
  if (platform === "win32") {
    const m = /^([a-z]:)[\\/](.*)$/i.exec(fold);
    if (m === null) return undefined;
    root = (m[1] as string).toLowerCase();
    rest = m[2] as string;
  } else {
    if (!fold.startsWith("/")) return undefined;
    root = "";
    rest = fold.slice(1);
  }
  const parts = rest.split(platform === "win32" ? /[\\/]+/ : /\/+/).filter((s) => s !== "");
  if (parts.some((s) => s === "." || s === "..")) return undefined;
  return [root, ...parts];
}

/** True when `path` is equal to or inside one of `folders`. */
export function isPathTrusted(path: string, folders: readonly string[], platform: Platform): boolean {
  const target = segments(path, platform);
  if (target === undefined) return false;
  return folders.some((f) => {
    const folder = segments(f, platform);
    return folder !== undefined && folder.length <= target.length && folder.every((s, i) => s === target[i]);
  });
}
