// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { GitRefusal } from "../ports/git.js";

/** What an ssh host name (or alias) really connects to. */
export interface ResolvedSshHost {
  readonly hostname: string;
  readonly port: number;
  readonly user?: string;
}

/**
 * Resolves the host of an ssh push URL as written (an alias of the person's ssh configuration, or a real name) to where
 * it connects. It must not connect anywhere. It receives only a plain name (never a leading `-`) and the user name without any password; the
 * URL's own user and port win over what it answers. A throw, or an answer that is not a host and a port, refuses the push scan base
 * (fail closed): a destination that cannot be named cannot have a base of its own.
 */
export type SshHostResolver = (host: string, user: string | undefined, port: number | undefined) => Promise<ResolvedSshHost>;

const SSH_URL = /^(?:ssh|git\+ssh|ssh\+git):\/\/(?:([^@/]*)@)?(\[[^\]]*\]|[^:/]*)(?::(\d*))?(\/.*)?$/i;
// scp-like `[user@]host:path`: no slash before the first colon, and a one letter "host" is a drive letter, not a host.
const SCP_LIKE = /^(?:([^@/:]*)@)?([^/:]+):(.*)$/;

type Parsed =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "ssh"; readonly user?: string; readonly host: string; readonly port?: number; readonly path: string }
  | { readonly kind: "other"; readonly url: string };

function parse(url: string): Parsed {
  const ssh = SSH_URL.exec(url);
  if (ssh !== null) {
    const port = ssh[3] === undefined || ssh[3] === "" ? undefined : Number(ssh[3]);
    // Only the user name is kept: whatever follows a colon is a password, which never goes to a resolver, a key or a log.
    const user = ssh[1]?.split(":")[0];
    return { kind: "ssh", ...(user === undefined || user === "" ? {} : { user }), host: ssh[2] ?? "", ...(port === undefined ? {} : { port }), path: ssh[4] ?? "" };
  }
  if (/^file:\/\//i.test(url)) {
    try {
      return { kind: "path", path: decodeURIComponent(url.replace(/^file:\/\/[^/]*/i, "")) };
    } catch {
      throw new GitRefusal("E_INVALID_ARGUMENT");
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return { kind: "other", url };
  const scp = url.startsWith("/") || url.startsWith(".") ? null : SCP_LIKE.exec(url);
  if (scp !== null && scp[2] !== undefined && scp[2].length > 1) {
    return { kind: "ssh", ...(scp[1] === undefined || scp[1] === "" ? {} : { user: scp[1] }), host: scp[2], path: scp[3] ?? "" };
  }
  return { kind: "path", path: url };
}

function validHost(r: ResolvedSshHost): boolean {
  return typeof r.hostname === "string" && /^[^\s\0-\x1f\x7f]+$/.test(r.hostname) && Number.isInteger(r.port) && r.port >= 1 && r.port <= 65535 &&
    (r.user === undefined || (typeof r.user === "string" && /^[^\s\0-\x1f\x7f]*$/.test(r.user)));
}

/** One canonical text per push URL, equal only when two URLs go to the same place. Never stored: only its hash is. */
async function canonical(url: string, workTree: string, resolveSsh: SshHostResolver | undefined): Promise<string> {
  const p = parse(url);
  if (p.kind === "other") return `url\0${p.url}`;
  if (p.kind === "path") {
    // A symlink, `..` or a relative form is the same destination as the real directory; one that cannot be resolved is no destination.
    try {
      return `path\0${await realpath(resolve(workTree, p.path))}`;
    } catch {
      throw new GitRefusal("E_INVALID_ARGUMENT");
    }
  }
  // A host that ssh would read as an option, or that is not one name, is refused before anything sees it.
  if (p.host === "" || p.host.startsWith("-") || /[\s\0-\x1f\x7f]/.test(p.host) || (p.user !== undefined && (p.user.startsWith("-") || /[\s\0-\x1f\x7f]/.test(p.user))) ||
    (p.port !== undefined && !(Number.isInteger(p.port) && p.port >= 1 && p.port <= 65535))) {
    throw new GitRefusal("E_INVALID_ARGUMENT");
  }
  if (resolveSsh === undefined) return `ssh\0${p.user ?? ""}@${p.host.toLowerCase()}:${p.port ?? ""}\0${p.path}`;
  let r: ResolvedSshHost;
  try {
    r = await resolveSsh(p.host, p.user, p.port);
  } catch {
    throw new GitRefusal("E_INVALID_ARGUMENT");
  }
  if (typeof r !== "object" || r === null || !validHost(r)) throw new GitRefusal("E_INVALID_ARGUMENT");
  // As in ssh, what the URL names (user, port) wins over the configuration; the resolver supplies the rest.
  return `ssh\0${p.user ?? r.user ?? ""}@${r.hostname.toLowerCase()}:${p.port ?? r.port}\0${p.path}`;
}

/**
 * The scan-base key of a push: a SHA-256 over the sorted canonical destinations of the remote's push URLs. Two names for one
 * place share it (a trailing slash, `.git` suffix or the case of an https host is not folded: only extra misses, never a shared base), a path or ssh alias that now points somewhere else does not, and what cannot be resolved is refused.
 */
export async function pushTargetKey(urls: readonly string[], workTree: string, resolveSsh?: SshHostResolver): Promise<string> {
  const list = await Promise.all(urls.map((u) => canonical(u, workTree, resolveSsh)));
  return createHash("sha256").update(JSON.stringify(list.sort())).digest("hex");
}
