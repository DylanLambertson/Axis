// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { displayValue, escapeDisplay } from "./display.js";
import { errnoName } from "./errors.js";
import { listDir, readItem } from "./fsread.js";
import { Exhausted, type Budget, type Limits } from "./limits.js";
import type { Incomplete } from "./types.js";

const PREFIX = "refs/axis/";
const MAX_DEPTH = 8;
const MAX_LINE = 4096;
const HEX = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface RefsResult {
  readonly refs: readonly (readonly [string, string])[];
  readonly incomplete: readonly Incomplete[];
}

/**
 * `refs/axis/*` from loose refs and `packed-refs` (a loose ref wins, as in git). A notice only: Axis itself writes
 * these refs, and a ref cannot make git run a program. Anything that cannot be read in full is reported as
 * non-blocking incomplete.
 */
export async function collectRefs(commonDir: string, budget: Budget, limits: Limits): Promise<RefsResult> {
  const found = new Map<string, string>();
  const incomplete: Incomplete[] = [];
  const note = (reason: string): void => void incomplete.push({ id: "refs/axis", reason, blocking: false });
  try {
    await packed(join(commonDir, "packed-refs"), budget, limits, found, note);
    await loose(join(commonDir, "refs", "axis"), PREFIX, 0, budget, limits, found, note);
  } catch (e) {
    if (!(e instanceof Exhausted)) throw e;
    note(`stopped at the ${e.bound} limit`);
  }
  const refs = [...found.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { refs, incomplete };
}

async function loose(
  dir: string,
  name: string,
  depth: number,
  budget: Budget,
  limits: Limits,
  found: Map<string, string>,
  note: (r: string) => void,
): Promise<void> {
  const list = await listDir(dir, budget, limits.maxRefs);
  if (!list.ok) {
    if (list.detail !== "missing") note(`unreadable (${list.detail})`);
    return;
  }
  if (list.undecodable.length > 0) note("ref names that are not valid UTF-8");
  for (const child of list.names) {
    if (found.size >= limits.maxRefs) return note("too many refs");
    const path = join(dir, child);
    const ref = `${name}${child}`;
    const r = await readItem(path, budget, { maxBytes: 1024, keep: 1024 });
    if (r.kind === "dir") {
      if (depth < MAX_DEPTH) await loose(path, `${ref}/`, depth + 1, budget, limits, found, note);
      else note("refs nested too deeply");
    } else if (r.bytes !== null) {
      const line = r.bytes.toString("utf8").split("\n", 1)[0]?.trim() ?? "";
      found.set(escapeDisplay(ref), HEX.test(line) ? line : line.startsWith("ref:") ? `symref ${displayValue(line.slice(4).trim(), 200)}` : "unparsed");
    } else if (r.state !== "missing") {
      note(`${r.state} ref`);
      found.set(escapeDisplay(ref), r.state);
    }
  }
}

async function packed(
  path: string,
  budget: Budget,
  limits: Limits,
  found: Map<string, string>,
  note: (r: string) => void,
): Promise<void> {
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (e) {
    const code = errnoName(e);
    if (code !== "ENOENT" && code !== "ENOTDIR") note(`packed-refs unreadable (${code})`);
    return;
  }
  try {
    if (!(await fh.stat()).isFile()) return note("packed-refs is not a file");
    const buf = Buffer.allocUnsafe(64 * 1024);
    let carry = "";
    let dropping = false;
    for (;;) {
      budget.tick();
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      budget.addBytes(bytesRead);
      const chunk = carry + buf.toString("latin1", 0, bytesRead);
      const lines = chunk.split("\n");
      carry = lines.pop() ?? "";
      if (carry.length > MAX_LINE) {
        carry = "";
        dropping = true;
      }
      for (const line of lines) take(line, found, limits, note);
    }
    if (carry.length > 0) take(carry, found, limits, note);
    if (dropping) note("packed-refs has over-long lines");
  } catch (e) {
    if (e instanceof Exhausted) throw e;
    note(`packed-refs unreadable (${errnoName(e)})`);
  } finally {
    await fh.close().catch(() => undefined);
  }
}

function take(line: string, found: Map<string, string>, limits: Limits, note: (r: string) => void): void {
  if (line.length === 0 || line.length > MAX_LINE) return;
  const sp = line.indexOf(" ");
  if (sp < 0) return;
  const sha = line.slice(0, sp);
  const name = line.slice(sp + 1).trim();
  if (!name.startsWith(PREFIX) || !HEX.test(sha)) return;
  if (found.size >= limits.maxRefs) return note("too many refs");
  found.set(escapeDisplay(Buffer.from(name, "latin1").toString("utf8")), sha);
}
