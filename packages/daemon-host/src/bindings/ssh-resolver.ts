// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ResolvedSshHost, SshHostResolver } from "./push-target.js";

/** The part of a child process the resolver uses. `node:child_process` `spawn` with `shell: false` and `stdio: ["ignore", "pipe", "ignore"]` fits. */
export interface SshProcess {
  readonly stdout: { on(event: "data", listener: (chunk: Uint8Array) => void): unknown; on(event: "error", listener: () => void): unknown } | null;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: () => void): unknown;
  kill(): unknown;
}

/** Starts a program with NO shell. `env` is the whole environment of the child. */
export type SshSpawn = (file: string, args: readonly string[], options: { readonly env: Readonly<Record<string, string>> }) => SshProcess;

/** The resolver of a host with no way to start ssh: every ssh destination is refused (fail closed). */
export const unavailableSshResolver: SshHostResolver = () => Promise.reject(new Error("no ssh resolver"));

export interface SshResolverOptions {
  readonly spawn: SshSpawn;
  /** The daemon's environment: only `PATH`, `HOME`, `USER` and `LOGNAME` are taken from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The program, default `ssh` (found on `PATH`). */
  readonly file?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Resolutions waiting or running at once; one more is refused (fail closed). Default 16. */
  readonly maxPending?: number;
}

const HOST = /^[A-Za-z0-9._:-]{1,255}$/; // an ipv6 literal is given without its brackets
const USER = /^[A-Za-z0-9._+][A-Za-z0-9._+-]{0,127}$/;
const KEPT_ENV = ["PATH", "HOME", "USER", "LOGNAME"] as const;

function strictHost(host: string): string | null {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  // `@` is not in the set, so `a@b` is refused; a leading `-` would be an option to ssh.
  return HOST.test(bare) && !bare.startsWith("-") ? bare : null;
}

/** Only hostname, port and user are read; a repeated key with another value, a missing hostname or port, or a bad value is an anomaly. */
export function parseSshConfig(text: string): ResolvedSshHost {
  const seen = new Map<string, string>();
  for (const line of text.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp < 1) continue;
    const key = line.slice(0, sp);
    if (key !== "hostname" && key !== "port" && key !== "user") continue;
    const value = line.slice(sp + 1);
    if (seen.has(key) && seen.get(key) !== value) throw new Error("ssh answered two values");
    seen.set(key, value);
  }
  const hostname = seen.get("hostname");
  const portText = seen.get("port");
  if (hostname === undefined || portText === undefined || strictHost(hostname) === null || !/^[0-9]{1,5}$/.test(portText)) throw new Error("ssh answer unusable");
  const port = Number(portText);
  if (port < 1 || port > 65535) throw new Error("ssh answer unusable");
  const user = seen.get("user");
  if (user !== undefined && !USER.test(user)) throw new Error("ssh answer unusable");
  return { hostname: strictHost(hostname) as string, port, ...(user === undefined ? {} : { user }) };
}

/**
 * The production `SshHostResolver` (H9-base-ssh): `ssh -G [-l user] [-p port] -- host`, which prints the effective configuration
 * without connecting. No shell; a pinned argv; the environment holds only `PATH`, `HOME`, `USER`, `LOGNAME` and `LC_ALL=C`, so
 * `ssh` reads the person's own configuration and nothing the process happened to have set. The host is checked against a strict
 * character set (ASCII letters, digits, `.`, `_`, `-`, `:`; no `@`, no control characters of any range, no leading `-`) BEFORE a
 * process exists. Output is bounded and so is the time; anything else (a start error, a non-zero exit, too much output, a bad
 * answer) throws, which refuses the push scan base. `Match exec` lines of the person's own configuration run as ssh evaluates
 * them, as they would for the push itself; that is a documented trust decision (docs/design/daemon-host-git.md).
 */
export function createSshResolver(options: SshResolverOptions): SshHostResolver {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxBytes = options.maxOutputBytes ?? 65_536;
  const maxPending = options.maxPending ?? 16;
  const env: Record<string, string> = { LC_ALL: "C" };
  for (const k of KEPT_ENV) {
    const v = options.env[k];
    if (typeof v === "string" && v !== "" && !v.includes("\0")) env[k] = v;
  }
  let pending = 0;
  let tail: Promise<unknown> = Promise.resolve();

  const run = (args: readonly string[]): Promise<ResolvedSshHost> =>
    new Promise((resolve, reject) => {
      let child: SshProcess;
      try {
        child = options.spawn(options.file ?? "ssh", args, { env });
      } catch {
        reject(new Error("ssh did not start"));
        return;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      let settled = false;
      const finish = (error: Error | null, value?: ResolvedSshHost): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== null) {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
          reject(error);
        } else resolve(value as ResolvedSshHost);
      };
      const timer = setTimeout(() => finish(new Error("ssh timed out")), timeoutMs);
      child.on("error", () => finish(new Error("ssh failed")));
      child.stdout?.on("error", () => finish(new Error("ssh failed")));
      child.stdout?.on("data", (c) => {
        size += c.length;
        if (size > maxBytes) return finish(new Error("ssh output too large"));
        chunks.push(c);
      });
      child.on("close", (code) => {
        if (code !== 0) return finish(new Error("ssh refused"));
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
          finish(null, parseSshConfig(text));
        } catch {
          finish(new Error("ssh answer unusable"));
        }
      });
    });

  return async (host, user, port) => {
    const name = strictHost(host);
    if (name === null) throw new Error("host refused");
    if (user !== undefined && !USER.test(user)) throw new Error("user refused");
    if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) throw new Error("port refused");
    if (pending >= maxPending) throw new Error("too many resolutions");
    const args = ["-G", ...(user === undefined ? [] : ["-l", user]), ...(port === undefined ? [] : ["-p", String(port)]), "--", name];
    pending += 1;
    const result = tail.then(() => run(args));
    tail = result.catch(() => undefined); // one ssh at a time
    try {
      return await result;
    } finally {
      pending -= 1;
    }
  };
}
