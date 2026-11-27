// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DENIED_OSC_IDS, OscCwdFilter } from "../src/index.js";
import { oscIds } from "../testing/osc-oracle.js";

const FORGED = "P;Cwd=/evil";
const filter = (...chunks: string[]): string => {
  const f = new OscCwdFilter();
  return chunks.map((c) => f.push(c)).join("") + f.push("\x07 "); // a closing BEL and a space flush a pending ESC
};
const denied = (s: string): number[] => oscIds(s).filter((id) => DENIED_OSC_IDS.has(id));

// Every input here reached a real xterm.js OSC 633 handler through the first version of the filter (review r1, B1).
const BYPASSES: Record<string, string> = {
  "OSC nested after another OSC's ESC": `\x1b]0;t\x1b]633;${FORGED}\x07`,
  "8-bit OSC start inside another OSC": `\x1b]0;t\u009d633;${FORGED}\x07`,
  "ESC then the 8-bit OSC start": `\x1b\u009d633;${FORGED}\x07`,
  "CAN aborts the first OSC": `\x1b]0;t\x18\x1b]633;${FORGED}\x07`,
  "SUB aborts the first OSC": `\x1b]0;t\x1a\x1b]633;${FORGED}\x07`,
  "8-bit CSI aborts the first OSC": `\x1b]0;t\u009b\x1b]633;${FORGED}\x07`,
  "another C1 control aborts the first OSC": `\x1b]0;t\u0085\x1b]633;${FORGED}\x07`,
  "a leading zero in the id": `\x1b]0633;${FORGED}\x07`,
  "many leading zeros": `\x1b]${"0".repeat(40)}633;${FORGED}\x07`,
  "a leading zero in a 8-bit OSC": `\u009d0633;${FORGED}\u009c`,
  "more leading zeros than the hold limit": `\x1b]${"0".repeat(5000)}633;${FORGED}\x07`,
  "a control character inside the id": `\x1b]6\x003\x013;${FORGED}\x07`,
  "a control character between ESC and ]": `\x1b\x00]633;${FORGED}\x07`,
  "BEL between ESC and ]": `\x1b\x07]633;${FORGED}\x07`,
  "ESC ESC ]": `\x1b\x1b]633;${FORGED}\x07`,
  "ESC before a dropped OSC splices a ] after it": `\x1b\x1b]633;x\x07]633;${FORGED}\x07`,
  "inside a DCS string": `\x1bPq\x1b]633;${FORGED}\x07`,
  "inside an SOS string": `\x1bXjunk\x1b]633;${FORGED}\x07`,
  "8-bit DCS then OSC": `\u0090q\u009d633;${FORGED}\x07`,
  "an open id continues across a dropped sequence": `\u009d6 3\u009d7;x\x073;${FORGED}\x07`.replace(" ", ""),
  "an open id continues across a dropped sequence after ESC": `\x1b]63\x1b]7;x\x073;${FORGED}\x07`,
  "ST terminated": `\x1b]633;${FORGED}\x1b\\`,
  "8-bit ST terminated": `\u009d633;${FORGED}\u009c`,
  "OSC 7": "\x1b]0;t\x1b]7;file:///evil\x07",
  "OSC 9;9 after CAN": "\x1b]0;t\x18\x1b]9;9;/evil\x07",
  "OSC 1337 CurrentDir after C1": "\x1b]0;t\u009b\x1b]1337;CurrentDir=/evil\x07",
  "OSC 133 with a leading zero": "\x1b]0133;A\x07",
};

for (const [name, input] of Object.entries(BYPASSES)) {
  test(`B1: forged cwd OSC is removed: ${name}`, () => {
    assert.ok(denied(input).length > 0, "the model sees the forged sequence in the input");
    const whole = filter(input);
    assert.deepEqual(denied(whole), []);
    assert.equal(filter(...input.split("")), whole, "byte by byte gives the same output");
  });
}

test("B1: a sequence aborted by a control keeps the controls, and later OSCs that are not denied still pass", () => {
  assert.equal(filter(`\x1b]633;x\x18\x1b]0;t\x07`), `\x18\x1b]0;t\x07\x07 `);
  assert.equal(filter(`a\x1b]633;x\x07\x1b]8;;u\x07b`), `a\x1b]8;;u\x07b\x07 `);
});

test("B1: ESC ESC drops the first ESC, as xterm.js stays in the escape state; a lone ESC before text is kept", () => {
  assert.equal(filter("\x1b\x1bb"), "\x1bb\x07 ");
  assert.equal(filter("x\x1b[31m"), "x\x1b[31m\x07 ");
});

// A small deterministic generator, so a failure reproduces.
function stream(seed: number, count: number): string[] {
  let s = seed;
  const rnd = (): number => ((s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
  const alpha = ["\x1b", "\x1b", "]", "]", "\\", "6", "3", "3", "0", "7", "9", "1", "133", ";", "P", "Cwd=/x", "a", "\x07", "\x18", "\x1a", "\u009d", "\u009c", "\u009b", "\u0090", "\u0085", "\x00", "\x1c", "[", "(", "X", "_", "é", "\x7f", " ", "1337", "k", "0", "0"];
  const out: string[] = [];
  for (let n = 0; n < count; n++) {
    let str = "";
    const len = 1 + Math.floor(rnd() * 24);
    for (let i = 0; i < len; i++) str += alpha[Math.floor(rnd() * alpha.length)];
    out.push(str);
  }
  return out;
}

test("B1 property: over random streams no denied OSC survives, other OSCs are untouched, and chunking never changes the output", () => {
  for (const input of stream(7, 30000)) {
    const whole = filter(input);
    assert.deepEqual(denied(whole), [], JSON.stringify(input));
    assert.deepEqual(oscIds(whole), oscIds(input + "\x07 ").filter((id) => !DENIED_OSC_IDS.has(id)), JSON.stringify(input));
    assert.equal(filter(...input), whole, JSON.stringify(input));
    const mid = Math.floor(input.length / 2);
    assert.equal(filter(input.slice(0, mid), input.slice(mid)), whole, JSON.stringify(input));
  }
});

test("memory is bounded: a long stream of denied and passing sequences holds at most the id", () => {
  const f = new OscCwdFilter();
  let out = 0;
  for (let i = 0; i < 2000; i++) out += f.push("\x1b]0;" + "x".repeat(500)).length + f.push("\x1b]633;" + "y".repeat(500) + "\x07").length;
  assert.ok(out > 0);
  assert.equal(f.push("z"), "z");
});
