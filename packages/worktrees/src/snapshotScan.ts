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
}

/** Structurally the `SecretScanner` that `createSecretScanner` returns: the host may pass the one it configures. */
export interface SnapshotScanner {
  readonly scan: (text: string, meta: { readonly part: 'patch'; readonly binaryPaths?: readonly string[] }) => Promise<readonly SnapshotFinding[]>;
  readonly limits: { readonly maxBinaryBytes: number };
}

/** One entry the snapshot would add. `link` content is a symlink target. */
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
const MAX_REPORTED = 50;
/** git's binary test: a NUL in the first 8000 bytes. */
const BINARY_PROBE = 8000;

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

/** The entry as a new-file patch the scanner reads with its own rules: name, added lines, binary marker. */
export function entryPatch(e: ScanEntry, maxBinaryBytes: number): { text: string; binary: boolean } {
  const a = quotePath(`a/${e.rel}`);
  const b = quotePath(`b/${e.rel}`);
  const head = [`diff --git ${a} ${b}`, `new file mode ${e.mode}`, '--- /dev/null', `+++ ${b}`];
  const binary = e.mode !== '120000' && isBinary(e.bytes);
  if (binary && e.bytes.length > maxBinaryBytes) return { text: [...head, `Binary files /dev/null and ${b} differ`, ''].join('\n'), binary };
  // latin1 keeps one character per byte of a binary, so the scanner's byte budget for binaries is exact.
  const body = e.bytes.toString(binary ? 'latin1' : 'utf8');
  if (body.length === 0) return { text: [...head, ''].join('\n'), binary };
  const lines = body.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return { text: [...head, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ''].join('\n'), binary };
}

const UNSCANNED = 'the snapshot was refused: its content could not be fully scanned for secrets';
const unscanned = (): WorktreeError => new WorktreeError('E_POLICY_DENIED', UNSCANNED, { reason: 'snapshot-unscanned' });

/** Scans one entry. A throw, a rejection or an answer that is not a list of findings is `snapshot-unscanned`. */
async function scanEntry(scanner: SnapshotScanner, e: ScanEntry): Promise<SnapshotFinding[]> {
  let raw: unknown;
  try {
    const { text, binary } = entryPatch(e, scanner.limits.maxBinaryBytes);
    raw = await scanner.scan(text, binary ? { part: 'patch', binaryPaths: [e.rel] } : { part: 'patch' });
  } catch {
    // Not kept, not wrapped: a scanner error may hold a fragment of the content.
    throw unscanned();
  }
  if (!Array.isArray(raw)) throw unscanned();
  const out: SnapshotFinding[] = [];
  for (const f of raw as unknown[]) {
    const rule = (f as { rule?: unknown } | null)?.rule;
    const line = (f as { line?: unknown } | null)?.line;
    const named = typeof rule === 'string' && RULE.test(rule) ? rule : 'scanner-error';
    out.push(Number.isSafeInteger(line) && (line as number) > 0 ? { rule: named, line: line as number } : { rule: named });
  }
  // A name-level match means the name itself holds the token: then no finding of this entry names the path.
  const nameMatched = out.some((f) => f.line === undefined && !PATH_SAFE_RULES.has(f.rule));
  return nameMatched ? out : out.map((f) => ({ ...f, path: e.rel }));
}

export interface SnapshotScan {
  /** Scans one entry (call it with the bytes that will be stored). */
  add(e: ScanEntry): Promise<void>;
  /** Refuses the snapshot when anything was found (`snapshot-secret`) or could not be covered (`snapshot-unscanned`). */
  finish(): void;
}

/**
 * One snapshot's scan. Every finding refuses, in both modes of the scanner: a snapshot has no confirmation step, so a `warn`
 * mode `scan-incomplete` refuses as surely as a `refuse` mode throw.
 */
export function startSnapshotScan(scanner: SnapshotScanner): SnapshotScan {
  if (typeof scanner?.scan !== 'function' || !Number.isSafeInteger(scanner.limits?.maxBinaryBytes)) throw unscanned();
  // Bounded: the first MAX_REPORTED findings are kept, the rest only counted.
  const kept: SnapshotFinding[] = [];
  let count = 0;
  let secret = false;
  return {
    async add(e) {
      for (const f of await scanEntry(scanner, e)) {
        count++;
        if (!COVERAGE_RULES.has(f.rule)) secret = true;
        if (kept.length < MAX_REPORTED) kept.push(f);
      }
    },
    finish() {
      if (count === 0) return;
      const details = { findings: kept, count };
      if (!secret) throw new WorktreeError('E_POLICY_DENIED', UNSCANNED, { reason: 'snapshot-unscanned', ...details });
      throw new WorktreeError('E_POLICY_DENIED', 'the snapshot was refused: it holds content that looks like a secret', { reason: 'snapshot-secret', ...details });
    },
  };
}
