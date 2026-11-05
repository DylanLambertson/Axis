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

function elf(o: { cls?: number; data?: number; ver?: number; type?: number; machine?: number } = {}): Buffer {
  const b = Buffer.alloc(64);
  b.set([0x7f, 0x45, 0x4c, 0x46, o.cls ?? 2, o.data ?? 1, o.ver ?? 1]);
  b.writeUInt16LE(o.type ?? 3, 16);
  b.writeUInt16LE(o.machine ?? 62, 18);
  b.writeUInt16LE((o.cls ?? 2) === 2 ? 56 : 32, (o.cls ?? 2) === 2 ? 54 : 42);
  return b;
}

test("R7-A: the real /bin/true is a program on this host; the same magic followed by text is not", { skip: process.platform !== "linux" }, () => {
  assert.ok(isNativeExecutable(readFileSync(realpathSync("/bin/true")).subarray(0, 256), "linux"));
  assert.ok(!isNativeExecutable(Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from(TEXT)]), "linux"));
});

test("R7-A: an ELF head is checked field by field", () => {
  assert.ok(isNativeExecutable(elf(), "linux", "x64"));
  assert.ok(isNativeExecutable(elf({ cls: 1, data: 1, machine: 3 }), "linux", "ia32"));
  assert.ok(!isNativeExecutable(elf({ cls: 3 }), "linux", "x64"));
  assert.ok(!isNativeExecutable(elf({ data: 0 }), "linux", "x64"));
  assert.ok(!isNativeExecutable(elf({ ver: 2 }), "linux", "x64"));
  assert.ok(!isNativeExecutable(elf({ type: 1 }), "linux", "x64"));
  assert.ok(!isNativeExecutable(elf({ machine: 183 }), "linux", "x64"));
  assert.ok(!isNativeExecutable(elf(), "linux", "unknown-arch"));
  assert.ok(!isNativeExecutable(elf().subarray(0, 40), "linux", "x64"));
  const badMagic = elf(); badMagic[1] = 0x58;
  assert.ok(!isNativeExecutable(badMagic, "linux", "x64"), "every magic byte counts");
  const badMagic4 = elf(); badMagic4[3] = 0x58;
  assert.ok(!isNativeExecutable(badMagic4, "linux", "x64"));
  const badPh = elf(); badPh.writeUInt16LE(7, 54);
  assert.ok(!isNativeExecutable(badPh, "linux", "x64"));
});

test("R7-A: on Linux, Mach-O, fat and MZ magic are never programs; each first byte alone is not enough", () => {
  for (const b of [[0xfe, 0xed, 0xfa, 0xce], [0xca, 0xfe, 0xba, 0xbe], [0x4d, 0x5a], [0x7f], [0x7f, 0x45], [0x7f, 0x45, 0x4c]]) {
    assert.ok(!isNativeExecutable(Buffer.concat([Buffer.from(b), Buffer.from(TEXT)]), "linux", "x64"), b.join());
  }
});

test("R7-A: a well-formed Mach-O or fat header is still not a program on Linux", () => {
  const thin = Buffer.alloc(32); thin.writeUInt32BE(0xfeedfacf, 0); thin.writeUInt32BE(2, 12);
  const fat = Buffer.alloc(32); fat.writeUInt32BE(0xcafebabe, 0); fat.writeUInt32BE(2, 4);
  assert.ok(!isNativeExecutable(thin, "linux", "x64") && !isNativeExecutable(fat, "linux", "x64"));
});

test("R7-A: on macOS only a plausible Mach-O or fat header is a program", () => {
  const thin = (magic: number, le: boolean, type: number): Buffer => { const b = Buffer.alloc(32); b.writeUInt32BE(magic, 0); (le ? b.writeUInt32LE(type, 12) : b.writeUInt32BE(type, 12)); return b; };
  assert.ok(isNativeExecutable(thin(0xfeedfacf, false, 2), "darwin"));
  assert.ok(isNativeExecutable(thin(0xfeedface, false, 2), "darwin"));
  assert.ok(isNativeExecutable(thin(0xcffaedfe, true, 2), "darwin"));
  assert.ok(isNativeExecutable(thin(0xcefaedfe, true, 2), "darwin"));
  assert.ok(!isNativeExecutable(thin(0xfeedfacf, false, 0), "darwin"));
  assert.ok(!isNativeExecutable(thin(0xcffaedfe, true, 99), "darwin"));
  const fat = (n: number): Buffer => { const b = Buffer.alloc(32); b.writeUInt32BE(0xcafebabe, 0); b.writeUInt32BE(n, 4); return b; };
  assert.ok(isNativeExecutable(fat(2), "darwin"));
  assert.ok(!isNativeExecutable(fat(0), "darwin"));
  assert.ok(!isNativeExecutable(fat(0x41414141), "darwin"));
  assert.ok(!isNativeExecutable(Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)]), "darwin"));
});

test("R7-A: on Windows MZ is a program and a bare first byte is not; any other platform has none", () => {
  assert.ok(isNativeExecutable(head(0x4d, 0x5a), "win32"));
  assert.ok(!isNativeExecutable(head(0x4d, 0x41), "win32"));
  assert.ok(!isNativeExecutable(head(0x7f, 0x45, 0x4c, 0x46), "freebsd" as NodeJS.Platform));
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

test("R7-B: a #! path the kernel cuts at 256 bytes is opaque; the same path with a newline in reach is followed", { skip: skipSh }, async () => {
  const mk = (total: number) => {
    const t = build();
    const dir = join(t.w.base, "d".repeat(total - t.w.base.length - 3));
    mkdirSync(dir);
    const link = join(dir, "l");
    assert.equal(link.length, total);
    symlinkSync(realpathSync("/bin/true"), link);
    return { t, link };
  };
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
