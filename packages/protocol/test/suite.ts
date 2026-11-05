// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { z } from "zod";
import { lookupMethod } from "../src/index.js";
import { canaryVariants, hostileVariants, nodesOf } from "./hostile.js";

export interface Sample {
  readonly contract: string;
  readonly method: string;
  readonly side: "request" | "response";
  readonly name: string;
  readonly value: unknown;
  /** What parsing must return. Defaults to `value`. */
  readonly expected?: unknown;
  /**
   * Names of hostile variants that are legitimately valid for this sample (a
   * nullable field replaced by null). Each must exist and be accepted, so the
   * list cannot go stale and hide a real hole.
   */
  readonly tolerated?: readonly string[];
  /**
   * Variants a free-form subtree legitimately accepts (a wrong type inside a
   * JSON payload). Every accepted variant must match, and at least one must.
   */
  readonly toleratedPattern?: RegExp;
}

export function schemaOf(contract: string, method: string, side: "request" | "response"): z.ZodType {
  const spec = lookupMethod(contract, 1, method);
  assert.ok(spec !== undefined, `${contract}/1.${method} is not in the registry`);
  return spec[side];
}

/** Parse without letting a throw count as a rejection. */
export function parse(schema: z.ZodType, input: unknown, label: string): z.ZodSafeParseResult<unknown> {
  try {
    return schema.safeParse(input);
  } catch (e) {
    assert.fail(`${label}: safeParse threw instead of returning a failure (${e instanceof Error ? e.name : typeof e})`);
  }
}

/** All the text a caller could read from a failure. */
export function errorText(result: z.ZodSafeParseResult<unknown>): string {
  if (result.success) return "";
  return `${JSON.stringify(result.error.issues)}|${result.error.message}|${String(result.error)}|${JSON.stringify(result.error)}`;
}

export function accepts(schema: z.ZodType, input: unknown, label: string): void {
  const r = parse(schema, input, label);
  assert.equal(r.success, true, `${label} should be accepted: ${errorText(r)}`);
}

export function rejects(schema: z.ZodType, input: unknown, label: string): void {
  const r = parse(schema, input, label);
  assert.equal(r.success, false, `${label} should be rejected`);
}

/**
 * For every sample: it parses to an equal but separate copy; every hostile
 * variant is rejected without throwing and without echoing input; and every
 * canary string and key is kept out of the error text.
 */
export function runSuite(samples: readonly Sample[]): void {
  for (const s of samples) {
    const label = `${s.contract}/1.${s.method} ${s.side}: ${s.name}`;
    const schema = (): z.ZodType => schemaOf(s.contract, s.method, s.side);

    test(`${label}: fixed vector parses to a separate copy`, () => {
      const input = structuredClone(s.value);
      const r = parse(schema(), input, label);
      assert.equal(r.success, true, errorText(r));
      if (!r.success) return;
      assert.deepEqual(r.data, s.expected ?? s.value);
      // Nothing in the result is a node of the input, and later changes to the input do not show.
      const inputNodes = nodesOf(input);
      for (const n of nodesOf(r.data)) assert.equal(inputNodes.has(n), false, "result shares a node with the input");
      assert.notEqual(r.data, input);
      const before = structuredClone(r.data);
      for (const n of inputNodes) {
        if (Array.isArray(n)) n.push("CANARY_LATE");
        else (n as Record<string, unknown>)["CANARY_LATE"] = 1;
      }
      assert.deepEqual(r.data, before);
    });

    test(`${label}: every hostile variant is rejected, none throws or echoes`, () => {
      const variants = hostileVariants(s.value);
      assert.ok(variants.length >= 10, "too few variants to mean anything");
      const accepted = new Set<string>();
      for (const v of variants) {
        const r = parse(schema(), v.input, `${label} / ${v.name}`);
        if (r.success) accepted.add(v.name);
        else assert.equal(errorText(r).includes("CANARY"), false, `${v.name}: error echoes input`);
      }
      const exact = new Set(s.tolerated ?? []);
      const pattern = s.toleratedPattern;
      const stray = [...accepted].filter((n) => !exact.has(n) && !(pattern?.test(n) ?? false));
      assert.deepEqual(stray, [], `${label}: accepted hostile input`);
      for (const n of exact) assert.equal(accepted.has(n), true, `${label}: tolerated variant ${n} no longer exists or is no longer accepted`);
      if (pattern !== undefined) assert.ok([...accepted].some((n) => pattern.test(n)), `${label}: the tolerance pattern matches nothing`);
    });

    test(`${label}: no error output echoes keys or values`, () => {
      const variants = canaryVariants(s.value);
      assert.ok(variants.length >= 1);
      let rejected = 0;
      for (const v of variants) {
        const r = parse(schema(), v.input, `${label} / ${v.name}`);
        if (!r.success) {
          rejected++;
          assert.equal(errorText(r).includes("CANARY"), false, `${v.name}: error echoes input: ${errorText(r)}`);
        }
      }
      assert.ok(rejected >= 1, "no canary variant was rejected, so the check proved nothing");
    });
  }
}
