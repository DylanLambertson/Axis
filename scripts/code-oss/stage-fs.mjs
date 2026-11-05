// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// File system helpers for the staging hook (ADR 0005 D3). Nothing here follows a symbolic link: directories are
// listed with their own type, regular files are opened with O_NOFOLLOW and judged by fstat on the open descriptor,
// and every other entry type (link, device, socket, pipe) is refused.
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";

export class StageError extends Error {
  constructor(message) {
    super(message);
    this.name = "StageError";
  }
}

export const fail = (message) => {
  throw new StageError(message);
};

/** A path component the hook will copy: no leading dot, no separators, no spaces or control characters. */
export const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** Directory names that are never staged, wherever they appear under a package's src. */
export const FORBIDDEN_DIRS = new Set(["node_modules", "dist"]);

/**
 * The first pair of paths in `paths` that differ only in case, or null. Pure (no file system): on a case-insensitive
 * file system (macOS default) such a pair would overwrite each other when written.
 */
export function caseCollision(paths) {
  const folded = new Map();
  for (const path of paths) {
    const key = path.toLowerCase();
    if (folded.has(key)) return [folded.get(key), path];
    folded.set(key, path);
  }
  return null;
}

export const byteOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Opens `path` without following a final link and returns its bytes and a change signature. */
export function readRegular(path, maxBytes) {
  const st0 = lstatSync(path);
  if (st0.isSymbolicLink()) fail(`${path}: is a symbolic link`);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    return fail(`${path}: cannot open without following links (${e.code ?? e.message})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) fail(`${path}: not a regular file`);
    if (st.nlink !== 1) fail(`${path}: has ${st.nlink} hard links (a staged input must be the only name of its file)`);
    if (st.size > maxBytes) fail(`${path}: ${st.size} bytes exceeds the ${maxBytes} byte limit`);
    const data = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, data, off, st.size - off, off);
      if (n === 0) fail(`${path}: shorter than its size`);
      off += n;
    }
    return { data, sig: signature(st) };
  } finally {
    closeSync(fd);
  }
}

export const signature = (st) => `${st.size}:${st.mtimeMs}:${st.ino}:${st.dev}`;

/** True when `path` is still the same regular file (same size, mtime and inode) as when `sig` was taken. */
export function unchanged(path, sig) {
  try {
    const st = lstatSync(path);
    return st.isFile() && signature(st) === sig;
  } catch {
    return false;
  }
}

/**
 * Lists a directory without following links. Returns `{ name, path, dir }` entries in byte order. A link or any
 * entry that is neither a file nor a directory is refused.
 */
export function listDir(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .map((d) => {
      if (d.isSymbolicLink()) fail(`${join(dir, d.name)}: symbolic links are not staged`);
      if (!d.isDirectory() && !d.isFile()) fail(`${join(dir, d.name)}: not a regular file or directory`);
      return { name: d.name, path: join(dir, d.name), dir: d.isDirectory() };
    })
    .sort((a, b) => byteOrder(a.name, b.name));
}

/** Every file under `dir`, recursively, as `{ path, rel }` (rel is posix). Refuses links and odd types. */
export function* walkFiles(dir, base = dir, relBase = "") {
  for (const e of listDir(dir)) {
    const rel = relBase === "" ? e.name : `${relBase}/${e.name}`;
    if (e.dir) yield* walkFiles(e.path, base, rel);
    else yield { path: e.path, rel };
  }
}

/** Refuses a link, or a non-directory, at any existing component of `parts` below `base`. Missing components are fine. */
export function assertRealDirChain(base, parts) {
  let cur = base;
  for (const part of parts) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    if (st.isSymbolicLink()) fail(`${cur}: is a symbolic link; staging does not write through links`);
    if (!st.isDirectory()) fail(`${cur}: exists and is not a directory`);
  }
}
