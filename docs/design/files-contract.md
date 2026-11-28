# `axis.files/1` reads: list, stat, read (DC-1a)

Status: contract note for ticket DC-1a (`docs/design/own-shell-plan.md` DC-1), round 2, for review before any code. A NEW
contract. Writes (`write`, `create`, `rename`, `delete`) are DC-1b and get their own note; nothing here writes.

## 1. Why, and who

The Files module (OS-14) shows a worktree as a lazy tree and opens a file in a viewer. Today the daemon serves file bytes
only through `axis.review/1.content` (changed files, from the snapshot tree). `axis.files/1` reads the work tree itself.

- **Caller:** the `user` actor of the desktop shell only. Policy rows are `userRule(0)` for `list` and `stat`, and
  `userRule(1)` for `read`. Each handler also refuses any other actor itself (`E_NOT_FOUND`), as `axis.review/1` does.
- **Never reachable by:**
  - a plugin view: `axis.files/` joins `PLUGIN_DENY_CONTRACTS`;
  - a web caller: no files method joins `WEB_ALLOWED`;
  - a composer run, a CLI run or the messaging path: no binding gives them a files port.

  Tests pin each of these, including that the composer's and the CLI's tool tables have no route.
- **Untrusted projects:** reads are allowed, as for `diff` (ADR 0011, decisions 5.4 and 5.8). Nothing here runs a program
  of the repository: no git command reads content, and no hook, filter or fsmonitor can run.
- **Threat model, honestly.** The reader is the user's own renderer. A renderer that is compromised but still authorised
  can read everything these methods serve, sensitive files included (section 3.5). This contract does not protect against
  that renderer. It protects the files OUTSIDE the root, the Git directory, other projects, and the daemon (bounded work,
  no raw paths in errors).

## 2. Roots: a files-only, read-only adapter

The broker's `resolveRoot` is the composer's DMN-2 gate: it refuses any root inside a registered repository, so the local
checkout fails with `root-in-repository`. That exclusion stays as it is for the composer and the CLI. Files builds its
own registry for each call instead:

- **Target.** A strict, exclusive union: `{ workspaceId }` or `{ projectId }`, with no other key.
  - `{ workspaceId }`: the root is the workspace locator's journal-managed linked worktree, the canonical path the journal
    recorded at creation.
  - `{ projectId }`: the root is the DC-7 main-worktree row of `git worktree list` for the registered project (the hardened
    DC-7 reader, never checkout status or content filters). This is also the answer when the project was registered at a
    linked tree. A bare repository has no row: `E_NOT_FOUND` `not_found`.
- **The per-call registry** holds exactly that one root, under a fixed internal id, with `repositoryRoots()` empty. It is
  built inside the files handler for one call and is never shared, exported or reused. This is the documented
  user-read exception to DMN-2: DMN-2 keeps AGENT writes out of the user's checkout, and these are user reads.
- **No silent re-authorisation.** `resolveRoot` still requires the root to equal its own `realpath` at use. A workspace
  root that was replaced by a symlink, or whose parent was, is refused (`root-moved`, sent as `E_NOT_FOUND`). The checkout's
  authority is the project's registration: each call derives the main worktree again from git's common directory for that
  registered repository. A different repository at the same place is a different common directory and gives no row.
- **Root spelling.** The wire's `""` (only in `list`) becomes the broker's internal root form before the broker sees it.
  The request schema still refuses `.` and every other spelling of the root.

## 3. Paths and the dangerous parts

### 3.1 Path rules

- **Schema (first layer, the envelope's `E_INVALID_ARGUMENT`):**
  - the full joined path at most 4,096 UTF-8 bytes and 256 segments;
  - `relativePathSchema` rules: no absolute or drive path, no `\`, no empty, `.` or `..` segment, no control, bidi or
    zero-width character, no lone surrogate, no `.git` segment in any spelling;
  - also refused: a leading `:` or `-` segment, and a segment over 255 bytes.
- **Handler (second layer):** `@axis/broker` `lexicalSegments` for the daemon's own platform (reserved names, trailing dots
  and spaces, `:` streams, 8.3 short names on Windows). A refusal here is `E_INVALID_ARGUMENT` `invalid_path` from the
  handler, distinct from the schema's.

### 3.2 One containment implementation, extended

All three methods go through `@axis/broker`: `resolveTarget` then the matching opener. Today it cannot serve a directory or
a special file, so DC-1a adds two shared primitives to the broker. These are the only new containment code, reused later by
any caller that needs them:

| Primitive | What it does |
|---|---|
| `resolveTarget(..., "inspect")` (new mode) | Accepts any kind at the final name (file, dir, symlink, other) after the same parent and symlink rules. It opens nothing and returns `before` from `lstat`. Used only for `stat` of a special file: the answer is metadata, never bytes. |
| `openContainedDir(deps, target)` | Opens the directory with `O_RDONLY | O_DIRECTORY | O_NOFOLLOW`. Then it requires the open handle to be a directory with the identity seen at resolve time (`fstat` `dev:ino`), the parent still at the same real place, and, on Linux, the descriptor's path (`/proc/self/fd/N`) equal to the authorised real path. It returns a handle that enumerates and inspects through that descriptor (section 3.3). |

`openContained(..., "read")` stays as it is for regular files.

### 3.3 Listing a directory (B1: which directory was enumerated)

Checking the path before and after a listing does not prove which directory was read. A directory can be renamed aside,
replaced by a link to another place for the `opendir`, and restored before the last check. So the listing comes from the
opened descriptor itself:

- **Linux** (the daemon's supported production host): enumeration is `opendir("/proc/self/fd/N")`. The kernel resolves that
  magic link to the directory the descriptor holds, whatever its path names now. Child metadata is `lstat` of
  `/proc/self/fd/N/<name>`, which looks the name up in THAT directory and never follows the final link: the `fstatat`
  Node lacks.
  - A symlink child's `escapes` comes from `realpath` of the same handle-relative name.
  - If `/proc/self/fd` cannot be used (or `fdPath()` reports nothing), `list` refuses with `E_UNAVAILABLE`. It does not fall
    back to path checks.
- **macOS and Windows:** Node offers no handle-relative enumeration there. `list` opens the directory by path with
  `O_NOFOLLOW` and checks the handle's identity. It enumerates by path and checks the handle's identity and real path
  again after the last entry.
  - **Residual (stated, not claimed away):** a swap-and-restore of the directory between those checks can show names and
    kinds from another directory the daemon can read.
  - The listing grants nothing: names and kinds are advisory metadata. `stat` and `read` resolve and contain each path
    again, independently.
  - The race is registered as a residual (RR-100 or the next free number, checked at the time), and no test claims it is
    refused.
- **Every platform:** a per-entry `lstat` never follows. An entry whose metadata changed while it was read is shown as
  `kind: "other"`.

### 3.4 The rules

| Risk | Rule |
|---|---|
| **Symlinks** | `list` never follows a link. It shows `kind: "symlink"` with `escapes: true` when the target leaves the root or dangles. `stat` and `read` follow a final link only to a target inside the root, else `E_CONFLICT` `symlink_escape`. `list` of a linked directory works only when it resolves inside the root (`resolveTarget(..., "dir")`). A target is never put on the wire as a path, only as `targetInside: boolean`. |
| **`.git`** | Any path whose requested OR real segments match `matchProtected(...).gitDir` is refused for all three methods: `E_CONFLICT` `git_dir`. `list` leaves out an entry named `.git` (directory or file) entirely. `.git/config` can hold credentials, and git's own state is not the Files module's to show. A symlink whose real target is inside a `.git` is refused the same way. A nested repository's or submodule's own `.git` is refused at any depth; its other files are readable. `.gitignore`, `.gitattributes` and `.gitmodules` are readable (WT-3 may flag them). |
| **Folding** | `.git` and WT-3 match through `foldSegment`, on every host: NFKC, default-ignorable code points removed, case folded, and trailing dots and spaces dropped, plus 8.3 short names where enabled. So `.GIT` and `.Git` are the Git directory on Linux too. This is not `foldName` (NFC and case, by platform), which the broker uses for comparing real paths. The sensitive matcher (3.5) uses `foldSegment` too. |
| **Large files** | `read` returns at most `MAX_READ_TEXT_BYTES` = 262,144 UTF-8 bytes of text, the protocol's existing per-string ceiling (`MAX_STRING_BYTES`, checked by `guarded`, by `execute`, by the envelope schema and again by the client). The ceiling counts the decoded string's UTF-8 bytes in the structured-clone walk; there is no JSON step, so no quoting or escape overhead. A larger file answers its first part with `complete: false` and its `size`. There are no range reads in v1. The reply is one string of at most 256 KiB plus a few scalars, far inside the 1 MiB message with the envelope. No global limit changes. |
| **Decoding** | The file is opened and `fstat` decides the plan. At most `MAX_READ_TEXT_BYTES + 1` bytes are read from the descriptor, never by path, which also caps a sparse or growing file. The bytes go through a fatal UTF-8 decoder. When the read is known to be cut, it decodes in streaming mode: an unfinished final sequence is dropped (only that tail), and any malformed sequence in the bytes kept is still refused. At the true end of the file an unfinished sequence is malformed. A NUL or a malformed sequence in the bytes inspected means `binary`. Bytes after the returned part are not inspected: a file with binary content past the first 256 KiB is returned as text with `complete: false`. CRLF and a BOM are kept as they are (the BOM as U+FEFF). |
| **Binary files** | `{ kind: "binary", size, version }` with no bytes. |
| **Suspicious text** | Text goes on the wire raw (a JSON string), because the editor needs the real text. `suspicious: true` when the text holds a code point of `@axis/protocol`'s `CONTENT_REFUSED` set (C0 controls, DEL, C1, U+2028/9, every format character in `CF_RANGES`, including bidi controls, zero-width characters, joiners and tags, and `INVISIBLE_RANGES`). Tab, LF and CR are left out of that set, and so is one U+FEFF at offset 0. An emoji with a zero-width joiner is therefore `suspicious`; the flag is a hint for the editor to show markers (OS-18), never a refusal. Ordinary combining marks do not count. |
| **Protected paths (WT-3)** | The same matcher as `diff` (`matchProtected` with the host's extra rules) flags an entry `protectedPath: true` with `protectedRules` (at most 4 labels, each at most 64 characters). So the tree and the Changes list agree. A read is allowed; the flag matters for writes (DC-1b). |
| **TOCTOU** | `stat` and `read` of a file use `openContained`. After the open, the descriptor must be a regular file with the identity (`dev:ino`) seen at check time, the path must still name it, and the parent must still resolve to the same real place. On Linux the descriptor's own path must equal the authorised real path, and the files adapter refuses (`E_UNAVAILABLE`) when Linux cannot report it. Any mismatch refuses `E_CONFLICT` `changed`. The bytes come from that descriptor. A directory uses `openContainedDir` (3.2, 3.3). |
| **Special files** | FIFOs, sockets and devices are listed as `kind: "other"` and are never opened. `stat` answers them from `resolveTarget(..., "inspect")`; `read` refuses them (`E_INVALID_ARGUMENT` `not_regular`). The open uses `O_NONBLOCK`, so a FIFO swapped in after the check cannot block the daemon. That is not a deadline for every file system operation (a hung network mount can still stall a call until its timeout). |
| **Names on the wire** | Every entry has a `displayName` from `@axis/protocol` `toDisplayPath`, at most 255 units: control, bidi and zero-width code points become visible `\u{hex}` escapes, a literal backslash and an ellipsis are escaped, and the cut is safe. That is the same convention as `diff`, not the older lossy U+FFFD cleaner. The UI puts it in a text-only sink. `name` is the raw name only when the full joined path would pass the request rules of 3.1 (so the client can send it back). Otherwise `name: null` and `addressable: false`: it is shown, but cannot be opened in v1. |

### 3.5 Sensitive files (advisory)

- **One labelled matcher**, `matchSensitive(segments)`, runs over `foldSegment` forms of BOTH the requested and the real
  segments. In `read` it runs again on the real segments of the opened target. A match on either side counts.
- **Basename rules, at any depth:**
  - `env-file`: `.env`, `.env.*`, `.envrc`;
  - `private-key`: `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`,
    `id_ed25519*`;
  - `credentials-file`: `credentials` (so `.aws/credentials`), `.netrc`, `.pgpass`, `.npmrc`, `.pypirc`,
    `.git-credentials`;
  - `secrets-file`: `secrets.yml`, `secrets.yaml`, `secrets.json`, `*.tfvars`, `*.tfstate`;
  - `password-store`: `*.kdbx`.
- **Ancestor rules:** `secret-store-dir`, for everything under a segment named `.ssh`, `.gnupg`, `.aws`, `.kube` or
  `.docker`. So `.kube/config` and `.docker/config.json` are covered.
- **In `list`:** sensitive entries are listed (the user sees their own file names) with `sensitive: true`.
- **In `read`:** a sensitive file needs `reveal: true`, which the UI sends after the user clicks "Show contents".
  - Without it the answer is `E_CONFLICT` `sensitive`.
  - With it, one `files.reveal` audit event is written BEFORE any byte is returned: the target id, the connection id and
    the fixed rule label, never the path or content. If that write fails, the read fails closed (`E_INTERNAL`).
  - "One event" means one more than the ordinary policy decision row every call gets.
- **Advisory, and said so.** `reveal` is UI friction, not proof of a human click: a compromised authorised renderer can
  send it. That is accepted under ADR 0011 decision 5.8 (the user may view their own secret files) and is not native
  confirmation. If the product ever needs enforced consent, that is a separate, reviewed operation (a higher-tier method
  with the right side effect, or a main-minted single-use ticket bound to the connection, target, version and expiry), not
  a change to this read.
- **Best effort.** The matcher is a closed name set: an arbitrary name, or a hard link with an innocent name, evades it, and
  so does a hard link to a `.git` file. Content is never scanned, logged or cached by the daemon.

### 3.6 `version` and `contentDigest`

- **`version`** is an advisory freshness token, not content identity: an opaque digest of `dev`, `ino`, `size`, `mtimeNs`
  and `ctimeNs` from `fstat` of the SAME descriptor the bytes come from.
  - `read` takes that `fstat` before and after reading. If they differ, it retries once, then refuses `E_CONFLICT`
    `changed`.
  - A same-size in-place rewrite inside one timestamp quantum can leave `version` unchanged, so it must never decide a save
    alone.
- **`contentDigest`** (sha256 hex of exactly the bytes returned) comes only with a `complete: true` text reply. It is the
  base a DC-1b save must compare-and-swap on, as the broker's `swap.ts` does today: content digest, rehash and metadata
  check under the write lock.
- A `complete: false` or `binary` reply carries no `contentDigest`, so it cannot authorise an ordinary editor save. DC-1b
  specifies its own atomic-save residuals; a digest alone is not an atomic compare-and-rename.

### 3.7 Bounded work

- **Listing.** `list` enumerates incrementally (`Dir` iteration through the handle) and counts every raw entry. At entry
  20,001 it closes the handle and refuses `E_INVALID_ARGUMENT` `too_large`, before any sort.
  - At most 8 child `lstat` calls run at once.
  - Cancellation is checked between entries. The handle is closed in `finally`, and the request keeps its in-flight slot
    until the work has stopped.
- **Pages.** Each page enumerates again (at most 20,000 names), then sorts by raw name in UTF-16 code-unit order and
  returns at most 500 entries after the cursor. So one call costs at most one bounded directory read.
- **The cursor** is base64url text, at most 512 characters, of `{ v: 1, dir, after }`:
  - `dir` is 16 hex of a digest over the target id, the path and the directory's `dev:ino`;
  - `after` is the last raw name returned, so an entry with `name: null` still pages correctly.

  A cursor that does not decode, or whose `dir` does not match, is `E_INVALID_ARGUMENT` `bad_cursor`. A directory replaced
  between pages refuses `E_CONFLICT` `changed`. Names added or removed between pages are seen or missed by their sort
  position: there is no snapshot.
- **Inherited limits:** 16 requests in flight and 100 messages per second (burst 200) per connection, and 64 connections.
  Files adds no shared file-system work limit in v1: the per-call bounds above cap each request.
- **MethodSpecs**, all three: `sideEffect: "read"`, tier 0 (`list`, `stat`) or 1 (`read`), `idempotency: "none"` (so the
  pipeline never keeps a reply, and no content is replayed or stored), timeout 15 s.

## 4. The wire

```text
list { target, path, cursor? }
  -> { entries: Entry[], nextCursor?: string }
     Entry = { name: string | null, displayName, addressable, kind: "file" | "dir" | "symlink" | "other",
               size?: number (files), executable?: boolean (files),
               escapes?: boolean (symlinks: the target leaves the root or dangles),
               sensitive: boolean, protectedPath: boolean, protectedRules: string[] }

stat { target, path }
  -> { kind, size, executable, version, sensitive, protectedPath, protectedRules, targetInside? (symlink) }
     No times, no inode numbers, no owner on the wire.

read { target, path, reveal?: true }
  -> { kind: "text", text, size, complete, suspicious, version, contentDigest? (complete only) }
   | { kind: "binary", size, version }
```

Every schema is `guarded` and strict, as the other contracts are. `reveal` is only `true`. Scalars are bounded (`size` a
safe integer, labels at most 64 characters, `displayName` at most 255).

## 5. Errors on the wire

A handler cannot raise `E_POLICY_DENIED`: the daemon turns it into `E_INTERNAL` (`daemon/src/errors.ts`), because that
code belongs to the daemon's own audited policy decisions. A `BrokerError` also becomes `E_INTERNAL` if it escapes. So
the files handlers use handler codes only, with one closed reason enum exported from `@axis/protocol`
(`filesReasonSchema`):

| Code | Reasons |
|---|---|
| `E_NOT_FOUND` | `not_found` (no such path, or the target is not available to this caller) |
| `E_CONFLICT` | `git_dir`, `symlink_escape`, `sensitive`, `changed` |
| `E_INVALID_ARGUMENT` | `invalid_path` (the handler's lexical layer), `not_regular`, `not_a_directory`, `too_large`, `bad_cursor` |
| `E_UNAVAILABLE`, `E_CANCELLED`, `E_INTERNAL` | no reason |

- **The mapper is an exhaustive `switch` over the broker's `Reason` type**, so a new broker reason fails the typecheck
  until it is mapped:

  | Broker reason | Wire |
  |---|---|
  | `not-found`, `unregistered`, `root-moved`, `root-in-repository` | `E_NOT_FOUND` `not_found` |
  | `symlink-escape`, `symlink-dangling`, `outside-root` | `E_CONFLICT` `symlink_escape` |
  | `swapped`, `stale`, `path-changed` | `E_CONFLICT` `changed` |
  | `not-regular` | `E_INVALID_ARGUMENT` `not_regular` |
  | `invalid-path`, `dotdot`, `backslash`, `drive-prefix`, `unc-or-device`, `win-name`, `invalid-call` | `E_INVALID_ARGUMENT` `invalid_path` |
  | `aborted` | `E_CANCELLED` |
  | every other reason (`fs-error`, `hardlink`, `exists`, `too-large`, and the approval, tool and git reasons a read never reaches) | `E_UNAVAILABLE` |
- **Generic errors.** A request the schema refuses is the envelope's own `E_INVALID_ARGUMENT` before any handler runs. The
  generic envelope errors (cancel, timeout, backpressure, unavailable, internal) are separate from this set.
- **Messages are fixed.** Error text never holds a path. Nothing from a file system error (message, `cause`, a getter) is
  copied into a reply or a diagnostic.

## 6. What it never does

- No write, no create, no `chmod`, no git command on content, no program of the repository.
- No path out of the root on the wire: a symlink's target is a boolean, never a string.
- No path, name or content in logs or audit rows (`files.reveal` carries ids and a rule label).
- No caching of content in the daemon: every read opens the file again, and `idempotency: "none"` keeps the pipeline from
  keeping replies.
- No following of a symlink to a directory outside the root, in any method.
- No route into a model prompt or the messaging path: user-selected secret-file display (3.5) is a separate behaviour from
  the vault and provider credential isolation (1b/L11), which a file-name list does not establish.

## 7. Residuals

New residuals are registered from RR-100 (the highest at main is RR-99; rechecked against other open branches before
assigning).

- **Hard links.** A file replaced by a hard link to a file elsewhere on the same file system, between the user's last
  listing and a read, is read: a hard link is a real name inside the root. Neither `.git` nor the sensitive rules see an
  innocently named hard link (to `.git/config`, say). Writes (DC-1b) refuse a file with more than one link; reads do not,
  as `@axis/broker` does today.
- **macOS and Windows listing:** the swap-and-restore race of 3.3. Also, there is no descriptor path, so `read`'s
  after-open check relies on the identity and path checks only.
- **Mounts.** This is path confinement, not mount isolation: a mount point or bind mount inside the root is inside.
- **Contents are not frozen.** A descriptor that passed its checks keeps reading the same inode, but an in-place writer can
  change the bytes while they are read. 3.6 detects a change it can see in the metadata; it is not a snapshot.
- **Windows** junctions and reparse points are tested on POSIX fixtures only (as FT-1's gate notes, 1a/L27). Native
  Windows behaviour is unverified until run there.

## 8. Tests (written first)

Real files throughout, with the swap seams `@axis/broker` already has for interleaving a change between check and use.

- Protocol:
  - every schema guarded and strict, and the exclusive target union;
  - path rules on both platforms' spellings, 4,096 bytes and 256 segments;
  - the closed reasons;
  - `reveal` only `true`;
  - bounds: 500 entries, a forged and an oversized cursor, and labels.
- Round trip, daemon to client through the real envelope and reader:
  - a text reply of 262,144 bytes is complete, and 262,145 is cut with `complete: false`;
  - each refusal of section 5, with the code and reason the client sees;
  - a hostile file system error (a message with a path, a `cause`, a throwing getter) never reaches the reply.
- Roots:
  - the root listing (`""`);
  - a checkout registered through a linked tree;
  - a workspace root reached through a symlinked parent at registration, then that root or parent replaced;
  - the composer's and the CLI's registries still refuse the checkout;
  - a bare repository gives `not_found`.
- Listing (B1):
  - a deterministic swap-and-restore seam around the open: on Linux the names come from the opened directory or the call
    is refused, never from the other directory;
  - a swap during a per-entry `lstat` gives no wrong type;
  - `/proc/self/fd` unavailable refuses.
- Symlinks:
  - a link to `/etc/passwd` is listed as `escapes: true`, and `read` is refused;
  - a link inside the root is read, and a dangling link is `escapes: true`;
  - a directory link out of the root is not listed through;
  - a link into `.git` is refused.
- `.git`:
  - `.git`, `.GIT` (on Linux too), `GIT~1` and `a/.git/config` are refused;
  - a linked worktree's `.git` file is left out of `list`.
- Sensitive:
  - every rule label, including `.aws/credentials` and `.kube/config`;
  - `notes.txt -> .env` and `.env -> notes.txt` both need `reveal`;
  - folded variants, and false-positive controls (`environment.ts`, `keys.md`);
  - the audit is written before the bytes, and an audit failure fails closed;
  - a test that documents the compromised-renderer case.
- Decoding:
  - a multibyte character straddling the byte cap is dropped from the tail, not called binary;
  - a malformed interior sequence, and an unfinished sequence at the true end, are binary;
  - a NUL in the inspected bytes is binary;
  - CRLF and a BOM come back exact;
  - `suspicious` for a bidi control and a zero-width joiner, and not for an ordinary combining mark.
- `version` and `contentDigest`:
  - a modelled same-size rewrite with unchanged metadata keeps `version` but changes `contentDigest`;
  - a change between `fstat` and the read, or during the read, retries and then refuses;
  - a `complete: false` reply has no `contentDigest`.
- Bounded work:
  - a counted iterator proves enumeration stops at entry 20,001;
  - at most 8 `lstat` calls are active;
  - cancellation closes the iterator;
  - a full page of unaddressable names pages correctly;
  - an idempotency key never caches a read.
- Special files:
  - a FIFO swapped in does not block (under a real timeout, with child cleanup);
  - socket and device `stat` come from `lstat`, and `read` refuses them;
  - a directory named like a file is handled.
- Callers:
  - an agent actor gets `E_NOT_FOUND`;
  - a plugin and a web connection are denied by policy;
  - the composer's tool table has no files route;
  - an untrusted project's workspace is readable.
- Platform-parameterised case, 8.3, NFC and NFD cases.
- Mutants to kill:
  - no `.git` check on the real segments;
  - a symlink followed without the inside check;
  - no identity check after the open, and no identity check of the opened directory;
  - enumeration by path instead of through the handle on Linux;
  - `reveal` ignored;
  - the sensitive match on the requested side only, and on the resolved side only;
  - a name sent raw although it fails the path rules;
  - collect all entries then refuse, instead of stopping early;
  - replacement decoding instead of the fatal streaming decoder;
  - a metadata-only token used as the save base (the content-CAS test fails).
