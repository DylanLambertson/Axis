// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The ONE file of the repository besides the web host that may load node:net (scripts/code-oss/web-rules.mjs rule 1), pinned
// by its SHA-256: any edit fails the rule until the pin is updated in the same reviewed change. It listens on an absolute
// Unix socket path, never a port (Node reads a numeric string as one), and lets neither the server nor a raw socket out:
// callers get `close()` and, per connection, a frozen facade of six closures (ADR 0007 decision 7.1, PV-M6).
import { createServer } from "node:net";
import { isAbsolute } from "node:path";

export interface EndpointConn {
  write(data: Uint8Array): void;
  end(): void;
  destroy(): void;
  onData(cb: (chunk: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  onError(cb: () => void): void;
}

/** Listen on `path`; refused before anything listens unless it is absolute and not numeric. Resolves once listening. */
export async function listenOnPath(path: string, onConnection: (conn: EndpointConn) => void): Promise<{ close(): void }> {
  if (!isAbsolute(path) || !path.startsWith("/") || /^\s*\d+\s*$/.test(path)) throw new Error("not an absolute socket path");
  const server = createServer((sock) => {
    sock.on("error", () => undefined);
    onConnection(Object.freeze({
      write: (data: Uint8Array) => void sock.write(data),
      end: () => void sock.end(),
      destroy: () => void sock.destroy(),
      onData: (cb: (chunk: Uint8Array) => void) => void sock.on("data", (d: Uint8Array) => cb(d)),
      onClose: (cb: () => void) => void sock.on("close", () => cb()),
      onError: (cb: () => void) => void sock.on("error", () => cb()),
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  }).catch((e: unknown) => {
    server.close();
    throw e;
  });
  return Object.freeze({ close: () => void server.close() });
}
