// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The content rules. Every pattern is built from literals and character classes with a bound on every repetition
// (whitespace included, at most 64), and no group that is repeated holds a repetition, so matching is linear in the text for
// a fixed pattern (each start position costs at most a few hundred steps) and no match is longer than the window overlap.
// A match that a rule rejects (a decoy) is skipped one character on, never past the whole value, so a secret embedded in or
// after a decoy is still seen; the work spent on decoys is bounded by `Budget`, and running out of it makes the scan incomplete.
import { shannonEntropy } from "./entropy.js";

export interface ContentRule {
  /** The rule name reported in a finding; `nameOf` may refine it per match. */
  readonly rule: string;
  readonly re: RegExp;
  /** A match that fails the check is skipped (the search resumes one character on) and costs one unit of the scan's `Budget`. */
  readonly accept?: (m: RegExpExecArray) => boolean;
  readonly nameOf?: (m: RegExpExecArray) => string;
  /** A fixed credential format. Only these are tried on a base64 or hex decoded value. */
  readonly specific: boolean;
  /** Skipped in lock files, which are full of digests and ids. */
  readonly skipInLockFiles?: boolean;
}

/** Rejected matches left in this scan. Shared by every rule and window; `exhausted` makes the scan incomplete. */
export interface Budget {
  left: number;
  exhausted: boolean;
}

const DB_SCHEMES = /^(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver|cockroachdb|clickhouse|jdbc:[a-z0-9]+|ldaps?|smtps?)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A path: a root, `./`, `../` or `~/`, then segments, at least one of which is a lower-case word (see `isPathLike`).
const PATHLIKE = /^(?:\/|\.{1,2}\/|~\/)[\w.@+=-]*(?:\/[\w.@+=-]*)+$/;
const FLAG = /^--[a-z][a-z0-9-]*(?:=|$)/;
const DIGEST_WORDS = new Set(["sha", "hash", "digest", "checksum", "commit", "integrity", "etag", "fingerprint", "thumbprint", "rev", "oid", "md"]);
// A name word that ends in one of these (`secret`, `webhooksecret`, `tokens`, `oauth`) makes the name a secret name. A bare `key` does
// not: `hash_key` is a digest key name, and a random value under it is still reported by the generic rule.
const SECRET_KEY_NAME = /(?:api|access|secret|private|auth|signing|encryption|master|client|license|session)[^a-z]*key/;
const SECRET_SUFFIX = /(?:secrets?|tokens?|passwords?|passwds?|pwds?|credentials?|privates?|apikeys?|auth)$/;
// The SHAPE of code, not any bracket (generated passwords and Django keys hold brackets): a name or member chain directly
// followed by a call, an index or a block (with an optional generic), an optional chain, an arrow, or a chained `).name`.
const CODE_SHAPE = /^\(?[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*(?:<[\w$.,<> ]*>)?[([{]|\?\.[A-Za-z_$]|=>|[)\]]\??\.[A-Za-z_$]/;
// A regular expression literal: a slash, then an idiom no key has.
const REGEX_LITERAL = /^\/[^/]*(?:\\[A-Za-z]|\(\?|\[\^|\[[A-Za-z0-9]-[A-Za-z0-9])/;
const HEX = /^[0-9a-fA-F]+$/;
const SCREAMING = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const DOTTED = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/;
const SEGMENTED = /^[a-z][a-z0-9]*(?:[_.-][a-z0-9]+)+$/;
const PLACEHOLDER = /example|changeme|change-me|placeholder|your[-_ ]|^<|>$|xxxx|\*\*\*|dummy|sample|redacted|notasecret|insert|fixme|todo|\$\{|\{\{|%s|%\(/i;
const WEAK_PASSWORDS = new Set(["password", "passwd", "pass", "secret", "postgres", "mysql", "root", "admin", "test", "changeme", "example", "guest", "user", "username", "redis", "mongo"]);

/**
 * Does the identifier say the value is a digest? Whole words only (split on `_`, `-`, digits and camel case), so `shared`
 * and `hashicorp` are not `sha` and `hash`; and never when a word says secret, so `SHARED_SECRET` and `tokenHash` stay secrets.
 */
export function isDigestName(name: string): boolean {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  const words = spaced.split(/[^a-z]+/).filter(Boolean);
  return words.some((w) => DIGEST_WORDS.has(w)) && !words.some((w) => SECRET_SUFFIX.test(w)) && !SECRET_KEY_NAME.test(spaced);
}

function isPathLike(v: string): boolean {
  return PATHLIKE.test(v) && v.split("/").some((s) => /^[a-z][a-z._-]{2,}$/.test(s));
}

/** Does `v` look like generated key material rather than a word, a name, an id or a placeholder? */
export function looksRandom(v: string, name = ""): boolean {
  if (v.length < 16 || v.length > 512) return false;
  if (UUID.test(v) || PLACEHOLDER.test(v)) return false;
  if (/^(?:https?:|file:)/i.test(v) || v.includes("://") || v.includes("...") || CODE_SHAPE.test(v) || REGEX_LITERAL.test(v) || isPathLike(v) || FLAG.test(v)) return false;
  if (SCREAMING.test(v) || SEGMENTED.test(v) || DOTTED.test(v)) return false;
  if (!/[0-9]/.test(v) || !/[A-Za-z]/.test(v)) return false;
  const hex = HEX.test(v);
  // A 40 or 64 digit hex value is a git object id or a digest only under a name that says so (`isDigestName`). Under key,
  // secret, token or password names (private keys, AES keys, classic GitHub tokens, shared secrets) it is key material.
  if (hex && (v.length === 40 || v.length === 64) && isDigestName(name)) return false;
  return shannonEntropy(v) >= (hex ? 3.0 : 3.5);
}

function decodesToBasicCredentials(b64: string): boolean {
  if (b64.length % 4 !== 0) return false;
  const d = Buffer.from(b64, "base64").toString("latin1");
  return /^[\x20-\x7e]{3,128}$/.test(d) && /^[^:]+:[^:]/.test(d);
}

function urlPasswordOk(m: RegExpExecArray): boolean {
  const user = m[2] ?? "";
  const pw = m[3] ?? "";
  if (pw.length < 3 || PLACEHOLDER.test(pw) || /^[$%{*[(]/.test(pw)) return false;
  const lower = pw.toLowerCase();
  return lower !== user.toLowerCase() && !WEAK_PASSWORDS.has(lower);
}

const KEYWORD =
  "(api[_-]?key|(?:access|secret|private|auth|signing|encryption|master|client|license|session)[_-]?key|[A-Za-z0-9]{1,30}[_-]key|secret|token|passw(?:or)?d|pwd|credential)";

export const CONTENT_RULES: readonly ContentRule[] = Object.freeze([
  { rule: "private-key-block", specific: true, re: /-----BEGIN (?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----/g },
  { rule: "aws-access-key-id", specific: true, re: /(?<![A-Za-z0-9])(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA)[A-Z2-7]{16}(?![A-Za-z0-9])/g },
  { rule: "gcp-api-key", specific: true, re: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { rule: "github-token", specific: true, re: /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})(?![A-Za-z0-9_])/g },
  { rule: "gitlab-token", specific: true, re: /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,100}(?![A-Za-z0-9_-])/g },
  { rule: "slack-token", specific: true, re: /(?<![A-Za-z0-9])xox[abeoprs]-[A-Za-z0-9-]{10,200}(?![A-Za-z0-9-])/g },
  { rule: "slack-webhook", specific: true, re: /hooks\.slack\.com\/services\/T[A-Z0-9]{8,32}\/B[A-Z0-9]{8,32}\/[A-Za-z0-9]{20,64}/g },
  { rule: "stripe-key", specific: true, re: /(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{16,99}(?![A-Za-z0-9])/g },
  { rule: "npm-token", specific: true, re: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g },
  {
    rule: "ai-api-key",
    specific: true,
    re: /(?<![A-Za-z0-9])sk-(?:(?:ant-[A-Za-z0-9]{2,12}|proj|svcacct|admin)-[A-Za-z0-9_-]{20,200}|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})(?![A-Za-z0-9_-])/g,
  },
  { rule: "jwt", specific: true, re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,1300}\.eyJ[A-Za-z0-9_-]{10,1300}\.[A-Za-z0-9_-]{10,1300}(?![A-Za-z0-9_-])/g },
  { rule: "azure-shared-key", specific: true, re: /(?:AccountKey|SharedAccessKey)=[A-Za-z0-9+/]{43,100}={0,2}/g },
  {
    rule: "url-credentials",
    specific: true,
    re: /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{1,15}):\/\/([^\s:/@'"<>`]{1,64}):([^\s/@'"<>`]{3,128})@[^\s/'"<>`@]{1,255}/g,
    accept: urlPasswordOk,
    nameOf: (m) => (DB_SCHEMES.test(m[1] ?? "") ? "connection-string-password" : "url-credentials"),
  },
  {
    rule: "url-embedded-token",
    specific: true,
    re: /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{1,15}:\/\/([A-Za-z0-9_.~%-]{20,200})@[^\s/'"<>`@]{1,255}/g,
    accept: (m) => looksRandom(m[1] ?? ""),
  },
  {
    rule: "connection-string-password",
    specific: true,
    re: /(?:Server|Data Source|Host|Addr(?:ess)?)=[^;\n]{1,200};[^\n]{0,400}?(?:Password|Pwd)=([^;\s"'${}<>]{4,128})/gi,
    accept: (m) => !PLACEHOLDER.test(m[1] ?? "") && !WEAK_PASSWORDS.has((m[1] ?? "").toLowerCase()),
  },
  {
    rule: "bearer-token",
    specific: false,
    skipInLockFiles: true,
    re: /(?<![A-Za-z0-9])bearer[ \t]{1,64}([A-Za-z0-9._~+/-]{20,512})={0,2}/gi,
    accept: (m) => looksRandom(m[1] ?? ""),
  },
  {
    rule: "basic-auth-header",
    specific: false,
    skipInLockFiles: true,
    re: /(?<![A-Za-z0-9])basic[ \t]{1,64}([A-Za-z0-9+/]{12,512}={0,2})/gi,
    accept: (m) => decodesToBasicCredentials(m[1] ?? ""),
  },
  {
    rule: "generic-secret-assignment",
    specific: false,
    skipInLockFiles: true,
    // Keyword, a bounded name tail, an optional closing quote, the separator, an optional opening quote, then the value.
    re: new RegExp(`${KEYWORD}[A-Za-z0-9_.-]{0,40}["']?\\]?[ \\t]{0,64}(?::=|=>|[:=])(?![=>])[ \\t]{0,64}["'\`]?([^\\s"'\`,;]{16,256})`, "gi"),
    accept: (m) => looksRandom(m[2] ?? "", assignmentName(m)),
  },
]);

/** The identifier an assignment match hangs on: up to 40 name characters before the keyword, then the keyword and its tail. */
function assignmentName(m: RegExpExecArray): string {
  const value = m[2] ?? "";
  const before = /[A-Za-z0-9_.-]{0,40}$/.exec(m.input.slice(Math.max(0, m.index - 40), m.index))?.[0] ?? "";
  return before + m[0].slice(0, Math.max(0, m[0].length - value.length));
}

/** Lock files and checksum lists: digests and ids by design. The generic rules skip them; the fixed formats do not. */
export function isLockFile(path: string | undefined): boolean {
  if (path === undefined) return false;
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return /(?:^|[-.])(?:lock|lockb|sum)$|^(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|cargo\.lock|poetry\.lock|pipfile\.lock|gemfile\.lock|composer\.lock|go\.sum|flake\.lock|packages\.lock\.json)$/.test(base);
}

const ENV_TEMPLATE = /^(?:example|sample|template|tmpl|dist|defaults?|schema|local\.example)$/;

/** File names that hold credentials by convention. Deleted files are not asked about. */
export function isSensitiveFilename(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (base === ".env" || /^.{1,64}\.env$/.test(base)) return true;
  if (base.startsWith(".env.")) return !ENV_TEMPLATE.test(base.slice(5));
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(base)) return true;
  if (/\.(?:p12|pfx|jks|keystore|ppk|kdbx|tfstate)$/.test(base)) return true;
  return base === ".netrc" || base === "_netrc" || base === ".pgpass" || base === ".htpasswd" || base === ".git-credentials";
}

/**
 * First match of `rule` in `text` that passes its own check, or undefined. A rejected match costs one unit of `budget`
 * and the search resumes one character after its start, so what is embedded in the rejected value is still looked at.
 * Without budget the result is "no match" and `budget.exhausted` is set: the caller must treat the scan as incomplete.
 */
export function firstMatch(rule: ContentRule, text: string, budget: Budget): string | undefined {
  const re = rule.re;
  re.lastIndex = 0;
  for (;;) {
    const m = re.exec(text);
    if (m === null) return undefined;
    if (rule.accept === undefined || rule.accept(m)) {
      re.lastIndex = 0;
      return rule.nameOf === undefined ? rule.rule : rule.nameOf(m);
    }
    if (--budget.left < 0) {
      budget.exhausted = true;
      re.lastIndex = 0;
      return undefined;
    }
    re.lastIndex = m.index + 1;
  }
}
