// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PTY-EXEC-1: `exec` is not a launcher. The closed git subcommand list, the exact-token option rules and the fixed pin
// prefix the service puts in front of every exec (docs/design/daemon-host-hooks.md §4.1 and §4.3). Pure: no process, no file.

/** A git version as [major, minor, patch]. */
export type GitVersion = readonly [number, number, number];

/** Strict object id: SHA-1 or SHA-256 hex, lower case. */
export const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The only `config --get` keys (no `credential.*`, no `http.*`, no `--get-regexp`: the pty process holds the user's credentials, RR-29). */
const CONFIG_KEYS = new Set(["commit.gpgsign", "user.name", "user.email"]);
const REMOTE_URL_KEY = /^remote\.[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\.url$/;
const REV = /^[A-Za-z0-9_./@{}^~:-]{1,256}$/;
const COUNT = /^[1-9][0-9]{0,6}$/;

export interface ArgvContext {
  /** The absolute git path the service was started with. */
  readonly gitPath: string;
  /** The call carries `bind` (scratch index, scratch tree). */
  readonly bound: boolean;
  /** The git version the service detected at start, or undefined when unknown. */
  readonly version: GitVersion | undefined;
}

export type ArgvVerdict =
  | { readonly ok: true; readonly sub: string; readonly rest: readonly string[]; readonly pinless: boolean }
  | { readonly ok: false };

const BAD: ArgvVerdict = { ok: false };

export const atLeast = (v: GitVersion | undefined, want: GitVersion): boolean =>
  v !== undefined && (v[0] !== want[0] ? v[0] > want[0] : v[1] !== want[1] ? v[1] > want[1] : v[2] >= want[2]);

/** A positional argument: not an option, no NUL, a revision-like spelling. After `--end-of-options` it may start with `-`. */
const positional = (s: string, afterEnd: boolean): boolean => REV.test(s) && (afterEnd || !s.startsWith("-"));

/**
 * Reads `rest` with a set of bare flags, a set of flags taking one value (checked by `value`), and positionals.
 * Every option is matched as an exact token, so an abbreviation (`--ver`) or a glued value (`--short=4`) is refused.
 */
function readOptions(
  rest: readonly string[],
  flags: ReadonlySet<string>,
  valued: ReadonlyMap<string, (v: string) => boolean>,
): { flags: string[]; positionals: string[] } | undefined {
  const seen: string[] = [];
  const pos: string[] = [];
  let end = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (!end && a === "--end-of-options" && flags.has(a)) {
      end = true;
      continue;
    }
    if (!end && a.startsWith("-")) {
      const check = valued.get(a);
      if (check !== undefined) {
        const v = rest[++i];
        if (v === undefined || !check(v)) return undefined;
        seen.push(a);
        continue;
      }
      if (!flags.has(a)) return undefined;
      seen.push(a);
      continue;
    }
    if (!positional(a, end)) return undefined;
    pos.push(a);
  }
  return { flags: seen, positionals: pos };
}

const gitPathArg = (v: string): boolean => /^hooks\/[a-z-]{1,32}$/.test(v);

function checkSub(sub: string, rest: readonly string[], ctx: ArgvContext): { pinless: boolean } | undefined {
  const exactly = (want: readonly string[]): boolean => rest.length === want.length && want.every((w, i) => rest[i] === w);
  switch (sub) {
    case "rev-parse": {
      const r = readOptions(rest, new Set(["--verify", "--end-of-options", "--quiet", "--short", "--abbrev-ref", "--show-toplevel"]), new Map([["--git-path", gitPathArg]]));
      return r === undefined ? undefined : { pinless: false };
    }
    case "ls-tree": {
      const r = readOptions(rest, new Set(["-r", "-z", "--end-of-options"]), new Map());
      return r !== undefined && r.positionals.length >= 1 ? { pinless: false } : undefined;
    }
    case "rev-list": {
      const r = readOptions(rest, new Set(["--parents", "--objects", "--end-of-options"]), new Map([["-n", (v: string) => COUNT.test(v)]]));
      return r !== undefined && r.positionals.length >= 1 ? { pinless: false } : undefined;
    }
    case "write-tree":
      return rest.length === 0 ? { pinless: false } : undefined;
    case "var":
      return rest.length === 1 && (rest[0] === "GIT_AUTHOR_IDENT" || rest[0] === "GIT_COMMITTER_IDENT") ? { pinless: false } : undefined;
    case "symbolic-ref": {
      // Read form only: one positional, HEAD. The two-positional form writes a ref.
      const r = readOptions(rest, new Set(["--quiet", "--short"]), new Map());
      return r !== undefined && r.positionals.length === 1 && r.positionals[0] === "HEAD" ? { pinless: false } : undefined;
    }
    case "read-tree":
      // Only into the service's scratch index, one tree id, nothing else (`-u`, `-m`, `--index-output` would touch files).
      return ctx.bound && rest.length === 1 && OBJECT_ID.test(rest[0] as string) ? { pinless: false } : undefined;
    case "cat-file": {
      if (exactly(["--batch"]) || exactly(["--batch-check"])) return { pinless: false };
      const [mode, obj, ...more] = rest;
      return more.length === 0 && obj !== undefined && ["-t", "-s", "-p", "-e"].includes(mode as string) && positional(obj, false) ? { pinless: false } : undefined;
    }
    case "hash-object":
      // Bytes from stdin only, never a path (a path would read any file the pty process can), never written (`-w`).
      return exactly(["--no-filters", "--stdin"]) || exactly(["-t", "blob", "--no-filters", "--stdin"]) ? { pinless: false } : undefined;
    case "config": {
      // The one pinless read: the scope of the winning core.hooksPath (step 4). Before git 2.26 there is no --show-scope.
      if (exactly(["--show-scope", "--get-all", "core.hooksPath"])) return atLeast(ctx.version, [2, 26, 0]) ? { pinless: true } : undefined;
      if (exactly(["--get-all", "core.hooksPath"])) return ctx.version !== undefined && !atLeast(ctx.version, [2, 26, 0]) ? { pinless: true } : undefined;
      const key = rest[rest.length - 1] as string;
      const keyOk = CONFIG_KEYS.has(key) || REMOTE_URL_KEY.test(key);
      return keyOk && (exactly(["--get", key]) || exactly(["--type=bool", "--get", key])) ? { pinless: false } : undefined;
    }
    case "commit-tree": {
      const signed = rest[0] === "-S";
      const r = signed ? rest.slice(1) : rest;
      return r.length === 5 && r[0] === "-p" && OBJECT_ID.test(r[1] as string) && r[2] === "-F" && r[3] === "-" && OBJECT_ID.test(r[4] as string) ? { pinless: false } : undefined;
    }
    default:
      // update-ref, the write form of symbolic-ref, remote, diff, log, commit, fetch, clone, rebase, push, aliases, ...
      return undefined;
  }
}

/**
 * Decides whether `argv` is an allowed exec: `argv[0]` is the service's git, `argv[1]` a closed subcommand (so no global
 * option and no alias can follow git), and the rest matches that subcommand's exact-token rule.
 */
export function checkExecArgv(argv: readonly string[], ctx: ArgvContext): ArgvVerdict {
  if (argv[0] !== ctx.gitPath || argv.some((a) => a.includes("\0"))) return BAD;
  const sub = argv[1];
  if (sub === undefined) return BAD;
  const rest = argv.slice(2);
  const r = checkSub(sub, rest, ctx);
  if (r === undefined) return BAD;
  // The pinless read is a repository read only: never bound.
  if (r.pinless && ctx.bound) return BAD;
  return { ok: true, sub, rest, pinless: r.pinless };
}

/** The pins every call carries. `<off>` is git-ops' hooks-off path, fixed at service start. */
const commonPins = (off: string, withHooksPin: boolean): string[] => [
  ...(withHooksPin ? ["-c", `core.hooksPath=${off}`] : []),
  // Empty, not `false`: git 2.24 to 2.35 reads core.fsmonitor as a hook PATH, so `false` names a program found on PATH.
  "-c", "core.fsmonitor=",
  "-c", "protocol.allow=never",
  "-c", "protocol.ext.allow=never",
  // GIT_ALLOW_PROTOCOL=/ admits a helper transport named `/` (remote.<r>.vcs=/). Its `git remote-/` is no builtin, no
  // program and no alias, so git falls through to autocorrect, which with help.autocorrect set would run the closest alias
  // (`alias.remote-a`). `0` (suggest only) on every version; `never` exists only from git 2.37.
  "-c", "help.autocorrect=0",
];

/**
 * The lowest git the exec, scratch and hook messages accept, or undefined for none beyond what each feature needs. Only
 * git 2.44 and later honour GIT_NO_LAZY_FETCH, the one switch that stops a lazy fetch whatever the repository's transport
 * settings; below it the service relies on the transport and autocorrect pins (design §4.1, S1 note "Old git"). Setting
 * this to [2, 44, 0] refuses older git instead, at the cost of the distributions that ship it.
 */
export const MIN_GIT_VERSION: GitVersion | undefined = undefined;

/** The global options of a plain call (`repo` as `--git-dir`/`--work-tree`); the hooks pin is left out for the pinless read only. */
export function plainPrefix(repo: { gitDir: string; workTree: string }, off: string, sub: string, pinless: boolean): string[] {
  return [
    "--no-pager", "--no-replace-objects", `--git-dir=${repo.gitDir}`, `--work-tree=${repo.workTree}`,
    ...commonPins(off, !pinless),
    ...(sub === "commit-tree" ? ["-c", "i18n.commitEncoding=utf-8"] : []),
  ];
}

/** The global options of a bound call: no `--git-dir`/`--work-tree` (the redirectors are environment), the scratch-only pins added. */
export function boundPrefix(off: string): string[] {
  return ["--no-pager", "--no-replace-objects", ...commonPins(off, true), "-c", "core.attributesFile=", "-c", "core.pager=cat"];
}

/** Parses `git version X.Y.Z...`. */
export function parseGitVersion(text: string): GitVersion | undefined {
  const m = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}

/**
 * The `-c` pins that neutralise every configured filter driver, from `config --null --name-only --get-regexp ^filter\.`
 * output. Needed because git compares a racily clean index entry with the work tree THROUGH the clean or process filter
 * (`write-tree` does this when it writes the index back), so the design's fixed prefix alone does not keep filters from
 * starting. Undefined (refuse the call) for a driver name a `-c` pair could not carry exactly.
 */
export function filterPins(nameOnlyNul: string): string[] | undefined {
  const names = new Set<string>();
  for (const key of nameOnlyNul.split("\0")) {
    if (key === "") continue;
    const m = /^filter\.(.+)\.([^.]+)$/s.exec(key);
    if (m === null) return undefined;
    const name = m[1] as string;
    if (/[=\n\0]/.test(name) || name.length > 256) return undefined;
    names.add(name);
  }
  if (names.size > 256) return undefined;
  const pins: string[] = [];
  for (const n of names) for (const k of ["clean", "smudge", "process"]) pins.push("-c", `filter.${n}.${k}=`);
  for (const n of names) pins.push("-c", `filter.${n}.required=false`);
  return pins;
}
