// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PTY-4: does a file head look like a binary the kernel itself will run? A text file with a magic prefix is refused (ENOEXEC) and handed to /bin/sh.

/** ELF `e_machine` for the architectures Node runs on. An architecture not listed here is never accepted. */
const ELF_MACHINE: Readonly<Record<string, number>> = {
  ia32: 3, arm: 40, x64: 62, arm64: 183, ppc64: 21, s390x: 22, riscv64: 243, loong64: 258, mips: 8, mipsel: 8,
};

/** The header checks `load_elf_binary` makes before it gives up with ENOEXEC (needs the first 58 bytes). */
function elf(h: Buffer, arch: string): boolean {
  if (h.length < 58 || h.readUInt32BE(0) !== 0x7f454c46) return false;
  const cls = h[4], data = h[5];
  if ((cls !== 1 && cls !== 2) || (data !== 1 && data !== 2) || h[6] !== 1) return false;
  const u16 = (o: number): number => (data === 1 ? h.readUInt16LE(o) : h.readUInt16BE(o));
  const type = u16(16);
  if (type !== 2 && type !== 3) return false;
  const machine = ELF_MACHINE[arch];
  if (machine === undefined || u16(18) !== machine) return false;
  return u16(cls === 2 ? 54 : 42) === (cls === 2 ? 56 : 32);
}

/** Mach-O thin (either byte order, 32 or 64 bit) with a plausible file type, or a fat header with a plausible count. */
function macho(h: Buffer): boolean {
  if (h.length < 16) return false;
  const m = h.readUInt32BE(0);
  if (m === 0xcafebabe) { const n = h.readUInt32BE(4); return n >= 1 && n <= 30; }
  if (m === 0xfeedface || m === 0xfeedfacf) { const t = h.readUInt32BE(12); return t >= 1 && t <= 12; }
  if (m === 0xcefaedfe || m === 0xcffaedfe) { const t = h.readUInt32LE(12); return t >= 1 && t <= 12; }
  return false;
}

/** True only for a head the platform's loader accepts as a program; every other head is judged by the caller as not judgeable. */
export function isNativeExecutable(head: Buffer, platform: NodeJS.Platform, arch: string = process.arch): boolean {
  if (platform === "linux") return elf(head, arch);
  if (platform === "darwin") return macho(head);
  if (platform === "win32") return head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a;
  return false;
}
