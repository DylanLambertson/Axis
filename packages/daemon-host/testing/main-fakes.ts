// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { AnchorCipher } from "../src/main/anchor-store.js";

/**
 * TEST ONLY fakes of main's ports (`docs/design/main-answers.md`). `testCipher` is reversible and NOT a cipher (xor with 0x5a), so
 * the bytes on disk differ from the plain text and a test can tell the store wrote through it.
 */
export function testCipher(status: ReturnType<AnchorCipher["status"]> = "secure"): AnchorCipher & { decrypts: number } {
  const c = {
    decrypts: 0,
    status: () => status,
    encrypt: (plain: string) => new Uint8Array(Buffer.from(plain, "utf8").map((b) => b ^ 0x5a)),
    decrypt: (data: Uint8Array) => {
      c.decrypts++;
      return Buffer.from(Buffer.from(data).map((b) => b ^ 0x5a)).toString("utf8");
    },
  };
  return c;
}
