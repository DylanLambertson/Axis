// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// REF-1 (docs/design/snapshot-scan.md): every entry a snapshot adds is secret-scanned before any object is written. Nothing
// here keeps, returns or throws any part of the content, or anything the scanner said beyond a rule name and a line number.

import { createSecretScanner } from '@axis/secret-scan';
import { WorktreeError } from './errors.js';

/** One finding: never the matched text. Structurally `Finding` of `@axis/secret-scan`. */
export interface SnapshotFinding {
  readonly rule: string;
  readonly path?: string;
  readonly line?: number;
  /** For a commit message: the commit's id. */
  readonly commit?: string;
}

/** Structurally the `SecretScanner` that `createSecretScanner` returns: the host may pass the one it configures. */
export interface SnapshotScanner {
  readonly scan: (text: string, meta: { readonly part: 'patch' | 'message'; readonly binaryPaths?: readonly string[] }) => Promise<readonly SnapshotFinding[]>;
  readonly limits: { readonly maxBinaryBytes: number; readonly maxBytes: number };
}

/** One entry the snapshot would add. `120000` content is a symlink target. */
export interface ScanEntry {
  readonly rel: string;
  readonly mode: '100644' | '100755' | '120000';
  readonly bytes: Buffer;
}

/** Rules that say the scan could not see something, rather than that it saw a secret. */
const COVERAGE_RULES: ReadonlySet<string> = new Set(['binary-unscanned', 'scan-incomplete', 'scanner-error']);
/** File-level rules about the name or the file as a whole whose path holds no matched text. */
const PATH_SAFE_RULES: ReadonlySet<string> = new Set(['sensitive-filename', 'binary-unscanned', 'scan-incomplete', 'scanner-error']);
const RULE = /^[A-Za-z0-9._-]{1,64}$/;
const OID = /^[0-9a-f]{40,64}$/;
const MAX_REPORTED = 50;
/** git's binary test: a NUL in the first 8000 bytes. */
const BINARY_PROBE = 8000;
/** Whole-snapshot bound on scanning (each scanner call also has its own deadline). Over it: `snapshot-unscanned`. */
export const SNAPSHOT_SCAN_MS = 120_000;

let fallback: SnapshotScanner | undefined;
/** The scanner when the caller passes none: `refuse` mode, default limits. Never "no scan". */
export function defaultSnapshotScanner(): SnapshotScanner {
  fallback ??= createSecretScanner();
  return fallback;
}

const ESC: Readonly<Record<string, string>> = { '"': '\\"', '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' };

/** git's C-style quoting, where a name needs it, so a tab, newline or quote cannot end a header line early. */
export function quotePath(rel: string): string {
  if (!/[\x00-\x1f\x7f"\\]/.test(rel)) return rel;
  const body = rel.replace(/[\x00-\x1f\x7f"\\]/g, (c) => ESC[c] ?? `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`);
  return `"${body}"`;
}

export const isBinary = (bytes: Buffer): boolean => bytes.subarray(0, BINARY_PROBE).includes(0);

/**
 * What a NUL-bearing file may say as text: its bytes one character each, the same with every NUL removed (ASCII in
 * UTF-16 or UTF-32 of either byte order), and UTF-16LE and UTF-16BE decodings (non-ASCII text). The scanner folds a NUL
 * to a blank, so without these a UTF-16 file with a key in it would scan clean.
 */
export function binaryViews(bytes: Buffer): string[] {
  const even = bytes.subarray(0, bytes.length & ~1);
  const be = Buffer.from(even).swap16();
  const latin = bytes.toString('latin1');
  return [latin, latin.replace(/\0/g, ''), even.toString('utf16le'), be.toString('utf16le')];
}

/** A new-file patch of `body` the scanner reads with its own rules: name, added lines, binary marker (`null`). */
function patch(rel: string, mode: string, body: string | null): string {
  const b = quotePath(`b/${rel}`);
  const head = [`diff --git ${quotePath(`a/${rel}`)} ${b}`, `new file mode ${mode}`, '--- /dev/null', `+++ ${b}`];
  if (body === null) return [...head, `Binary files /dev/null and ${b} differ`, ''].join('\n');
  if (body.length === 0) return [...head, ''].join('\n');
  const lines = body.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return [...head, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ''].join('\n');
}

/**
 * The entry as the patches to scan, or `too-large` when its text cannot fit one scan: decided from the byte count before
 * decoding and from the decoded length before splitting, so a large file costs at most one decode.
 */
export function entryPatches(e: ScanEntry, limits: SnapshotScanner['limits']): { texts: string[]; binary: boolean } | 'too-large' {
  const binary = e.mode !== '120000' && isBinary(e.bytes);
  if (binary) {
    if (e.bytes.length > limits.maxBinaryBytes) return { texts: [patch(e.rel, e.mode, null)], binary };
    return { texts: binaryViews(e.bytes).map((v) => patch(e.rel, e.mode, v)), binary };
  }
  if (e.bytes.length > 4 * limits.maxBytes) return 'too-large';
  const body = e.bytes.toString('utf8');
  if (body.length > limits.maxBytes) return 'too-large';
  return { texts: [patch(e.rel, e.mode, body)], binary };
}

const UNSCANNED = 'the snapshot was refused: its content could not be fully scanned for secrets';
const unscanned = (): WorktreeError => new WorktreeError('E_POLICY_DENIED', UNSCANNED, { reason: 'snapshot-unscanned' });

/** Calls the scanner and reads its answer. A throw, a rejection, or an answer that is not a list of findings is `snapshot-unscanned`. */
async function ask(scanner: SnapshotScanner, text: string, meta: Parameters<SnapshotScanner['scan']>[1]): Promise<SnapshotFinding[]> {
  try {
    const raw: unknown = await scanner.scan(text, meta);
    if (!Array.isArray(raw)) throw unscanned();
    const out: SnapshotFinding[] = [];
    for (const f of raw as unknown[]) {
      const rule = (f as { rule?: unknown } | null)?.rule;
      const line = (f as { line?: unknown } | null)?.line;
      const named = typeof rule === 'string' && RULE.test(rule) ? rule : 'scanner-error';
      out.push(Number.isSafeInteger(line) && (line as number) > 0 ? { rule: named, line: line as number } : { rule: named });
    }
    return out;
  } catch {
    // Not kept, not wrapped: a scanner error (or a getter on its answer) may hold a fragment of the content.
    throw unscanned();
  }
}

export interface SnapshotScan {
  /** Scans one entry (call it with the bytes that will be stored). */
  add(e: ScanEntry): Promise<void>;
  /** Records an entry too large to read for a scan. */
  unscannable(rel: string): void;
  /** Scans a commit message that a snapshot ref will keep reachable. */
  addMessage(commit: string, text: string): Promise<void>;
  /** Refuses the snapshot when anything was found (`snapshot-secret`) or could not be covered (`snapshot-unscanned`). */
  finish(): void;
}

/**
 * One snapshot's scan. Every finding refuses, in both modes of the scanner: a snapshot has no confirmation step, so a `warn`
 * mode `scan-incomplete` refuses as surely as a `refuse` mode throw.
 */
export function startSnapshotScan(scanner: SnapshotScanner, now: () => number = () => performance.now(), budgetMs = SNAPSHOT_SCAN_MS): SnapshotScan {
  const limits = scanner?.limits;
  if (typeof scanner?.scan !== 'function' || !Number.isSafeInteger(limits?.maxBinaryBytes) || !Number.isSafeInteger(limits?.maxBytes)) throw unscanned();
  const started = now();
  // Bounded: the first MAX_REPORTED findings are kept, the rest only counted.
  const kept: SnapshotFinding[] = [];
  let count = 0;
  let secret = false;
  const record = (found: readonly SnapshotFinding[]): void => {
    for (const f of found) {
      count++;
      if (!COVERAGE_RULES.has(f.rule)) secret = true;
      if (kept.length < MAX_REPORTED) kept.push(f);
    }
  };
  // A clock that answers NaN has run out.
  const inTime = (): void => {
    if (!(now() - started <= budgetMs)) throw unscanned();
  };
  return {
    async add(e) {
      inTime();
      const p = entryPatches(e, limits);
      if (p === 'too-large') return void record([{ rule: 'scan-incomplete', path: e.rel }]);
      const seen = new Set<string>();
      const out: SnapshotFinding[] = [];
      for (const text of p.texts) {
        for (const f of await ask(scanner, text, p.binary ? { part: 'patch', binaryPaths: [e.rel] } : { part: 'patch' })) {
          const key = `${f.rule}\0${f.line ?? ''}`;
          if (!seen.has(key)) out.push(f);
          seen.add(key);
        }
      }
      // A name-level match means the name itself holds the token: then no finding of this entry names the path.
      const nameMatched = out.some((f) => f.line === undefined && !PATH_SAFE_RULES.has(f.rule));
      record(nameMatched ? out : out.map((f) => ({ ...f, path: e.rel })));
    },
    unscannable(rel) {
      record([{ rule: 'scan-incomplete', path: rel }]);
    },
    async addMessage(commit, text) {
      inTime();
      const c = OID.test(commit) ? { commit } : {};
      if (text.length > limits.maxBytes) return void record([{ rule: 'scan-incomplete', ...c }]);
      record((await ask(scanner, text, { part: 'message' })).map((f) => ({ ...f, ...c })));
    },
    finish() {
      if (count === 0) return;
      const details = { findings: kept, count };
      if (!secret) throw new WorktreeError('E_POLICY_DENIED', UNSCANNED, { reason: 'snapshot-unscanned', ...details });
      throw new WorktreeError('E_POLICY_DENIED', 'the snapshot was refused: it holds content that looks like a secret', { reason: 'snapshot-secret', ...details });
    },
  };
}
