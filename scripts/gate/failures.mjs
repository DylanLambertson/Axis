// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Reads the streamed output of scripts/test-all.mjs for the gate: splits it into one block per suite
// (each ends with the runner's `== name: ok|FAILED (...)` line) and extracts the failing tests' names
// and assertion messages, so a one-off flake leaves a test name to chase and not only a count.

const END = /^== (.+?): (ok|FAILED) \(.*\)$/gm;
const FAILED_LINE = /^\s*(?:✖ (?!failing tests:)|not ok \d+ )/;

/** One entry per suite in the output: { name, ok, text }, `text` being everything that suite printed. */
export function splitSuites(output) {
  const suites = [];
  let from = 0;
  for (const m of output.matchAll(END)) {
    const end = m.index + m[0].length;
    suites.push({ name: m[1], ok: m[2] === "ok", text: output.slice(from, end).replace(/^\n+/, "") });
    from = end;
  }
  return suites;
}

/**
 * The failing tests of one suite's output: the spec reporter's `failing tests:` section (each test's name
 * and its first `perTest` lines of error) when there is one, else every `not ok` / `✖` line with the lines
 * after it. At most `maxLines` lines. Empty when nothing failed by name (a killed or timed-out suite).
 */
export function failureDigest(text, { perTest = 15, maxLines = 150 } = {}) {
  const lines = text.split("\n");
  const picked = [];
  const section = lines.findIndex((l) => /^\s*✖ failing tests:/.test(l));
  if (section >= 0) {
    let block = 0;
    for (const l of lines.slice(section + 1)) {
      if (/^== .+: (ok|FAILED) \(/.test(l)) break;
      if (/^test at /.test(l)) block = 0;
      if (block++ < perTest + 1) picked.push(l);
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      if (FAILED_LINE.test(lines[i])) picked.push(...lines.slice(i, i + perTest));
    }
  }
  const out = picked.join("\n").trim().split("\n");
  if (out.length === 1 && out[0] === "") return "";
  return out.length > maxLines ? [...out.slice(0, maxLines), `... ${out.length - maxLines} more lines in the full output`].join("\n") : out.join("\n");
}
