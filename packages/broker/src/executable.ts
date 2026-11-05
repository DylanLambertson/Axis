// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PTY-4: does a file head look like a binary the kernel itself will run? A text file with a magic prefix is refused (ENOEXEC) and handed to /bin/sh.

import { endianness } from "node:os";

/** ELF `e_machine` for the architectures Node runs on. An architecture not listed here is never accepted. */
const ELF_MACHINE: Readonly<Record<string, number>> = {
  ia32: 3, arm: 40, x64: 62, arm64: 183, ppc64: 21, s390x: 22, riscv64: 243, loong64: 258, mips: 8, mipsel: 8,
};

const PAGE = 4096;
const PT_INTERP = 3;
const PT_GNU_PROPERTY = 0x6474e553;
/** ELF word size per architecture: the kernel reads the header in its own class and byte order. */
const WORD64 = new Set(["x64", "arm64", "ppc64", "s390x", "riscv64", "loong64"]);

/** What the loader needs to know about the file: its size, and the host it runs on (given only by tests). */
export interface LoaderFacts {
  readonly size: number;
  readonly arch?: string;
  readonly endian?: "LE" | "BE";
}

/**
 * The checks `load_elf_binary` makes before the point of no return, where a failure is ENOEXEC and /bin/sh then runs the file:
 * the header in the host's own class and byte order, and a usable program header table. `h` must hold the first
 * `PAGE` bytes, the most the kernel reads for the table; a table or an interpreter string outside them is not judged a program
 * (the GNU property note is only bounded by the file and its size: later kernel checks are not reproduced).
 */
function elf(h: Buffer, f: LoaderFacts): boolean {
  const arch = f.arch ?? process.arch;
  const le = (f.endian ?? endianness()) === "LE";
  const wide = WORD64.has(arch);
  if (h.length < (wide ? 64 : 52) || h.readUInt32BE(0) !== 0x7f454c46) return false;
  if (h[4] !== (wide ? 2 : 1) || h[5] !== (le ? 1 : 2) || h[6] !== 1) return false;
  const u16 = (o: number): number => (le ? h.readUInt16LE(o) : h.readUInt16BE(o));
  const u32 = (o: number): number => (le ? h.readUInt32LE(o) : h.readUInt32BE(o));
  const u64 = (o: number): number => {
    const v = le ? h.readBigUInt64LE(o) : h.readBigUInt64BE(o);
    return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v);
  };
  const word = (o32: number, o64: number): number => (wide ? u64(o64) : u32(o32));
  const type = u16(16);
  if (type !== 2 && type !== 3) return false;
  const machine = ELF_MACHINE[arch];
  if (machine === undefined || u16(18) !== machine) return false;
  const entry = wide ? 56 : 32;
  const phentsize = u16(wide ? 54 : 42), phnum = u16(wide ? 56 : 44), phoff = word(28, 32);
  if (phentsize !== entry || phnum < 1) return false;
  const table = phnum * entry;
  if (table > PAGE || phoff + table > Math.min(f.size, h.length)) return false;
  for (let i = 0; i < phnum; i++) {
    const e = phoff + i * entry;
    const kind = u32(e);
    if (kind !== PT_INTERP && kind !== PT_GNU_PROPERTY) continue;
    const off = wide ? u64(e + 8) : u32(e + 4), len = wide ? u64(e + 32) : u32(e + 16);
    if (off + len > f.size) return false;
    // The note sits far from the head in real binaries: only its size (the kernel's 1 KiB buffer) and place in the file are checked.
    if (kind === PT_GNU_PROPERTY) { if (len > 1024) return false; continue; }
    if (len < 2 || len > PAGE || off + len > h.length || h[off + len - 1] !== 0) return false;
  }
  return true;
}

const MH_EXECUTE = 2;
/** Mach-O thin (either byte order, 32 or 64 bit) of type MH_EXECUTE (the only type XNU runs), or a fat header with a plausible count. */
function macho(h: Buffer): boolean {
  if (h.length < 16) return false;
  const m = h.readUInt32BE(0);
  if (m === 0xcafebabe) { const n = h.readUInt32BE(4); return n >= 1 && n <= 30; }
  if (m === 0xfeedface || m === 0xfeedfacf) return h.readUInt32BE(12) === MH_EXECUTE;
  if (m === 0xcefaedfe || m === 0xcffaedfe) return h.readUInt32LE(12) === MH_EXECUTE;
  return false;
}

/** True only for a head the platform's loader accepts as a program; every other head is judged by the caller as not judgeable. */
export function isNativeExecutable(head: Buffer, platform: NodeJS.Platform, facts: LoaderFacts): boolean {
  if (platform === "linux") return elf(head, facts);
  if (platform === "darwin") return macho(head);
  if (platform === "win32") return head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a;
  return false;
}
