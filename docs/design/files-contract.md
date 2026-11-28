# `axis.files/1` reads: list, stat, read (DC-1a)

Status: contract note for ticket DC-1a (`docs/design/own-shell-plan.md` DC-1), for review before any code. A NEW contract.
Writes (`write`, `create`, `rename`, `delete`) are DC-1b and get their own note; nothing here writes.

## 1. Why, and who

The Files module (OS-14) shows a worktree as a lazy tree and opens a file in a viewer. Today the daemon serves file bytes
only through `axis.review/1.content` (changed files, from the snapshot tree). `axis.files/1` reads the work tree itself.

- **Caller:** the `user` actor only. Policy rows are `userRule(0)` for `list` and `stat`, and `userRule(1)` for `read`.
  Each handler also refuses any other actor itself (`E_NOT_FOUND`), as `axis.review/1` does.
- **Never reachable by:** a plugin view (the contract joins `PLUGIN_DENY_CONTRACTS`), a composer run, a CLI run or the
  messaging path. No binding gives them a files port, and a test pins that the composer's and CLI's tool tables have no
  route to it.
- **Untrusted projects:** reads are allowed, as for `diff`. Nothing here runs a program of the repository: no git
  command reads content, and no hook, filter or fsmonitor can run.

## 2. Addressing

- **Target.** `{ workspaceId }` for an Axis workspace, or `{ projectId }` for the project's local checkout (the DC-7 row:
  the main worktree from `git worktree list`; a bare repository has none and answers `E_NOT_FOUND`). The daemon resolves
  the root itself (`locator` for a workspace, the worktree list for a checkout), canonicalises it with `realpath`, and
  never takes a root from the request.
- **Path.** A repository-relative `path` string, or `""` for the root in `list`. The schema is the first layer:
  - the existing `relativePathSchema` rules (no absolute or drive path, no `\`, no empty, `.` or `..` segment, no
    control, bidi or zero-width character, no `.git` segment in any spelling, at most 4,096);
  - also refused: a leading `:` or `-` segment, and a segment over 255 bytes.

  The handler then applies `@axis/broker`'s WT-1 lexical rules for the daemon's own platform (`lexicalSegments`: lone
  surrogates, and on Windows reserved names, trailing dots or spaces, `:` streams and 8.3 short names).
- **One resolver.** All three methods resolve through `@axis/broker` `resolveTarget` (the real parent must lie under the
  real root; a final symlink is followed only to a target inside it) and open through `openContained`, the same code that
  confines the composer's file tools today. No second implementation.

## 3. The dangerous parts

| Risk | Rule |
|---|---|
| **Symlinks** | `list` never follows a link; it shows it as `kind: "symlink"` with `escapes: true` when its target leaves the root, or dangles. `stat` and `read` follow a final link only to a target inside the root (`resolveTarget`), else `E_POLICY_DENIED` `symlink_escape`. A link to a directory is listed through only when it resolves inside the root (`list` of a path uses `resolveTarget(..., "dir")`). A target is never put on the wire as a path, only as `targetInside: boolean`. |
| **Case folding** | On macOS and Windows names compare folded and NFC-normalised (`foldName`), so `.GIT`, `.Git`, `GIT~1` and a decomposed `.git` are the Git directory. Protected and sensitive rules match folded names too. |
| **`.git`** | Any path with a Git-directory segment (matched by `matchProtected(...).gitDir` on both the requested and the real segments) is refused for all three methods: `E_POLICY_DENIED` `git_dir`. `list` leaves out an entry named `.git` (directory or file) entirely. `.git/config` can hold credentials, and git's own state is not the Files module's to show. A symlink whose real target is inside a `.git` is refused the same way. |
| **Large files** | `read` returns at most `MAX_READ_BYTES` (512 KiB) of a file. A larger file answers its first 512 KiB with `complete: false` and the `size`; no range reads in v1. The file is opened, `fstat` decides the plan, and at most `MAX_READ_BYTES + 1` bytes are read from the descriptor, never by path. |
| **Binary files** | Content that is not valid UTF-8, or holds a NUL in the bytes read, answers `{ binary: true, size }` with no bytes. Text goes on the wire raw (a JSON string), never escaped, because the editor needs the real text. The renderer shows invisible and bidi characters as the editor kit marks them (OS-18), and the reply says `suspicious: true` when the text holds a bidi control or a zero-width character (Trojan Source). |
| **Message size** | A text reply's JSON-encoded text must fit `MAX_READ_JSON` (768 KiB; control characters expand to `\u00XX`). Past that, the text is cut at the last whole code point that fits, with `complete: false`. |
| **Secret files** | A closed set of names is `sensitive`: `.env` and `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`, `.netrc`, `.pgpass`, `.npmrc`, `.pypirc`, `.git-credentials`, `credentials`, `*.keystore` (folded where names fold). They are listed (the user sees their own files) with `sensitive: true`. `read` of one needs `reveal: true` in the request, which the UI sends only after the user clicked "Show contents". Without it the answer is `E_POLICY_DENIED` `sensitive`. A reveal writes one audit row, `files.reveal`, with the target id and the matched rule label, never the path or any content. Content is never scanned, logged or cached by the daemon. |
| **Protected paths (WT-3)** | The same matcher as `diff` (`@axis/broker` `matchProtected`, with the host's extra rules) flags an entry `protectedPath: true` with `protectedRules` (at most 4 labels), so the tree and the Changes list agree. A read is allowed; the flag matters for writes (DC-1b). |
| **TOCTOU** | `stat` and `read` use `openContained`: after the open, the descriptor must be a regular file with the identity (`dev:ino`) seen at check time, the path must still name it, the parent must still resolve to the same real place, and on Linux the descriptor's own path (`/proc/self/fd`) must lie under the root. Any mismatch refuses `E_CONFLICT` `changed`. The bytes come from that descriptor. For `list`, the directory's real path and `dev:ino` are taken before `opendir` and again after the last entry; a difference refuses the whole listing (`changed`), so a directory swapped mid-listing leaks no names. The per-entry `lstat` never follows. |
| **Special files** | FIFOs, sockets and devices are listed as `kind: "other"` and are never opened: `stat` answers them from `lstat`, and `read` refuses `not_regular`. The open uses `O_NONBLOCK`, so a FIFO swapped in after the check cannot block the daemon. |
| **Names on the wire** | An entry's `name` goes on the wire as is only when it would pass the request path rules (so the client can send it back). Otherwise the entry has `name: null`, a `displayName` escaped by `@axis/protocol` `toDisplayPath` (control, bidi and zero-width characters shown as U+FFFD, at most 255), and `addressable: false`. It is shown but cannot be opened in v1. |

## 4. The wire

```text
list { target, path, cursor? }
  -> { entries: Entry[], nextCursor?: string }
     Entry = { name: string | null, displayName, addressable, kind: "file" | "dir" | "symlink" | "other",
               size?: number (files), executable?: boolean (files),
               escapes?: boolean (symlinks: the target leaves the root or dangles),
               sensitive: boolean, protectedPath: boolean, protectedRules: string[] }
     At most 500 entries per reply, sorted by name in UTF-16 code-unit order; nextCursor is the last name returned,
     opaque to the client. A directory over 20,000 entries answers E_INVALID_ARGUMENT too_large.

stat { target, path }
  -> { kind, size, executable, version, sensitive, protectedPath, protectedRules, targetInside? (symlink) }
     version = an opaque digest of dev, ino, size, mtimeNs and ctimeNs: the compare-and-swap token DC-1b writes will
     need, carried from day one. No times, no inode numbers, no owner on the wire.

read { target, path, reveal?: true }
  -> { kind: "text", text, size, complete, suspicious, version }
   | { kind: "binary", size, version }
```

Every schema is `guarded` and strict, as the other contracts are. Error `details.reason` comes from a closed set:

- `E_NOT_FOUND`: `not_found` (no such path, or the target is not available to this caller);
- `E_POLICY_DENIED`: `git_dir`, `symlink_escape`, `sensitive`, `invalid_path`;
- `E_INVALID_ARGUMENT`: `not_regular`, `not_a_directory`, `too_large`;
- `E_CONFLICT`: `changed`.

Error text is fixed and never holds a path.

## 5. What it never does

- No write, no create, no `chmod`, no git command on content, no program of the repository.
- No path out of the root on the wire: a symlink's target is a boolean, never a string.
- No path, name or content in logs or audit rows (the one audit row, `files.reveal`, carries ids and a rule label).
- No caching of content in the daemon; every read opens the file again.
- No following of a symlink to a directory outside the root, in any method.

## 6. Residuals

- A file replaced by a hard link to a file elsewhere on the same file system, between the user's last listing and a
  read, is read: a hard link is a real name inside the root. Writes (DC-1b) refuse a file with more than one link; reads do
  not, as `@axis/broker` does today.
- On macOS and Windows there is no `/proc/self/fd`: the after-open check relies on the identity and path checks only.
- Windows junctions and reparse points are tested on POSIX fixtures only (as FT-1's gate notes, 1a/L27).

## 7. Tests (written first)

Real files throughout, with the swap seams `@axis/broker` already has for interleaving a change between check and use.

- Protocol:
  - every schema guarded and strict;
  - path rules on both platforms' spellings;
  - the closed reasons;
  - `reveal` only `true`;
  - bounds (500 entries, the cursor, 512 KiB, the JSON bound).
- Symlinks:
  - a link to `/etc/passwd` is listed as `escapes: true`, and `read` is refused;
  - a link inside the root is read;
  - a dangling link is `escapes: true`;
  - a directory link out of the root is not listed through;
  - a link into `.git` is refused.
- `.git`:
  - `.git`, `.GIT` (on a folding platform rule set), `GIT~1` and `a/.git/config` are refused;
  - a linked worktree's `.git` file is left out of `list`.
- Case folding: sensitive and protected rules match `.ENV` and `ID_RSA` where names fold, and only there.
- Large and binary:
  - 512 KiB + 1 is cut with `complete: false`;
  - a NUL means binary;
  - invalid UTF-8 means binary;
  - a file of control characters stays under the JSON bound.
- Secrets:
  - `.env` is listed `sensitive`;
  - a read without `reveal` is refused;
  - a read with `reveal` returns the text and writes one audit row with no path.
- TOCTOU:
  - a file swapped for a symlink out of the root between resolve and open is refused `changed`;
  - a directory swapped mid-listing is refused;
  - a FIFO swapped in does not block.
- Callers:
  - an agent actor gets `E_NOT_FOUND`;
  - a plugin connection is denied by policy;
  - the composer's tool table has no files route;
  - an untrusted project's workspace is readable.
- Mutants to kill:
  - no `.git` check on the real segments;
  - a symlink followed without the inside check;
  - no identity check after the open;
  - `reveal` ignored;
  - a listing without the before/after directory identity;
  - a name sent raw although it fails the path rules.
