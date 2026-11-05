// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { types } from "node:util";
import { inspectMessage } from "@axis/protocol";

const MAX_NODES = 2_000;
const MAX_DEPTH = 8;

/** Bounds of the walks; the defaults suit control messages. A larger message (a mux frame) passes its own. */
export interface PlainDataLimits {
  readonly maxBytes?: number;
  readonly maxNodes?: number;
  readonly maxDepth?: number;
}

/**
 * Why a supervisor message is refused before any schema reads it, or undefined when it is plain data. Two passes:
 * a walk that refuses a `Proxy` at any depth without touching it (a trap would run on any read), then the
 * protocol's bounded `inspectMessage` (no accessors, class instances, shared references or forbidden keys, bounded
 * size, nodes and depth). Only the second pass reads properties, and only after the first found no `Proxy`.
 */
export function refuseNonPlainData(value: unknown, limits: PlainDataLimits = {}): string | undefined {
  const maxNodes = limits.maxNodes ?? MAX_NODES;
  const maxDepth = limits.maxDepth ?? MAX_DEPTH;
  const stack: Array<[unknown, number]> = [[value, 0]];
  const seen = new Set<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [unknown, number];
    if (typeof node !== "object" && typeof node !== "function") continue;
    if (node === null) continue;
    if (types.isProxy(node)) return "proxy";
    if (++nodes > maxNodes || depth > maxDepth) return "too_large";
    if (seen.has(node)) continue;
    seen.add(node);
    // Ordinary objects only from here on, so descriptor reads run no user code. An accessor's value is not read.
    for (const key of Reflect.ownKeys(node)) {
      const d = Object.getOwnPropertyDescriptor(node, key);
      if (d !== undefined && "value" in d) stack.push([d.value, depth + 1]);
    }
  }
  const r = inspectMessage(value, { maxNodes, maxDepth, ...(limits.maxBytes === undefined ? {} : { maxBytes: limits.maxBytes }) });
  return r.ok ? undefined : `not_plain_${r.reason}`;
}
