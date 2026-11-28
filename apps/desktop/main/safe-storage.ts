// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// `safeStorage` as the audit anchor's cipher (OS-3.1), as the overlay's axisMainPorts.ts gave it. `secure` only for a real OS
// backend: never Linux `basic_text` or `unknown`. Structural, so test/seam.test.ts runs it without Electron.
import type { AnchorCipher } from "@axis/daemon-host/main";

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(plain: string): Uint8Array;
  decryptString(data: Uint8Array): string;
}

export function safeStorageCipher(safeStorage: SafeStorageLike, platform: "darwin" | "linux" | "win32"): AnchorCipher {
  return {
    status: () => {
      if (!safeStorage.isEncryptionAvailable()) return "unavailable";
      if (platform === "linux") {
        const backend = safeStorage.getSelectedStorageBackend?.() ?? "unknown";
        return backend === "basic_text" || backend === "unknown" ? "insecure" : "secure";
      }
      return "secure";
    },
    encrypt: (plain) => new Uint8Array(safeStorage.encryptString(plain)),
    decrypt: (data) => safeStorage.decryptString(Buffer.from(data)),
  };
}
