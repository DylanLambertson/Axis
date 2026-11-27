// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { constants, realpath as realpathCb } from "node:fs";
import { link as linkP, lstat as lstatP, open as openP, readlink, rename as renameP, unlink as unlinkP } from "node:fs/promises";

export type FileKind = "file" | "dir" | "symlink" | "other";
export interface FileStat {
  /** `dev:ino` as text: equality means the same file. */
  readonly id: string;
  readonly kind: FileKind;
  readonly nlink: number;
  readonly size: number;
  /** Modification and status-change times in nanoseconds, as text: with `id` and `size` they identify the contents of a file at a moment. */
  readonly mtime: string;
  readonly ctime: string;
  /** Permission bits (`mode & 0o7777`), where the file system reports them. */
  readonly mode?: number;
}
/** How a file is opened. No mode truncates: truncation happens only after the open was verified. */
export type OpenMode = "read" | "overwrite" | "create" | "upsert";

export interface BrokerFile {
  stat(): Promise<FileStat>;
  /** Up to `max` bytes from the start. */
  read(max: number): Promise<Buffer>;
  write(data: Uint8Array): Promise<void>;
  truncate(length: number): Promise<void>;
  /** Set the permission bits of the open file (the compare-and-swap keeps the replaced file's mode). */
  chmod?(mode: number): Promise<void>;
  /** The path the kernel reports for the open descriptor, where the platform offers one (Linux), else undefined. */
  fdPath(): Promise<string | undefined>;
  close(): Promise<void>;
}

/** The file system as the containment code sees it. Tests wrap it to interleave a swap between check and use. */
export interface BrokerFs {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<FileStat>;
  open(path: string, mode: OpenMode): Promise<BrokerFile>;
  /** For the compare-and-swap (`swap.ts`); a file system without them cannot swap (refused `fs-error`). */
  rename?(from: string, to: string): Promise<void>;
  /** A new name for an existing file; fails `EEXIST` when `to` exists (the atomic no-clobber create). */
  link?(existing: string, to: string): Promise<void>;
  unlink?(path: string): Promise<void>;
}

type Stats = { dev: bigint; ino: bigint; mode: bigint; nlink: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean };

function toStat(s: Stats): FileStat {
  const kind: FileKind = s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "dir" : s.isFile() ? "file" : "other";
  return { id: `${s.dev}:${s.ino}`, kind, nlink: Number(s.nlink), size: Number(s.size), mtime: String(s.mtimeNs), ctime: String(s.ctimeNs), mode: Number(s.mode & 0o7777n) };
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

function flagsFor(mode: OpenMode): number {
  switch (mode) {
    case "read":
      return constants.O_RDONLY | NOFOLLOW | NONBLOCK;
    case "overwrite":
      return constants.O_WRONLY | NOFOLLOW | NONBLOCK;
    case "create":
      return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW | NONBLOCK;
    case "upsert":
      return constants.O_WRONLY | constants.O_CREAT | NOFOLLOW | NONBLOCK;
  }
}

export const nodeBrokerFs: BrokerFs = {
  realpath: (p) =>
    new Promise((resolve, reject) => {
      realpathCb.native(p, (e, r) => (e === null ? resolve(r) : reject(e)));
    }),
  rename: (from, to) => renameP(from, to),
  link: (existing, to) => linkP(existing, to),
  unlink: (p) => unlinkP(p),
  async lstat(p) {
    return toStat((await lstatP(p, { bigint: true })) as unknown as Stats);
  },
  async open(p, mode) {
    // 0o600: a created file is private to the user; git applies the repository's modes when it checks files out.
    const fh = await openP(p, flagsFor(mode), 0o600);
    return {
      async stat() {
        return toStat((await fh.stat({ bigint: true })) as unknown as Stats);
      },
      async read(max) {
        const buf = Buffer.allocUnsafe(max);
        let got = 0;
        while (got < max) {
          const { bytesRead } = await fh.read(buf, got, max - got, got);
          if (bytesRead === 0) break;
          got += bytesRead;
        }
        return buf.subarray(0, got);
      },
      async write(data) {
        let off = 0;
        while (off < data.length) {
          const { bytesWritten } = await fh.write(data, off, data.length - off, off);
          off += bytesWritten;
        }
      },
      truncate: (n) => fh.truncate(n),
      chmod: (m) => fh.chmod(m),
      async fdPath() {
        if (process.platform !== "linux") return undefined;
        try {
          return await readlink(`/proc/self/fd/${fh.fd}`);
        } catch {
          return undefined;
        }
      },
      close: () => fh.close(),
    };
  },
};
