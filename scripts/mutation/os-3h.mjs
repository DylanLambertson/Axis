// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// Mutation run for OS-3h, the acknowledged pty control hand-over (docs/design/own-shell-main-seam.md §3a), over the compiled files
// of @axis/daemon-host and @axis/pty-process.
//
//   npm run build && node scripts/mutation/os-3h.mjs "$PWD"
//
// Each mutant edits ONE compiled file, runs the tests that must catch it, and restores the file (scripts/mutation/run.mjs). The
// names are the ids in each test file's mutant list. Not part of the gate.
import { runMutants } from "./run.mjs";
const root = process.argv[2];
const DH = `${root}/packages/daemon-host/dist`;
const PP = `${root}/packages/pty-process/dist`;
const F = {
  a: `${DH}/src/main/pty-handover-acked.js`,
  d: `${DH}/src/entry.js`,
  v: `${DH}/src/supervisor.js`,
  e: `${PP}/src/entry.js`,
  s: `${PP}/src/service.js`,
};
const T = {
  a: [`${DH}/test/main-pty-handover-acked.test.js`, `${DH}/test/main-pty-handover-real.test.js`],
  d: [`${DH}/test/entry-handover.test.js`],
  v: [`${DH}/test/supervisor.test.js`],
  e: [`${PP}/test/entry-handover.test.js`],
  s: [`${PP}/test/control-latest.test.js`],
};
const M = [
  ["a", "A1 done on one acknowledgement", "if (f.acks.size < 2)", "if (f.acks.size < 1)"],
  ["a", "A2 any generation accepted", "if (this.#disposed || f === undefined || f.generation !== generation)", "if (this.#disposed || f === undefined)"],
  ["a", "A3 no retry", "if (this.#attempts < (this.#o.maxGenerations ?? DEFAULT_HANDOVER_GENERATIONS))", "if (false)"],
  ["a", "A3 unbounded retry", "if (this.#attempts < (this.#o.maxGenerations ?? DEFAULT_HANDOVER_GENERATIONS))", "if (this.#attempts < 99)"],
  ["a", "A4 no close instruction", 'this.#post(child, { type: "pty-control-close", generation });', ""],
  ["a", "A4 no teardown", "this.#o.teardown(side);", ""],
  ["a", "A6 the other port leaked", "this.#o.closePort(port2);", ""],
  ["a", "A6 the unposted pty port leaked", "if (!ptyPosted)", "if (false)"],
  ["a", "A8 no confirmation", 'this.#post(c, { type: "pty-control-confirmed", generation });', ""],
  ["e", "E1 no acknowledgement", 'answer({ type: "pty-control-adopted", generation });', ""],
  ["e", "E2 older generation adopted", "if (generation <= highest)", "if (false)"],
  ["e", "E4 no expiry", "if (held === mine && !mine.confirmed)", "if (false)"],
  ["e", "E5 close not applied", "if (held?.generation === generation)", "if (false)"],
  ["e", "E5 close not answered", 'answer({ type: "pty-control-closed", generation });', ""],
  ["s", "L1 replacement refused", "closeChannel(old);", "return { dispose: () => undefined };"],
  ["d", "D1 no acknowledgement", 'sendNote("pty-control-adopted", g);', ""],
  ["d", "D2 older generation adopted", "&& generation > highestGeneration", ""],
  ["d", "D3 no expiry", "if (held === mine && !mine.confirmed)", "if (false)"],
  ["d", "D4 close not applied", "if (held?.generation === m.generation)", "if (false)"],
  ["d", "D4 close not answered", 'sendNote("pty-control-closed", m.generation);', ""],
  ["v", "V1 answers dropped", "this.#o.onHandover?.(m);", ""],
  ["v", "V2 gate ignored", "if (this.#o.mayStart !== undefined && !this.#o.mayStart()) {", "if (false) {"],
  ["v", "V3 any bad_config restarted", ' || this.#fatalReason !== "pty_required"', ""],
  ["a", "A9 an answer from another instance counted", "            return;\n        if (from !== undefined && this.#children.get(side) !== from)\n            return;\n        f.acks.add(side);", "            return;\n        f.acks.add(side);"],
  ["a", "A10 retried while a side is starting", "if (waiting.some((side) => !this.#open(side)))", "if (false)"],
  ["a", "A10 torn down while starting", "if (!this.#open(side)) {", "if (false) {"],
  ["v", "V4 failHeld does nothing", "this.#fail(reason);", "void reason;"],
];
runMutants({ root, files: F, tests: T, mutants: M });
