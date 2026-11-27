// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// The mutation runner shared by scripts/mutation/*.mjs (N1f review 1 nit 3). A mutant is
// [fileKey, name, from, to] or [fileKey, name, from, to, equivalentReason]:
//
// - it replaces the ONE occurrence of `from` with `to` in the compiled file, runs the tests listed for that file, and
//   restores the file;
// - a plain mutant must be KILLED (the tests fail); one that survives fails the run;
// - an EQUIVALENT mutant (a fifth field, the reason it cannot change behaviour) is RUN too and must SURVIVE: if a test
//   kills it, it was not equivalent, and the run fails and asks for it to be reclassified;
// - an anchor found 0 or 2+ times is STALE and fails the run, so the list keeps up with the code;
// - a missing test file, a spawn error, a timeout or a signal is an ERROR, never counted as "killed". The tests run with
//   --test-force-exit, so a mutant that fails its tests but leaves a handle open (a hung socket) still ends and counts as
//   killed by its failing tests, not by the clock.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

/** Runs `mutants` and exits 0 only when every plain mutant is killed and every equivalent survives. */
export function runMutants({ root, files, tests, mutants, timeoutMs = 300_000 }) {
  for (const [k, list] of Object.entries(tests)) {
    for (const t of list) {
      const path = t.startsWith("/") ? t : `${root}/${t}`;
      if (!existsSync(path)) {
        console.log(`ERROR   test file for ${k} is missing: ${t}`);
        process.exit(2);
      }
    }
  }
  const orig = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, readFileSync(f, "utf8")]));
  const tally = { killed: 0, equivalent: 0, survived: 0, stale: 0, error: 0, misclassified: 0 };
  try {
    for (const [f, name, from, to, equivalent] of mutants) {
      const n = orig[f].split(from).length - 1;
      if (n !== 1) {
        console.log(`STALE(${n}) ${name}`);
        tally.stale++;
        continue;
      }
      writeFileSync(files[f], orig[f].replace(from, to));
      const r = spawnSync(process.execPath, ["--test", "--test-force-exit", "--test-timeout=60000", ...tests[f]], { cwd: root, encoding: "utf8", timeout: timeoutMs });
      writeFileSync(files[f], orig[f]);
      if (r.error !== undefined || r.signal !== null || r.status === null) {
        console.log(`ERROR   ${name} (${r.error?.code ?? r.signal ?? "no exit status"})`);
        tally.error++;
        continue;
      }
      const killed = r.status !== 0;
      if (equivalent !== undefined) {
        if (killed) {
          console.log(`MISCLASSIFIED ${name}: marked equivalent (${equivalent}) but a test kills it`);
          tally.misclassified++;
        } else {
          console.log(`equivalent ${name}`);
          tally.equivalent++;
        }
      } else if (killed) {
        console.log(`killed  ${name}`);
        tally.killed++;
      } else {
        console.log(`SURVIVED ${name}`);
        tally.survived++;
      }
    }
  } finally {
    for (const k of Object.keys(files)) writeFileSync(files[k], orig[k]);
  }
  console.log(`${mutants.length} mutants: ${tally.killed} killed, ${tally.equivalent} equivalent (ran, survived as expected), ${tally.survived} survived, ${tally.stale} stale, ${tally.error} errors, ${tally.misclassified} misclassified`);
  process.exit(tally.survived + tally.stale + tally.error + tally.misclassified === 0 ? 0 : 1);
}
