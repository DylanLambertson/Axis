// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The raw scratch checkout of a reviewed tree and its verification (docs/design/daemon-host-hooks.md §5 steps 5 and 8).
// No git checkout code runs, so git's own checkout protections are re-implemented here: every path component is checked,
// case-fold and Unicode-normalisation collisions refuse the whole tree, every create is no-follow and exclusive, and
// symlinks are written last so no write can pass through one.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync, symlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export type EntryKind = "file" | "exec" | "link" | "gitlink";

export interface ManifestEntry {
  readonly path: string;
  readonly kind: EntryKind;
  readonly oid: string;
}

export interface Manifest {
  readonly entries: readonly ManifestEntry[];
  /** Every directory the entries imply, parents first. */
  readonly dirs: readonly string[];
}

export const SCRATCH_LIMITS = { entries: 100_000, totalBytes: 256 * 1024 * 1024 } as const;

/** Code points HFS+ ignores when it compares names (git's is_hfs_dotgit list). */
const HFS_IGNORED = /[‌-‏‪-‮⁪-⁯﻿]/g;

/** One path component of a tree entry, as git's verify_path would judge it on every platform at once. */
export function componentOk(c: string): boolean {
  if (c === "" || c === "." || c === ".." || /[/\\\0]/.test(c)) return false;
  // NTFS: trailing dots and spaces are dropped, and `name:stream` names the same file.
  const ntfs = c.replace(/:.*$/s, "").replace(/[. ]+$/, "").toLowerCase();
  if (ntfs === ".git" || ntfs === "" || /^git~\d+$/.test(ntfs)) return false;
  const hfs = c.replace(HFS_IGNORED, "").normalize("NFC").toLowerCase();
  if (hfs === ".git") return false;
  return true;
}

const foldKey = (p: string): string => p.normalize("NFC").toUpperCase().toLowerCase().replace(HFS_IGNORED, "").normalize("NFC");

/** Parses `ls-tree -r -z` output. Undefined on anything unexpected (a name that is not UTF-8 included: refused, fail closed). */
export function parseLsTree(out: Uint8Array): ManifestEntry[] | undefined {
  const text = (() => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(out);
    } catch {
      return undefined;
    }
  })();
  if (text === undefined) return undefined;
  const entries: ManifestEntry[] = [];
  for (const rec of text.split("\0")) {
    if (rec === "") continue;
    const m = /^(\d{6}) (blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/s.exec(rec);
    if (m === null) return undefined;
    const mode = m[1] as string;
    const kind: EntryKind | undefined = mode === "100644" ? "file" : mode === "100755" ? "exec" : mode === "120000" ? "link" : mode === "160000" ? "gitlink" : undefined;
    if (kind === undefined || (kind === "gitlink") !== (m[2] === "commit")) return undefined;
    entries.push({ path: m[4] as string, kind, oid: m[3] as string });
  }
  return entries;
}

/** Validates every entry and computes the directories. Undefined (`bad_tree`) on a bad component or any collision. */
export function planManifest(entries: readonly ManifestEntry[]): Manifest | undefined {
  if (entries.length > SCRATCH_LIMITS.entries) return undefined;
  const dirs = new Map<string, string>(); // fold key -> exact path
  const leaves = new Map<string, string>();
  for (const e of entries) {
    const parts = e.path.split("/");
    if (!parts.every(componentOk)) return undefined;
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      const k = foldKey(d);
      const seen = dirs.get(k);
      if (seen !== undefined && seen !== d) return undefined; // `A/x` and `a/y`
      if (leaves.has(k)) return undefined;
      dirs.set(k, d);
    }
    const k = foldKey(e.path);
    if (leaves.has(k) || dirs.has(k)) return undefined;
    leaves.set(k, e.path);
  }
  // A leaf added before a directory of the same folded name.
  for (const k of dirs.keys()) if (leaves.has(k)) return undefined;
  const dirList = [...dirs.values()].sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0));
  return { entries, dirs: dirList };
}

/** The blob id git gives `bytes` (SHA-1 or SHA-256 by the length of `like`). No process, no filter. */
export function blobId(bytes: Uint8Array, like: string): string {
  const h = createHash(like.length === 64 ? "sha256" : "sha1");
  h.update(`blob ${bytes.length}\0`);
  h.update(bytes);
  return h.digest("hex");
}

/** `lstat` that answers undefined for a missing entry. */
const lstatOr = (p: string): ReturnType<typeof lstatSync> | undefined => {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
};

/** Every parent of `rel` under `root` must be a real directory (not a symlink) right before use. */
function parentsReal(root: string, rel: string): boolean {
  const parts = rel.split("/");
  let p = root;
  for (let i = 0; i < parts.length - 1; i++) {
    p = join(p, parts[i] as string);
    const st = lstatOr(p);
    if (st === undefined || !st.isDirectory() || st.isSymbolicLink()) return false;
  }
  return true;
}

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;

/**
 * Writes the manifest into the empty directory `root`: directories, then regular files (exclusive, no-follow), then gitlinks
 * as empty directories, then symlinks LAST. `blobs` maps an id to its raw bytes. Throws on anything unexpected.
 */
export function writeScratchTree(root: string, m: Manifest, blobs: ReadonlyMap<string, Uint8Array>): void {
  for (const d of m.dirs) {
    if (!parentsReal(root, d)) throw new Error("bad_tree");
    mkdirSync(join(root, d), { mode: 0o700 });
  }
  for (const e of m.entries) {
    if (e.kind !== "file" && e.kind !== "exec") continue;
    const bytes = blobs.get(e.oid);
    if (bytes === undefined || !parentsReal(root, e.path)) throw new Error("bad_tree");
    const fd = openSync(join(root, e.path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, e.kind === "exec" ? 0o700 : 0o600);
    try {
      for (let off = 0; off < bytes.length; ) off += writeSync(fd, bytes, off, bytes.length - off);
    } finally {
      closeSync(fd);
    }
  }
  for (const e of m.entries) {
    if (e.kind !== "gitlink") continue;
    if (!parentsReal(root, e.path)) throw new Error("bad_tree");
    mkdirSync(join(root, e.path), { mode: 0o700 });
  }
  for (const e of m.entries) {
    if (e.kind !== "link") continue;
    const target = blobs.get(e.oid);
    if (target === undefined || target.length === 0 || target.includes(0) || !parentsReal(root, e.path)) throw new Error("bad_tree");
    symlinkSync(Buffer.from(target), join(root, e.path));
  }
}

/** Reads a regular file without following a link and without blocking on a FIFO or device; undefined if it is not one or too big. */
export function readRegular(p: string, expectSize: number): Uint8Array | undefined {
  let fd: number;
  try {
    fd = openSync(p, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size !== expectSize) return undefined;
    const buf = Buffer.alloc(expectSize);
    let off = 0;
    while (off < expectSize) {
      const n = readSync(fd, buf, off, expectSize - off, off);
      if (n === 0) return undefined;
      off += n;
    }
    // One more byte means the file grew between fstat and here.
    if (readSync(fd, Buffer.alloc(1), 0, 1, off) !== 0) return undefined;
    return buf;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * Compares the scratch tree with the manifest, walking from the root with `lstat` on every entry: every implied directory
 * must still be a real directory, every file must have the recorded type, executable bit and bytes (hashed here over bytes
 * read without following links), every symlink the recorded `readlink` text, and ANY entry not in the manifest is a change.
 * `sizes` is each blob's byte length from the fill. No git ignore logic is involved.
 */
export function verifyScratchTree(root: string, m: Manifest, sizes: ReadonlyMap<string, number>): "same" | "changed" {
  const want = new Map<string, ManifestEntry | "dir">();
  for (const d of m.dirs) want.set(d, "dir");
  for (const e of m.entries) want.set(e.path, e.kind === "gitlink" ? "dir" : e);
  let found = 0;
  const walk = (rel: string): boolean => {
    let names: string[];
    try {
      names = readdirSync(rel === "" ? root : join(root, rel));
    } catch {
      return false;
    }
    for (const name of names) {
      const r = rel === "" ? name : `${rel}/${name}`;
      const w = want.get(r);
      const st = lstatOr(join(root, r));
      if (w === undefined || st === undefined) return false;
      found++;
      if (w === "dir") {
        if (!st.isDirectory() || st.isSymbolicLink() || !walk(r)) return false;
        continue;
      }
      if (w.kind === "link") {
        if (!st.isSymbolicLink()) return false;
        let text: Buffer;
        try {
          text = readlinkSync(join(root, r), { encoding: "buffer" });
        } catch {
          return false;
        }
        if (blobId(text, w.oid) !== w.oid) return false;
        continue;
      }
      if (!st.isFile() || ((Number(st.mode) & 0o100) !== 0) !== (w.kind === "exec")) return false;
      const size = sizes.get(w.oid);
      if (size === undefined) return false;
      const bytes = readRegular(join(root, r), size);
      if (bytes === undefined || blobId(bytes, w.oid) !== w.oid) return false;
    }
    return true;
  };
  const rootSt = lstatOr(root);
  if (rootSt === undefined || !rootSt.isDirectory() || rootSt.isSymbolicLink()) return "changed";
  return walk("") && found === want.size ? "same" : "changed";
}

/** Parses `cat-file --batch` output for the ids asked, in order. Undefined on a missing object or any malformed record. */
export function parseCatFileBatch(out: Uint8Array, ids: readonly string[]): Map<string, Uint8Array> | undefined {
  const buf = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  const blobs = new Map<string, Uint8Array>();
  let off = 0;
  for (const id of ids) {
    const nl = buf.indexOf(0x0a, off);
    if (nl < 0) return undefined;
    const m = /^([0-9a-f]{40}|[0-9a-f]{64}) blob (\d{1,10})$/.exec(buf.subarray(off, nl).toString("latin1"));
    if (m === null || m[1] !== id) return undefined;
    const size = Number(m[2]);
    const start = nl + 1;
    if (start + size + 1 > buf.length || buf[start + size] !== 0x0a) return undefined;
    blobs.set(id, buf.subarray(start, start + size));
    off = start + size + 1;
  }
  return off === buf.length ? blobs : undefined;
}
