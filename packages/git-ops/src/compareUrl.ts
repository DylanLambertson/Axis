// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// GitHub compare URLs (threat model GIT-5). Only allow-listed hosts, parsed strictly from https, ssh and scp forms.
import { safeRef } from "./args.js";
import { invalid } from "./errors.js";

export interface CompareInput {
  readonly remoteUrl: string;
  readonly base: string;
  readonly head: string;
  /** Extra GitHub Enterprise hosts. github.com is always allowed. */
  readonly allowedHosts?: readonly string[];
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** Lower-case ASCII host: letters, digits, hyphens and dots only. No IDN, no punycode, no trailing dot. */
export function normaliseHost(host: string): string | undefined {
  const h = host.toLowerCase();
  if (h.length === 0 || h.length > 253) return undefined;
  const labels = h.split(".");
  if (labels.length < 2) return undefined;
  for (const l of labels) if (!LABEL.test(l) || l.startsWith("xn--")) return undefined;
  return h;
}

function ownerRepo(path: string): { owner: string; repo: string } | undefined {
  const parts = path.replace(/^\/+/, "").split("/");
  if (parts.length !== 2) return undefined;
  const owner = parts[0] as string;
  let repo = parts[1] as string;
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") return undefined;
  return { owner, repo };
}

function parseRemote(url: string): { host: string; owner: string; repo: string } | undefined {
  if (/[\s\\\u0000-\u001f\u007f-￿]/.test(url) || url.length > 512) return undefined;
  const scp = /^([A-Za-z0-9_.-]+)@([^:/]+):(.+)$/.exec(url);
  if (scp && !url.includes("://")) {
    if (scp[1] !== "git") return undefined;
    const host = normaliseHost(scp[2] as string);
    const or = ownerRepo(scp[3] as string);
    return host && or ? { host, ...or } : undefined;
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.search || u.hash || u.password) return undefined;
  if (u.protocol === "https:") {
    if (u.username || (u.port !== "" && u.port !== "443")) return undefined;
  } else if (u.protocol === "ssh:") {
    if (u.username !== "git" || (u.port !== "" && u.port !== "22")) return undefined;
  } else {
    return undefined;
  }
  // WHATWG URL lower-cases, punycodes and normalises the host; the raw text must already be clean ASCII.
  const rawHost = /^[a-z]+:\/\/(?:[^@/]*@)?([^:/]+)/i.exec(url)?.[1];
  const host = rawHost ? normaliseHost(rawHost) : undefined;
  const or = ownerRepo(u.pathname);
  return host && or && host === u.hostname.toLowerCase() ? { host, ...or } : undefined;
}

function encodeRef(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

/** The compare URL for a pull request, or throws E_INVALID_ARGUMENT when the remote is not an allowed GitHub host. */
export function compareUrl(input: CompareInput): string {
  const allowed = new Set(["github.com"]);
  for (const h of input.allowedHosts ?? []) {
    const n = normaliseHost(h);
    if (!n) throw invalid("an allowed host is not a plain ASCII host name");
    allowed.add(n);
  }
  const remote = parseRemote(input.remoteUrl);
  if (!remote || !allowed.has(remote.host)) throw invalid("the remote is not a supported GitHub repository URL");
  const base = safeRef(input.base, "base");
  const head = safeRef(input.head, "head");
  return `https://${remote.host}/${remote.owner}/${remote.repo}/compare/${encodeRef(base)}...${encodeRef(head)}`;
}
