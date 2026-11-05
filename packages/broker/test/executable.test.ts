// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// R7-A / R7-B: only a head the loader accepts is a program; a text file with a magic prefix, or a #! path the kernel cuts, goes to /bin/sh.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isNativeExecutable } from "../src/executable.js";
import { call, cleanupWorlds, skipSh } from "./rig.js";
import { build } from "./buildRig.js";

after(cleanupWorlds);

const TEXT = "\necho pwned\n".padEnd(80, "\n");
const head = (...bytes: number[]): Buffer => Buffer.concat([Buffer.from(bytes), Buffer.alloc(64)]);

interface Img { cls?: number; data?: number; ver?: number; type?: number; machine?: number; phnum?: number; phoff?: number; phentsize?: number; interp?: { len: number; off?: number; last?: number }; prop?: number; size?: number }
/** A 64-bit ELF image: the header, then one PT_LOAD (and optionally PT_INTERP / PT_GNU_PROPERTY entries) at 64, strings at 512. */
function elf(o: Img = {}): Buffer {
  const be = o.data === 2;
  const b = Buffer.alloc(Math.max(o.size ?? 1024, 1024));
  const w16 = (v: number, at: number): void => void (be ? b.writeUInt16BE(v, at) : b.writeUInt16LE(v, at));
  const w32 = (v: number, at: number): void => void (be ? b.writeUInt32BE(v, at) : b.writeUInt32LE(v, at));
  const w64 = (v: number, at: number): void => void (be ? b.writeBigUInt64BE(BigInt(v), at) : b.writeBigUInt64LE(BigInt(v), at));
  b.set([0x7f, 0x45, 0x4c, 0x46, o.cls ?? 2, o.data ?? 1, o.ver ?? 1]);
  w16(o.type ?? 3, 16); w16(o.machine ?? 62, 18);
  const entries: Array<[number, number, number]> = [[1, 0, 0]];
  if (o.interp !== undefined) entries.push([3, o.interp.off ?? 512, o.interp.len]);
  if (o.prop !== undefined) entries.push([0x6474e553, 640, o.prop]);
  w64(o.phoff ?? 64, 32); w16(o.phentsize ?? 56, 54); w16(o.phnum ?? entries.length, 56);
  entries.forEach(([t, off, len], i) => { const e = 64 + i * 56; w32(t, e); w64(off, e + 8); w64(len, e + 32); });
  if (o.interp !== undefined) { b.write("/lib64/ld.so", 512); b[512 + o.interp.len - 1] = o.interp.last ?? 0; }
  return b;
}
const LE_X64 = { size: 1024, arch: "x64", endian: "LE" } as const;

test("R7-A: the real /bin/true is a program on this host; the same magic followed by text is not", { skip: process.platform !== "linux" }, () => {
  const bytes = readFileSync(realpathSync("/bin/true"));
  assert.ok(isNativeExecutable(bytes.subarray(0, 4096), "linux", { size: bytes.length }));
  assert.ok(!isNativeExecutable(Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from(TEXT)]), "linux", { size: 100 }));
});

test("R7-A: an ELF head is checked field by field", () => {
  const ok = (img: Buffer, f: object = LE_X64): boolean => isNativeExecutable(img, "linux", { ...LE_X64, ...f });
  assert.ok(ok(elf()));
  assert.ok(ok(elf({ type: 2 })));
  assert.ok(!ok(elf({ cls: 3 })));
  assert.ok(!ok(elf({ ver: 2 })));
  assert.ok(!ok(elf({ type: 1 })));
  assert.ok(!ok(elf({ type: 4 })), "ET_CORE");
  assert.ok(!ok(elf({ type: 0 })), "ET_NONE");
  assert.ok(!ok(elf({ machine: 183 })));
  assert.ok(!ok(elf(), { arch: "unknown-arch" }));
  assert.ok(!ok(elf().subarray(0, 40)));
  assert.ok(!ok(elf({ phentsize: 7 })));
  for (const i of [0, 1, 2, 3]) { const m = elf(); m[i] = 0x58; assert.ok(!ok(m), `magic byte ${i}`); }
});

test("R8-B: the header is read in the host's class and byte order", () => {
  // A big-endian image for a big-endian host is a program; the same bytes on a little-endian host are refused.
  const bePpc = elf({ data: 2, machine: 21 });
  assert.ok(isNativeExecutable(bePpc, "linux", { size: 1024, arch: "ppc64", endian: "BE" }));
  assert.ok(!isNativeExecutable(bePpc, "linux", { size: 1024, arch: "ppc64", endian: "LE" }));
  assert.ok(!isNativeExecutable(elf({ data: 2 }), "linux", LE_X64));
  assert.ok(!isNativeExecutable(elf({ data: 0 }), "linux", LE_X64));
  assert.ok(!isNativeExecutable(elf({ data: 1 }), "linux", { ...LE_X64, endian: "BE" }));
  assert.ok(!isNativeExecutable(elf({ cls: 1 }), "linux", LE_X64), "a 32-bit class on a 64-bit host");
});

test("R8-A: a program header table the kernel cannot load is not a program", () => {
  const ok = (img: Buffer): boolean => isNativeExecutable(img, "linux", { ...LE_X64, size: img.length });
  assert.ok(ok(elf({ interp: { len: 14 }, prop: 16 })));
  assert.ok(!ok(elf({ phnum: 0 })), "no entries");
  assert.ok(!ok(elf({ phnum: 200 })), "a table larger than a page");
  assert.ok(!ok(elf({ phoff: 2000 })), "a table past the end of the file");
  assert.ok(!ok(elf({ phoff: 1000 })), "a table straddling the end");
  assert.ok(!isNativeExecutable(elf(), "linux", { ...LE_X64, size: 100 }), "the file is shorter than its table");
  assert.ok(!ok(elf({ interp: { len: 1 } })), "an interpreter string of one byte");
  assert.ok(!ok(elf({ interp: { len: 5000 } })), "an interpreter string over a page");
  assert.ok(!ok(elf({ interp: { len: 14, last: 0x41 } })), "an interpreter string with no NUL");
  assert.ok(!ok(elf({ interp: { len: 14, off: 1020 } })), "an interpreter string past the end");
  assert.ok(!ok(elf({ prop: 2000 })), "a property note over the kernel's buffer");
  assert.ok(ok(elf({ prop: 900, size: 2048 })), "a note within the buffer is fine");
  const big = (img: Buffer): boolean => isNativeExecutable(img, "linux", { ...LE_X64, size: img.length });
  assert.ok(!big(elf({ phnum: 100, size: 8192 })), "a table of 5600 bytes in a file that holds it");
  assert.ok(!big(elf({ interp: { len: 5000 }, size: 8192 })), "an interpreter string over a page in a file that holds it");
  assert.ok(!big(elf({ prop: 2000, size: 4096 })), "a property note over 1 KiB in a file that holds it");
  // The file is longer than the head that was read: what lies beyond the head is only bounded by the file's size.
  const far = { ...LE_X64, size: 100_000 };
  assert.ok(!isNativeExecutable(elf().subarray(0, 100), "linux", far), "the table lies beyond the head");
  assert.ok(!isNativeExecutable(elf({ interp: { len: 14, off: 1020 } }), "linux", far), "an interpreter string beyond the head");
  assert.ok(isNativeExecutable(elf({ prop: 900, size: 2048 }), "linux", far), "a note far away is fine");
  assert.ok(!ok(elf({ prop: 1000, size: 1100 })), "a note that runs past the end of the file");
});

test("R7-A: on Linux, Mach-O, fat and MZ magic are never programs", () => {
  for (const b of [[0xfe, 0xed, 0xfa, 0xce], [0xca, 0xfe, 0xba, 0xbe], [0x4d, 0x5a], [0x7f], [0x7f, 0x45], [0x7f, 0x45, 0x4c]]) {
    assert.ok(!isNativeExecutable(Buffer.concat([Buffer.from(b), Buffer.from(TEXT)]), "linux", LE_X64), b.join());
  }
  const thin = Buffer.alloc(32); thin.writeUInt32BE(0xfeedfacf, 0); thin.writeUInt32BE(2, 12);
  const fat = Buffer.alloc(32); fat.writeUInt32BE(0xcafebabe, 0); fat.writeUInt32BE(2, 4);
  assert.ok(!isNativeExecutable(thin, "linux", LE_X64) && !isNativeExecutable(fat, "linux", LE_X64));
});

test("R7-A: on macOS only an MH_EXECUTE Mach-O or a plausible fat header is a program", () => {
  const f = { size: 32 };
  const thin = (magic: number, le: boolean, type: number): Buffer => { const b = Buffer.alloc(32); b.writeUInt32BE(magic, 0); (le ? b.writeUInt32LE(type, 12) : b.writeUInt32BE(type, 12)); return b; };
  assert.ok(isNativeExecutable(thin(0xfeedfacf, false, 2), "darwin", f));
  assert.ok(isNativeExecutable(thin(0xfeedface, false, 2), "darwin", f));
  assert.ok(isNativeExecutable(thin(0xcffaedfe, true, 2), "darwin", f));
  assert.ok(isNativeExecutable(thin(0xcefaedfe, true, 2), "darwin", f));
  for (const type of [0, 1, 4, 6, 99]) {
    assert.ok(!isNativeExecutable(thin(0xfeedfacf, false, type), "darwin", f), `BE type ${type}`);
    assert.ok(!isNativeExecutable(thin(0xcffaedfe, true, type), "darwin", f), `LE type ${type}`);
  }
  const fat = (n: number): Buffer => { const b = Buffer.alloc(32); b.writeUInt32BE(0xcafebabe, 0); b.writeUInt32BE(n, 4); return b; };
  assert.ok(isNativeExecutable(fat(2), "darwin", f));
  assert.ok(!isNativeExecutable(fat(0), "darwin", f));
  assert.ok(!isNativeExecutable(fat(0x41414141), "darwin", f));
  assert.ok(!isNativeExecutable(Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)]), "darwin", f));
});

test("R7-A: on Windows MZ is a program and a bare first byte is not; any other platform has none", () => {
  const f = { size: 66 };
  assert.ok(isNativeExecutable(head(0x4d, 0x5a), "win32", f));
  assert.ok(!isNativeExecutable(head(0x4d, 0x41), "win32", f));
  assert.ok(!isNativeExecutable(head(0x7f, 0x45, 0x4c, 0x46), "freebsd" as NodeJS.Platform, f));
});

test("R7-A: a text file that starts with ELF magic is opaque, and so is a #! interpreter that is one", { skip: skipSh }, async () => {
  const t = build();
  writeFileSync(join(t.bin, "prog"), "\x7fELF\necho pwned\n", { mode: 0o755 });
  await t.broker.invoke(call("t", {}));
  assert.equal(t.requests[0]?.tier, "privileged");
  assert.ok(t.requests[0]?.reasons.includes("opaque-program"));
  const n = build();
  const fake = join(n.w.base, "fakeinterp");
  writeFileSync(fake, "\x7fELF\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(n.bin, "prog"), `#!${fake}\n`, { mode: 0o755 });
  await n.broker.invoke(call("t", {}));
  assert.equal(n.requests[0]?.tier, "privileged");
  assert.ok(n.requests[0]?.reasons.includes("opaque-program"));
});

function makeWorldBaseLength(): number {
  const t = build();
  return t.w.base.length;
}

test("R8-A: a valid header with an unusable program header table is opaque, alone or as a #! interpreter", { skip: skipSh || process.platform !== "linux" }, async () => {
  const withText = (img: Buffer): Buffer => { const b = Buffer.from(img); b.write("\necho pwned\n", 600); return b; };
  const real = readFileSync(realpathSync("/bin/true")).subarray(0, 64);
  const bad = [withText(elf({ phnum: 0 })), Buffer.concat([real, Buffer.from("\necho pwned\n")]), withText(elf({ interp: { len: 14, last: 0x41 } }))];
  for (const body of bad) {
    const t = build();
    writeFileSync(join(t.bin, "prog"), body, { mode: 0o755 });
    await t.broker.invoke(call("t", {}));
    assert.equal(t.requests[0]?.tier, "privileged");
    assert.ok(t.requests[0]?.reasons.includes("opaque-program"));
    const n = build();
    const fake = join(n.w.base, "fakeinterp");
    writeFileSync(fake, body, { mode: 0o755 });
    writeFileSync(join(n.bin, "prog"), `#!${fake}\n`, { mode: 0o755 });
    await n.broker.invoke(call("t", {}));
    assert.ok(n.requests[0]?.reasons.includes("opaque-program"));
  }
});

test("R7-B: a #! path the kernel cuts at 256 bytes is opaque; the same path with a newline in reach is followed", { skip: skipSh }, async (tc) => {
  const mk = (total: number) => {
    const t = build();
    const dir = join(t.w.base, "d".repeat(total - t.w.base.length - 3));
    mkdirSync(dir);
    const link = join(dir, "l");
    assert.equal(link.length, total);
    symlinkSync(realpathSync("/bin/true"), link);
    return { t, link };
  };
  if (makeWorldBaseLength() > 250) return tc.skip("the temporary directory path is too long to build a 254-byte path");
  const cut = mk(254);
  writeFileSync(join(cut.t.bin, "prog"), `#!${cut.link}\necho pwned\n`, { mode: 0o755 });
  await cut.t.broker.invoke(call("t", {}));
  assert.ok(cut.t.requests[0]?.reasons.includes("opaque-program"));
  assert.ok(!cut.t.requests[0]?.commands[0]?.includes("interpreter: "));
  const ok = mk(200);
  writeFileSync(join(ok.t.bin, "prog"), `#!${ok.link}\necho\n`, { mode: 0o755 });
  await ok.t.broker.invoke(call("t", {}));
  assert.ok(!ok.t.requests[0]?.reasons.includes("opaque-program"));
  assert.ok(ok.t.requests[0]?.commands[0]?.includes('interpreter: "'));
});

test("R7-N1: the interpreter name stops at a NUL, as the kernel's does", { skip: skipSh }, async () => {
  const t = build();
  writeFileSync(join(t.bin, "prog"), "#!/bin/sh\0/nowhere\nexit 0\n", { mode: 0o755 });
  await t.broker.invoke(call("t", {}));
  assert.ok(t.requests[0]?.commands[0]?.includes('interpreter: "'));
});
