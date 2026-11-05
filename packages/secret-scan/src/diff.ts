// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A line reader for the unified diffs `git diff-tree -p` prints. It trusts the hunk header counts (git wrote them), so a
// line that merely looks like a file header inside a hunk is content, and an added line is never taken for a header.

const MAX_PATH = 4096;
const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export type PatchEvent =
  /** The first sign that a file is part of the push (new file, `+++`, a binary marker). `deleted` files are never named. */
  | { readonly t: "file"; readonly path: string }
  /** An added line (without its `+` and without a trailing CR). */
  | { readonly t: "added"; readonly path: string | undefined; readonly line: number; readonly text: string }
  | { readonly t: "binary"; readonly path: string | undefined };

/** Decodes a git C-style quoted path (`"a/caf\303\251"`). Returns the text unchanged when it is not quoted. */
export function unquotePath(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c !== "\\") {
      for (const b of Buffer.from(c, "utf8")) bytes.push(b);
      continue;
    }
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4));
    if (oct) {
      bytes.push(parseInt(oct[0], 8) & 0xff);
      i += 3;
    } else {
      const e = esc[body[i + 1] ?? ""];
      if (e !== undefined) bytes.push(e);
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function stripPrefix(p: string): string {
  return (p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p).slice(0, MAX_PATH);
}

/** `diff --git a/P b/P` without renames: the two halves are equal, which finds P even when it holds spaces. */
function headerPath(rest: string): string | undefined {
  if (rest.startsWith('"') || rest.includes(' "b/')) {
    const i = rest.lastIndexOf(' "b/');
    return i < 0 ? undefined : stripPrefix(unquotePath(rest.slice(i + 1)));
  }
  const half = (rest.length - 5) / 2; // "a/" + P + " b/" + P
  if (Number.isInteger(half) && half > 0 && rest.slice(0, 2) === "a/" && rest.slice(2 + half, 5 + half) === " b/" && rest.slice(2, 2 + half) === rest.slice(5 + half)) {
    return rest.slice(2, 2 + half).slice(0, MAX_PATH);
  }
  const i = rest.lastIndexOf(" b/");
  return i < 0 ? undefined : rest.slice(i + 3, i + 3 + MAX_PATH);
}

export class PatchReader {
  private path: string | undefined;
  private deleted = false;
  private named = false;
  private oldLeft = 0;
  private newLeft = 0;
  private newLine = 0;
  private inBinary = false;

  /** Feeds one line (no newline). Returns what it means for the scan, or undefined. */
  read(raw: string): PatchEvent | undefined {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (this.oldLeft > 0 || this.newLeft > 0) {
      const c = line[0];
      if (c === "+" && this.newLeft > 0) return this.added(line);
      if (c === "-" && this.oldLeft > 0) {
        this.oldLeft--;
        return undefined;
      }
      if (c === " " || (c === undefined && line === "")) {
        if (this.oldLeft > 0) this.oldLeft--;
        if (this.newLeft > 0) this.newLeft--;
        this.newLine++;
        return undefined;
      }
      if (c === "\\") return undefined;
      // Anything else ends the hunk early (a malformed or cut diff): fall through and read it as a header.
      this.oldLeft = 0;
      this.newLeft = 0;
    }
    if (line.startsWith("diff --git ")) {
      this.path = headerPath(line.slice(11));
      this.deleted = false;
      this.named = false;
      this.inBinary = false;
      return undefined;
    }
    if (this.inBinary) return undefined;
    if (line.startsWith("@@ ")) {
      const m = HUNK.exec(line);
      if (m) {
        this.oldLeft = Number(m[1] ?? "1");
        this.newLeft = Number(m[3] ?? "1");
        this.newLine = Number(m[2]);
      }
      return undefined;
    }
    if (line.startsWith("deleted file mode")) {
      this.deleted = true;
      return undefined;
    }
    if (line.startsWith("new file mode")) return this.name();
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).replace(/\t.*$/, "");
      if (target === "/dev/null") return undefined;
      this.path = stripPrefix(unquotePath(target));
      return this.name();
    }
    if (line === "GIT binary patch" || (line.startsWith("Binary files ") && line.endsWith(" differ"))) {
      this.inBinary = line === "GIT binary patch";
      return this.deleted ? undefined : { t: "binary", path: this.path };
    }
    // An added line outside any hunk (a diff cut short, or not from git): still scanned, with an unknown line number.
    if (line.startsWith("+") && !line.startsWith("+++")) return { t: "added", path: this.path, line: 0, text: line.slice(1) };
    return undefined;
  }

  private name(): PatchEvent | undefined {
    if (this.named || this.deleted || this.path === undefined) return undefined;
    this.named = true;
    return { t: "file", path: this.path };
  }

  private added(line: string): PatchEvent {
    this.newLeft--;
    return { t: "added", path: this.path, line: this.newLine++, text: line.slice(1) };
  }
}
