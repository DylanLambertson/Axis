// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// `#private` fields in minified builds (ADR 0005 D3.6).
//
// Code OSS's `--minify` builds also pass `--mangle-privates`, and build/next/index.ts then rewrites every native
// `#field` in each emitted bundle (except the extension host) into a plain `$a`-style property. A brand check such
// as `UserPrincipal.is` that rests on a `#` field then accepts a hand-written `{ $a: "user" }` or a structuredClone
// of a real one, and a single-use flag becomes resettable. Patch 0200 exempts outputs under `vs/axis/`. These
// checks keep that exemption honest:
//   - mangleExemptionPresent: the tree's build/next/index.ts carries the exemption in its mangle condition;
//   - privatesSurvive: a built bundle still has `#` members when the staged sources it came from declare some.
// The metafile graph check cannot see this: it bundles without the tree's post-processing.
import { tokenize } from "./stage-scan.mjs";

/** Number of `#name` private-name tokens (declarations and uses) in JavaScript or TypeScript text. */
export function privateNameCount(text) {
  return tokenize(text).filter((t) => t.type === "id" && /^#[A-Za-z_$]/.test(t.value)).length;
}

/** True when the mangle condition in build/next/index.ts is gated by the Axis exemption. */
export function mangleExemptionPresent(indexTs) {
  const cond = indexTs.split("\n").filter((l) => /\.js'\) && doManglePrivates/.test(l));
  const defined = /const keepAxisPrivates = [^;]*includes\(['"]\/vs\/axis\/['"]\)/.test(indexTs);
  return defined && cond.length > 0 && cond.every((l) => l.includes("!keepAxisPrivates"));
}

/**
 * Problems with a built bundle: `sourcePrivates` is the count of `#` names in the staged sources that went into it,
 * `builtText` the emitted JavaScript. Sources with private fields must still show some in the output.
 */
export function privatesSurvive({ file, sourcePrivates, builtText }) {
  const built = privateNameCount(builtText);
  if (sourcePrivates > 0 && built === 0) {
    return [`${file}: the staged sources declare ${sourcePrivates} #private name(s) but the built bundle has none (they were mangled into plain properties)`];
  }
  return [];
}
