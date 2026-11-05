// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Clean filters written as node scripts, for tests of content-filter handling.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** A clean filter written as a node script, and the repository config that uses it. */
export function withFilter(clean: string, smudge: string): (a: { repo: string; git: (...a: string[]) => string; write: (rel: string, d: string | Buffer) => void }) => void {
  return ({ repo, git, write }) => {
    const dir = join(repo, "..");
    writeFileSync(join(dir, "clean.cjs"), clean);
    writeFileSync(join(dir, "smudge.cjs"), smudge);
    git("config", "filter.vault.clean", `"${process.execPath}" "${join(dir, "clean.cjs")}"`);
    git("config", "filter.vault.smudge", `"${process.execPath}" "${join(dir, "smudge.cjs")}"`);
    write(".gitattributes", "*.dat filter=vault\n");
    write("vault.dat", "hello world\n");
  };
}
export const REVERSE = `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write([...s].reverse().join("")));`;
export const POINTER = `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const h=require("node:crypto").createHash("sha256").update(s).digest("hex");process.stdout.write("version https://git-lfs.github.com/spec/v1\\noid sha256:"+h+"\\nsize "+s.length+"\\n");});`;
export const PASS = `process.stdin.pipe(process.stdout);`;

