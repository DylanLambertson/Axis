// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { MAX_STRING_BYTES } from "../src/index.js";

export interface Variant {
  readonly name: string;
  readonly input: unknown;
}

type Path = ReadonlyArray<string | number>;
type Obj = Record<string | number | symbol, unknown>;

const isNode = (v: unknown): v is Obj => typeof v === "object" && v !== null;

/** Every value in `root` with its path, parents first. */
export function walk(root: unknown): Array<{ path: Path; value: unknown }> {
  const out: Array<{ path: Path; value: unknown }> = [];
  const stack: Array<{ path: Path; value: unknown }> = [{ path: [], value: root }];
  while (stack.length > 0) {
    const item = stack.pop() as { path: Path; value: unknown };
    out.push(item);
    if (isNode(item.value)) {
      for (const k of Object.keys(item.value)) stack.push({ path: [...item.path, k], value: item.value[k] });
    }
  }
  return out;
}

/** A copy of `root` with the value at `path` replaced by `f(value)`. */
function replaceAt(root: unknown, path: Path, f: (node: unknown) => unknown): unknown {
  const copy = structuredClone(root);
  if (path.length === 0) return f(copy);
  let parent = copy as Obj;
  for (const k of path.slice(0, -1)) parent = parent[k] as Obj;
  const last = path[path.length - 1] as string | number;
  parent[last] = f(parent[last]);
  return copy;
}

const plainCopy = (node: unknown): Obj => (Array.isArray(node) ? ([...node] as unknown as Obj) : { ...(node as Obj) });

export function deepNest(levels: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < levels; i++) v = { a: v };
  return v;
}

/** Values no JSON schema here may accept at any position. */
const NEVER_VALID: ReadonlyArray<[string, unknown]> = [
  ["undefined", undefined],
  ["bigint", 1n],
  ["symbol", Symbol("s")],
  ["function", () => 1],
  ["Date", new Date(0)],
  ["Map", new Map()],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["deep nesting", deepNest(100_000)],
  ["17 levels", deepNest(17)],
];

/** Wrong-type replacements for a leaf, by the leaf's own type. */
function wrongTypes(leaf: unknown): ReadonlyArray<[string, unknown]> {
  if (typeof leaf === "string") return [["null", null], ["number", 0], ["boolean", true], ["array", []], ["object", {}], ["array of string", ["a"]], ["huge string", "x".repeat(MAX_STRING_BYTES + 1)]];
  if (typeof leaf === "number") return [["null", null], ["numeric string", String(leaf)], ["boolean", true], ["array", []], ["object", {}]];
  if (typeof leaf === "boolean") return [["null", null], ["0", 0], ["1", 1], ["string", "true"], ["array", []]];
  return [["empty string", ""], ["false", false], ["array", []], ["object", {}], ["string", "x"]];
}

/**
 * Every hostile variant of one valid sample. Each variant changes exactly one
 * thing, so a variant that is accepted names the weakness. The caller must
 * check the unmodified sample parses (positive control).
 */
export function hostileVariants(sample: unknown): Variant[] {
  const out: Variant[] = [];
  const add = (name: string, input: unknown): void => void out.push({ name, input });

  for (const [n, v] of [["null", null], ["undefined", undefined], ["number", 1], ["string", "x"], ["array", []], ["boolean", true], ["function", () => 1]] as const) {
    if (!(Array.isArray(sample) && n === "array")) add(`top-level ${n}`, v);
  }

  for (const { path, value } of walk(sample)) {
    const at = path.length === 0 ? "(root)" : path.join(".");
    if (isNode(value)) {
      const isArr = Array.isArray(value);
      for (const k of Object.keys(value)) {
        add(`getter at ${at}.${k}`, replaceAt(sample, path, (node) => {
          const c = plainCopy(node);
          Object.defineProperty(c, k, { get: () => (node as Obj)[k], enumerable: true, configurable: true });
          return c;
        }));
        add(`setter-only accessor at ${at}.${k}`, replaceAt(sample, path, (node) => {
          const c = plainCopy(node);
          Object.defineProperty(c, k, { set: () => undefined, enumerable: true, configurable: true });
          return c;
        }));
      }
      add(`transparent Proxy at ${at}`, replaceAt(sample, path, (node) => new Proxy(plainCopy(node), {})));
      add(`throwing Proxy at ${at}`, replaceAt(sample, path, (node) =>
        new Proxy(plainCopy(node), { get: () => { throw new Error("CANARY_TRAP"); }, ownKeys: () => { throw new Error("CANARY_TRAP"); }, getOwnPropertyDescriptor: () => { throw new Error("CANARY_TRAP"); } })));
      add(`revoked Proxy at ${at}`, replaceAt(sample, path, (node) => {
        const r = Proxy.revocable(plainCopy(node), {});
        r.revoke();
        return r.proxy;
      }));
      add(`symbol key at ${at}`, replaceAt(sample, path, (node) => Object.assign(plainCopy(node), { [Symbol("s")]: 1 })));
      add(`cycle at ${at}`, replaceAt(sample, path, (node) => {
        const c = plainCopy(node);
        c["self"] = c;
        return c;
      }));
      if (isArr) {
        const arr = value as unknown[];
        add(`extra own property on array at ${at}`, replaceAt(sample, path, (node) => Object.assign([...(node as unknown[])], { note: "x" })));
        add(`hole at the end of array at ${at}`, replaceAt(sample, path, (node) => {
          const c = [...(node as unknown[])];
          c.length += 1;
          return c;
        }));
        if (arr.length > 0) {
          add(`hole inside array at ${at}`, replaceAt(sample, path, (node) => {
            const c = [...(node as unknown[])];
            delete c[0];
            return c;
          }));
        }
        if (arr.some(isNode)) {
          add(`shared element in array at ${at}`, replaceAt(sample, path, (node) => {
            const c = [...(node as unknown[])];
            c.push(c.find(isNode));
            return c;
          }));
        }
        add(`10001 elements at ${at}`, replaceAt(sample, path, () => new Array(10_001).fill(0)));
      } else {
        for (const key of ["x_extra", "constructor", "prototype", "approval", "actor", "path"]) {
          if (!(key in (value as Obj))) add(`extra key ${key} at ${at}`, replaceAt(sample, path, (node) => ({ ...(node as Obj), [key]: 1 })));
        }
        add(`own __proto__ at ${at}`, replaceAt(sample, path, (node) => {
          const c = plainCopy(node);
          Object.defineProperty(c, "__proto__", { value: { polluted: true }, enumerable: true, configurable: true, writable: true });
          return c;
        }));
        add(`class instance at ${at}`, replaceAt(sample, path, (node) => {
          class Hostile {}
          return Object.assign(new Hostile(), node);
        }));
        add(`inherited prototype at ${at}`, replaceAt(sample, path, (node) => Object.setPrototypeOf(plainCopy(node), { inherited: 1 })));
      }
    } else if (path.length > 0) {
      for (const [n, v] of [...NEVER_VALID, ...wrongTypes(value)]) add(`${n} at ${at}`, replaceAt(sample, path, () => v));
    }
  }
  return out;
}

/** Every plain object or array reachable from `value`, by identity. */
export function nodesOf(value: unknown): Set<object> {
  const set = new Set<object>();
  for (const { value: v } of walk(value)) if (isNode(v)) set.add(v);
  return set;
}

/** A copy of `sample` with canaries in every string and every extra key, one at a time. */
export function canaryVariants(sample: unknown): Variant[] {
  const out: Variant[] = [];
  for (const { path, value } of walk(sample)) {
    const at = path.join(".") || "(root)";
    if (typeof value === "string") out.push({ name: `canary value at ${at}`, input: replaceAt(sample, path, () => "CANARY_VALUE_\u00e9\u202e") });
    else if (typeof value === "number") out.push({ name: `canary in number at ${at}`, input: replaceAt(sample, path, () => "CANARY_NUMBER") });
    if (isNode(value) && !Array.isArray(value)) {
      out.push({ name: `canary key at ${at}`, input: replaceAt(sample, path, (node) => ({ ...(node as Obj), CANARY_KEY_\u00e9: "CANARY_VALUE" })) });
    }
  }
  return out;
}
