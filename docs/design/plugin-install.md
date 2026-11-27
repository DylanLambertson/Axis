# Plugin packages: manifest, signature, extraction, install and update (ticket PV-K2, package part)

- **Status:** design only, not built. Date 2026-11-27; revised the same day after review 1 (package scope, a durable
  publication protocol, reinstall, curated downgrade, load bounds, portable names, audit) and the decisions on its open points,
  and after review 2 (the package lock, consent bound to the revision, identity equality, downgrade-reinstall, the stored
  listing) and review 3 (a durable fsync before every adoption, pure verification under the lock, bounded lock waits, the daemon's
  own disable).
- **Scope:** the plugin package (manifest, files, signature), where a signature's trust comes from, how an archive is verified
  and extracted, and the install, update, uninstall and load-integrity flows. The grant calls are
  `plugin-grant-contract.md`'s; this note only says how install and update reach them.
- **Not in scope:** the plugin host and loading a bundle into a view (PV-K3; §5.6 is its handoff); `net:<origin>` and
  `integration:<id>` (ADR 0009, refused at install until then); P2 (refused until Phase 3); any network fetch (none in v1); the own
  shell's install UI and the approval card (own-shell plan; this note fixes what they get from the daemon).
- **Sources:** ADR 0008 decisions 2, 3, 6, 7 and 8 and its amendments (threat model 4a, the main-built dialog); ADR 0005 D4 (the
  runtime import rule); `extensibility.md` §3.4, §3.5 and §4; `threat-model-phase4a.md` PLG-4, PLG-5, PLG-6, PLG-8, PLG-9,
  PLG-16, OI-6, gate lines 4a/L3 to 4a/L6, 4a/L11, 4a/L12, 4a/L14 to 4a/L16 and 4a/L26; residuals RR-59, RR-60, RR-61 and RR-72;
  `plugin-grants.md`; `plugin-grant-contract.md`; `project-registration-and-trust.md` §4 and §5.

## 1. Decisions

Decided (2026-11-27, owner delegation, reversible) after review 1; the reasons are in the sections named.

1. **Install, update and downgrade are main-owned control flows**, like project registration: a strict, sender-checked renderer
   request that names no path, main's own picker, the daemon's inspection, main's cancel-default modal dialog from the daemon's
   answer, then main's commit message. Not protocol methods and never a tier; uninstall is a tier-2 protocol method (§5.5).
2. **Packages are shared and immutable; installations are per project** (§2.4). A package is stored once per full identity (id,
   version, bundle hash). Each project has its own installation record, version, requests, consent and grants. An update or an
   uninstall in one project never changes another project.
3. **Install and update never grant.** They record the permissions the installed version **requests**. Each grant is its own
   tier-4 `axis.plugins/1.grant`, refused `not_requested` for a permission the installation does not request, checked before the
   dialog and again under the project lock at the write (§6.2). An update keeps only the intersection of the old grants and the
   new requests.
4. **Every update ends every unspent plugin challenge** of that project, approved-but-unspent included, and raises the
   installation's revision, which the run-start binding pins: no run is recorded for a challenge approved before the update
   (§5.3).
5. **The archive is a narrow ZIP subset read by a small validator** over one bounded buffer plus `node:zlib`, with no ZIP library
   and no general extraction API (§4.4).
6. **The daemon does the file work** inside its data directory; main never extracts or reads plugin files.

## 2. The package

### 2.1 The archive

A plugin is one ZIP file (`.axisplugin`), at most 50 MiB. The root holds `axis-plugin.json` (the manifest), `axis-plugin.sig`
(the optional signature) and the bundle under `bundle/`; nothing else. Only `bundle/` is hashed (§2.3) and served (PV-K3).

### 2.2 The manifest

`axis-plugin.json`, at most 64 KiB of UTF-8 with no byte order mark, read by the manifest profile of §3.4 and a strict schema:

| Field | Rule |
|---|---|
| `manifestVersion` | the integer `1` |
| `id` | `pluginIdSchema`, at most 64 characters (ADR 0008 decision 3) |
| `version` | strict SemVer 2.0: `MAJOR.MINOR.PATCH` with no leading zero, an optional prerelease, no build metadata; each number a safe integer. Ordered by SemVer precedence (`1.0.0-2` < `1.0.0-10` < `1.0.0`) |
| `tier` | `"P0"` or `"P1"`; `"P2"` refused (4a/L11) |
| `name`, `description` | display text, at most 64 and 512 characters, escaped wherever shown; **never** in a native dialog line, an audit row or a log |
| `permissions` | a set from the closed list of `plugin-grants.md` §1; `net:` and `integration:` refused until ADR 0009 (4a/L11) |
| `origins`, `integrations` | empty arrays until ADR 0009 |
| `contributes` | the closed set of `extensibility.md` §3.4, each kind with a strict schema and a count cap; a P0 package contributes no P1 view |
| `entry` | P1 only: a path under `bundle/` to an `.html` file of the bundle |

The **canonical manifest** is the RFC 8785 (JCS) form of the parsed value: what the signature covers, what the journal records
and what an update's diff compares.

### 2.3 The bundle hash

The SHA-256 of a canonical listing of `bundle/`: one record per file, sorted by path in byte order (paths are ASCII, §4.2),
each `path NUL size NUL sha256-hex LF`. It never depends on archive bytes, so compression, order, timestamps or attributes
cannot give two hashes for one bundle or one hash for two. Repacking a bundle keeps its hash; that is intended.

### 2.4 Packages and installations

- A **package** is everything immutable about one verified archive: the id, the version, the bundle hash, the canonical
  manifest, the kind (curated or unsigned) and the curated publisher key. Its **identity hash** is the SHA-256 of
  `axis.plugin.package/1 NUL id NUL version NUL bundleHash NUL sha256(canonical manifest) NUL kind NUL publisherKey-or-empty`,
  64 hex digits. Two archives with the same bundle but different manifests or provenance are therefore **different packages**,
  and an existing identity can only ever be the same package (review 2 S2). A row whose identity exists but whose stored fields
  differ is refused `identity_conflict` (only a hash collision could cause it), never repaired.
- The package's files are stored at `<dataDir>/plugins/packages/<identity hash>/bundle/`, and nothing else is in that directory:
  the manifest and the signature live in the journal row (§6.1). The directory never changes after publication. Any number of
  installations may reference it.
- The **canonical listing** of §2.3 is stored with the package row. Its SHA-256 is the bundle hash, so the stored listing is
  authenticated by the trusted hash, and it is the expectation every later check reads (§5.6).
- An **installation** is one plugin in one project: its package identity, its state (`installed` or `uninstalled`), a
  **revision** that rises by one at every committed install, update, downgrade or uninstall, the highest version ever installed
  there, and the curated publisher key it was bound to (if any). Requests and grants hang off the installation.
- A package directory no installation references is garbage and is removed (§5.7).

## 3. Signatures and their trust root

### 3.1 The signature file

`axis-plugin.sig` is strict JSON `{ "alg": "ed25519", "keyId": <16 lowercase hex>, "signature": <canonical base64url of exactly
64 bytes> }`. The signed message is the bytes of `axis.plugin.sig/1`, NUL, the canonical manifest, NUL, and the 32-byte bundle
hash. It binds id, version, tier, permission requests, contributions, display fields and the bundle together (4a/L16).
- Verification is Node's `crypto.verify(null, message, key, signature)`, never custom curve code. Exact key (32 bytes) and
  signature (64 bytes) lengths and canonical encodings are checked before import: Node's tolerant decoders never define the
  grammar.
- `keyId` is a lookup hint only (the first 16 hex of the SHA-256 of the raw key). Authority comes from the full trusted key that
  verifies.

### 3.2 The curated list

- **The only source of publisher keys.** It ships inside the app release as `curated-list.json` and `curated-list.sig`, signed by
  a root key embedded in the app (ADR 0008 decision 7). No key is ever learned from a package, a repository or the network, and
  there is no trust on first use.
- **Wire format** (strict, at most 1 MiB): `listVersion` (a safe integer), `notAfter` (`YYYY-MM-DDTHH:MM:SSZ`, UTC), and
  `entries`, each `{ id, version, tier, publisherKey, bundleHash, publisher }`:
  - `publisherKey` is the canonical base64url of 32 bytes;
  - `bundleHash` is 64 lowercase hex;
  - `publisher` is a display name the list signer vouches for, at most 64 characters;
  - **several entries per id are allowed, one per version**; a duplicate `(id, version)` refuses the whole list.

  The signature covers `axis.plugin-list.sig/1`, NUL, the JCS form of the list (a domain distinct from §3.1), with the embedded
  root key. Its file has the shape of §3.1.
- **Root keys** are a set embedded in the app. Rotation and revocation change that set **only with an app update**; the list
  carries no rotation records. A publisher-key compromise reaches clients only through an app update (RR-60).
- **At every start** the daemon verifies the list: a known root key, a `listVersion` not lower than the last accepted one (the
  journal, §6), and `notAfter` against the system clock (a wound-back clock only extends the window: RR-59). A failing list is
  **absent** and an expired one says "update Axis": no new curated installs or updates, and installed curated plugins keep
  running with a warning (4a/L4, 4a/L12). The last accepted version rises only after a list verifies.

### 3.3 Kinds of package

| Kind | When | What install requires |
|---|---|---|
| **Curated** | the list verifies and holds an entry for this `id` and `version` | the signature verifies with that entry's key; the entry's `tier` and `bundleHash` equal the package's computed ones; the dialog names the list's `publisher` |
| **Unsigned local** | no signature, or one by a key that is not a current entry's key for this id (treated as unsigned, ADR 0008) | P0 or P1 only, with the warning "This plugin is not from the Axis list. Its publisher is not verified."; the bundle hash is pinned (RR-61) |
| **Refused** | a malformed signature; a curated entry whose key, tier or hash differ; an installation bound to a curated key receiving an unsigned package or another key | nothing is written |

**Curated downgrade** is possible exactly to versions the current trusted list still lists for that id, with the same publisher
key. A version the list no longer lists cannot be installed as curated, and a curated installation never takes an unsigned
package, so such a downgrade is refused (`not_listed`).

### 3.4 Strict JSON and JCS (the manifest profile)

The manifest, the signature file and the list are read by one small reviewed JSON profile, not `JSON.parse` alone:
- a tokenizer that refuses duplicate keys (before any object is built), depth over 8, floats and exponents, integers outside the
  safe range, and strings that are not well-formed Unicode (a lone surrogate is refused, as RFC 8785 §3.2.2.2 requires);
- serialisation by RFC 8785: keys sorted by UTF-16 code units at every level, arrays in order, no whitespace, strings escaped as
  JCS specifies. Strings are never NFC-normalised.

The existing audit canonicaliser is not reused for this: it is not a JCS input validator. The profile is tested against the
RFC 8785 vectors that fall inside it, plus refusal vectors.

## 4. Verification and extraction

### 4.1 Order

1. Main's picker returns a path; main sends it in `plugins.inspect` (§5.1). No renderer names a path.
2. The daemon opens the file once (a regular file, no symlink at the final component) and reads **at most 50 MiB + 1 bytes**,
   whatever its size was at `stat`, into one buffer. More is `too_large`. Every later step works on that buffer; commit uses the
   staged result, never the path again.
3. The ZIP structure is validated over the buffer (§4.4), and **every name in the central directory is checked before any entry
   is inflated** (§4.2, PLG-9).
4. The manifest and the signature are inflated (with caps, §4.3) and read (§2.2, §3).
5. Each bundle file is inflated into the staging directory with the caps counted on output bytes; its SHA-256 and the bundle
   hash are computed from what was written. A curated package's computed hash must equal its entry's.

### 4.2 Portable names

Every entry name is ASCII and must satisfy all of:
- components separated by `/`; a directory entry is exactly one trailing `/` after a valid path; no other empty component;
- each component matches `[A-Za-z0-9][A-Za-z0-9._-]*`, at most 255 bytes, with no trailing `.` (so no `:` and no NTFS stream
  name, no backslash, no space, no control or Windows-reserved character, no drive letter, no `.` or `..`);
- no component whose part before its first `.`, compared case-insensitively, is `CON`, `PRN`, `AUX`, `NUL`, `CONIN$`,
  `CONOUT$`, `COM0`-`COM9` or `LPT0`-`LPT9` (with ASCII-only names, the superscript aliases cannot occur);
- a path at most 1,024 bytes and at most 16 folders deep, under `bundle/`, or exactly `axis-plugin.json` or `axis-plugin.sig`;
- no two names equal after ASCII case folding;
- no name that is a file and also a prefix folder of another name.

Since names are ASCII, case folding is ASCII lower-casing and there is no Unicode normalisation question. These are refusal
fixtures on every platform, not only on Windows.

### 4.3 Caps and modes

- At most 2,000 entries, 10 MiB per file and 50 MiB in total, counted on **decompressed output** as it is produced, for the
  manifest and the signature too. Nothing is allocated from a declared size. A compression ratio check may refuse earlier but
  never replaces the absolute caps.
- Staging is `<dataDir>/plugins/staging/<random 128 bits>/`, from `mkdtemp` (0o700). Files are created with the exclusive flag
  (`wx`, 0o600) under directories the daemon created; nothing existing is followed or overwritten.
- **No executable bit** and no archive attribute is ever applied: every file 0o600, every folder 0o700. An entry whose Unix mode
  says link, device or anything but a regular file or folder is refused, as is a folder entry with data.

### 4.4 The ZIP subset and its parser

- **Accepted:** stored (0) and deflate (8) entries; no encryption flag, no ZIP64 field, no multi-disk, an empty archive comment, a
  single end-of-central-directory record at the end of the buffer.
- **The central directory is the only index.** Each entry's local header must repeat its name, method, flags and sizes; a data
  descriptor is refused. Entries may not overlap one another or the central directory, and no byte of the buffer lies outside
  the local headers, entry data, central directory and end record (no prepended data, no gaps), so polyglot and overlapped-entry
  archives are refused. The CRC-32 of each inflated entry must match.
- **The parser** is a small validator over the one buffer (`plugins/package/zip.ts`), using `node:zlib`'s `inflateRawSync` with
  `maxOutputLength` set to the remaining cap. It exposes one function that returns validated entries; there is no extraction API
  that takes a path. No ZIP or JCS library is added: ADR 0005 D4 allows only `node:*`, the pinned zod and `@axis/*` at runtime.
  If that ever has to change, ADR 0005 is amended first.
- **Evidence:** a byte-level corpus of malformed archives (each refusal below and in §4.2, built by a test helper, not checked-in
  binaries), always alongside a valid control archive so a reader that refuses everything cannot pass; a seeded mutation fuzz
  test (bit flips, truncations and length edits of the control archive) asserting a closed refusal or an identical result, never
  a throw and never a write outside staging. The parser is security-boundary code: it gets its own independent review before its
  PR, and its refusal paths are mutation tested.

## 5. The flows

### 5.1 Control messages (supervisor to host; strict schemas; `control/messages.ts`)

| Message | Fields | Reply |
|---|---|---|
| `plugins.inspect` | `requestId, path` (absolute, normalised), `projectId`, `mode: "install" \| "update" \| "downgrade"`, `pluginId` for update and downgrade | `plugins.inspected { requestId, ok: true, stagingId, summary } \| { ok: false, code }` |
| `plugins.commit` | `requestId, stagingId, summaryDigest` | `plugins.result { ok: true, pluginId, version } \| { ok: false, code }` |
| `plugins.discard` | `requestId, stagingId` | none |

- A **staging record** (in memory, single use, 60 s) binds the target project, mode, plugin id, the new package's full identity,
  the summary, and the **baseline**: the installation's revision, state and identity at inspection (or "none" for a first
  install).
- `commit` takes the project mutex, then checks the record is present, unexpired, unused, of this supervisor generation, that
  `summaryDigest` (the SHA-256 of the canonical summary) matches, and that **the installation still equals the baseline**, and §5.4 step 3 compares it once more, in the transaction's own synchronous step, after every await. A stale
  baseline is `changed_since_inspect`. So two inspections of one installation cannot both commit, and a
  commit can never move a version the user did not see.
- Codes are closed: `not_a_file`, `too_large`, `bad_archive`, `bad_entry`, `bad_manifest`, `p2_refused`, `permission_refused`,
  `bad_signature`, `curated_mismatch`, `key_changed`, `not_listed`, `list_expired`, `list_refused`, `other_plugin`,
  `lower_version`, `not_installed`, `already_installed`, `changed_since_inspect`, `identity_conflict`, `expired`, `busy`,
  `unavailable`.
- Main keeps its project-action rules: the shared native queue, one action per window, 6 a minute, the cancel cooldown, and a
  dialog closed by window close, abort or a new supervisor generation (the staging record dies with its generation).

### 5.2 Install

1. Main's picker, then `plugins.inspect` with `mode: "install"`. Refused `already_installed` when the project has an installed
   installation of this id (that is an update).
2. Main's dialog: "Install this plugin?"; the id, version, tier, the curated publisher or the unsigned warning, the trust
   statement, the requested permissions in the fixed wording of `grant-line.ts`, the dangerous-combination lines. Cancel (first,
   default) · Install.
3. On Install, `plugins.commit` and the publication protocol of §5.4.
4. The installation is **installed, disabled and without grants**. The UI offers each request as its own `axis.plugins/1.grant`,
   then `enable`.

**Reinstall** after an uninstall reuses the retained enablement row (disabled, no grants, its generation and issue counters
kept): `journal.plugins.add` is called only for a plugin and project never seen before. The installation's highest version and
curated key are kept, and a curated installation stays bound to its key.
- `mode: "install"` on an uninstalled installation reinstalls a version at or above the highest one.
- A lower version needs `mode: "downgrade"`, which also accepts an uninstalled installation (§5.3).

### 5.3 Update and downgrade

- `mode: "update"` names the installed plugin. Refused: `not_installed`, `other_plugin` (a package of another id), a version not
  above the installed one (`lower_version`), `key_changed`, a curated installation receiving an unsigned package.
- `mode: "downgrade"` permits a version below the installed one, or below the highest one when the installation is
  **uninstalled** (review 2 S3). The dialog is "Install an older version?" with a fixed warning, the baseline being the installed
  version or, when uninstalled, the last installed one and "not installed now". An uninstalled target commits like a reinstall:
  it reuses the retained enablement row, raises the revision and keeps the generation, the issue counters, the highest version
  and the curated key. Otherwise a downgrade is an update.
- **The diff** compares the canonical manifests over tier, permissions, origins, contribution points and integrations, and is
  shown **even when empty** (OI-6, 4a/L26): "Update this plugin?", the old and new version, the publisher, the diff.
- **On commit** (one transaction, §5.4):
  - the installation points at the new package and its revision rises;
  - the requests become the new version's;
  - every grant not in the new requests is revoked;
  - an added request is not granted.
- **After commit,** every unspent plugin challenge of that plugin in that project is ended (`approvals.endPlugin`, which covers
  approved-but-unspent ones).
- The run-start binding pins the installation revision at issue, and `valid()` and the handler's `holds` (under the mutex and in
  the service's synchronous step) require it unchanged. A start consumed before the update and still waiting is then refused
  (`plugin_updated`). The v16 generation is not reused for this: its triggers allow a rise only on a disable or a revoke.
- Runs already created keep running (grant contract decision 2).

### 5.4 Publication and recovery

**One package lock.** Packages are shared, so publication and collection are serialised by one daemon-wide asynchronous lock (the
package lock) over every package and quarantine directory. The order is fixed: a project mutex first, then the package lock;
nothing takes a project mutex while it holds the package lock. Only one daemon process holds a data directory (the host lock), so
the lock is in memory.
- **Bounded waits** (review 3 S2). A commit holding a project mutex waits for the package lock at most 5 s; past that it releases
  the mutex and answers `busy` (the user retries), and a retry revalidates its baseline (§5.1). Collection and repair work in
  batches of at most 64 directories per hold, then release the lock. Decreases never wait on either lock: a revoke or a disable is
  one synchronous write that does not take the project mutex, and an increase or a start approved before it is refused at its
  final check (`plugin-grant-contract.md` §3; audit A L1, whose fix is in review and lands before K2-i1). So neither a slow file system nor a plugin's start can stop a decrease
  from applying within its budget.

**Pins.** A live staging record pins its staging directory. A commit pins its target identity from publication until its
transaction has committed or failed. Collection never removes a pinned directory.

**The commit point** is the journal transaction. Files are published before it, under the package lock held through it:
1. **Verified staging** (inspection, no lock needed: the directory is private and pinned): files written and `fsync`ed, then their
   directories `fsync`ed.
2. **Publish** (the project mutex, then the package lock; the identity pinned):
   - if `packages/<identity>/` does not exist, the staging directory is renamed there;
   - if it exists, it is checked by the **pure verifier** (`checkPackage(dir, listing)`: the bounded walk and reads of §5.6, no
     side effects, returning `equal` or a closed mismatch) against the row's stored listing, or, with no row (a publication that
     never committed), against the staging record's listing. Equal: the staging copy is discarded and the existing one adopted.
     Different: the existing directory is moved to `plugins/quarantine/<random>/`, then the staging copy is renamed into place.
     That repairs the files for every installation of the identity, so nothing is disabled here (§5.6);
   - **then, in every branch, the `packages/` folder is `fsync`ed, and after a quarantine move the `quarantine/` folder too**,
     in this attempt, before the commit (review 3 B1). An adopted directory that was renamed by an earlier, failed attempt is
     therefore made durable before any row references it. An fsync error refuses this attempt (`unavailable`) with no row
     written; the directory stays as unreferenced garbage, and a later attempt fsyncs again before it may adopt it.

   Every decision is taken under the package lock, so no other publication, quarantine or deletion can interleave between the
   check and the rename, and a second install of the same identity waits, then finds the directory and verifies it.
3. **Commit** (still under both locks; synchronous `withTransaction`, no await inside). **First, in the same synchronous step,
   the final baseline check** (review 4): the installation's revision, state and identity are read again and must still equal
   the staging record's baseline, after every await of steps 1 and 2. A decrease takes no lock (§5.4, bounded waits), so an
   uninstall can commit while this attempt waits for the package lock or the file system; the attempt then refuses
   `changed_since_inspect` with nothing written, and the uninstall stands. The early check of §5.1 only saves needless work.
   Then:
   - the package row if new (an existing row must have equal fields, else `identity_conflict`);
   - the installation row (created, pointed at the new identity, or reinstalled), its revision and highest version;
   - the requests, and the grant revocations of §5.3;
   - `journal.plugins.add` for a new pair only;
   - the audit row (§7).
4. **Release** the pin and the package lock, then, still under the project mutex: end the challenges (§5.3), tell PV-K3 (§5.6),
   release the mutex, and collect garbage (§5.7). These post-commit steps never turn a committed install into a refusal: the
   reply is `ok`, a failure is logged and audited, and each step is safe to repeat.

| Fault or crash | State | Outcome |
|---|---|---|
| during staging (disk full, fsync error) | a partial staging directory, no row | refused; the staging directory is removed now or at start |
| after staging fsync, before the rename | staging only | the next start removes staging; nothing installed |
| after the rename, before the parent fsync | the directory may or may not survive; no row | either way unreferenced: collected at start |
| after the parent fsync, before the commit | a published directory, no row | collected at start |
| the rename succeeds, the parent fsync fails | a visible, maybe not durable directory, no row | refused, no row; a same-daemon retry (another project's or the same) finds it, verifies it, fsyncs the parent again, and only on success commits; a crash after that commit finds the directory durable and referenced |
| a quarantine move, then the fsync of either folder fails | the moved directory, no new row | refused; the identity is republished by the next attempt, which fsyncs both folders before committing |
| the commit fails (disk full, constraint) | a published directory, no new row; the old version still referenced | refused; the directory is collected; the old version still loads |
| after a quarantine move, before the replacement rename | the identity directory absent, a quarantine entry, no new row | refused or crashed before commit: an existing row's package is missing, so its next load fails closed (§5.6) and a reinstall of the same identity republishes it |
| after the commit, before the challenges end | committed | the challenges are in memory and do not survive a restart; at runtime the binding's revision check refuses them anyway (§5.3) |
| after the commit, before PV-K3 is told | committed | the old views fail closed: a plugin connection is bound to the revision current when it was accepted, and its calls are refused once that revision is stale (§5.6) |
| during collection | a directory partly deleted | it is still unreferenced: collected again at start |

At start, before any connection is accepted: staging is removed, then, under the package lock, each package directory with no
referencing row is removed. There are no live views to reconcile at start; views created later read the committed revision.
Tests inject each fault of the table at its point (with fault-injecting file-system and fsync ports, then a fresh process on
the same data directory), plus two concurrent installs of one identity in two projects, and collection racing a publication;
every committed installation must have its package, and every precommit fault must leave the old version loadable.

### 5.5 Uninstall

`axis.plugins/1.uninstall { projectId, pluginId }`: tier 2, user-only, like `revoke` (a decrease needs no native dialog). Like
every decrease it does not wait for the project mutex (§5.4, bounded waits); it is one synchronous transaction:
- disable;
- revoke every grant;
- clear the requests;
- state `uninstalled`, revision +1;
- the audit row.

After commit, the open challenges end, PV-K3 closes the views, and the package directory is removed once no installation
references it. Other projects' installations are untouched.

### 5.6 Loading and integrity (the handoff to PV-K3)

`verifyInstalled(projectId, pluginId)` returns the buffers to serve for the installation's current package and revision, or
nothing. The expectation is the listing stored in the package row (§2.4), whose SHA-256 must equal the row's bundle hash before
it is used; nothing is reconstructed from the directory under test. It enumerates the package directory with a bounded walk:
- the root holds exactly `bundle/`; under it at most 2,000 entries, 16 deep;
- every entry `lstat`ed;
- refused on a link, a non-regular file, anything outside the root, or a file not in the stored listing.

Then it opens each listed file without following links, checks its size against the listing (each at most 10 MiB, 50 MiB in
total), reads at most that size plus one byte, and compares its SHA-256 with the listed one.
- The walk and the reads are bounded in time by an abort signal.
- **Any failure** (a mismatch, an extra or missing file, a link, an oversize, a growth during the read, a timeout, an I/O error)
  takes the same path, and nothing is returned (4a/L14):
  1. under the package lock only (never a project mutex), the identity is marked **suspect** in memory, so every load of it
     returns nothing at once;
  2. after releasing the package lock, and holding no project mutex, each installation that references the identity is disabled
     one at a time by the daemon's own decrease (§6.3), after a fresh check that it still points at this identity at the same
     revision: an installation updated meanwhile is not disabled by a stale result. Decreases take no project mutex, so this
     never nests mutexes and cannot deadlock with a commit waiting for the package lock;
  3. `plugin.integrity_failed` is appended; the suspect mark is cleared only when a publication repairs the identity (§5.4).
- The pure verifier of §5.4 and this load check share one bounded implementation; only this public wrapper has side effects.
- PV-K3 serves only the returned buffers. Each view is bound to the installation revision it loaded, and an update or uninstall
  (a revision change) retires the project's views of that plugin, so an old view can never act under requests or grants meant
  for the replacement.
- **Fail closed without the notice:** the daemon records the installation revision when it accepts a plugin connection (the
  K2-g4a lifecycle hook), and refuses that connection's calls once the revision has moved (`plugin_updated`). A missed or late
  notice to PV-K3 therefore leaves no old view able to act. This is a PV-K3 requirement, tested there.

### 5.7 Garbage

At every start, and after each commit, under the package lock: every staging directory not pinned by a live staging record is
removed, and every package directory that is not pinned and that no installation references (installed or uninstalled) is
removed. References are read from the journal synchronously under the lock, immediately before each deletion, so a deletion
can never follow a stale snapshot. An uninstalled installation keeps its package (a retention choice: the reinstall and its
history need it). Quarantine is kept for the user to inspect, at
most 4 entries (the oldest removed first). Collection is the daemon's own work and is audited as `daemon` (§7).

## 6. The journal (one schema version: the next free one when K2-p3 lands)

### 6.1 Tables (all `STRICT`)

- `plugin_packages`: `identity` (64 hex, key), `plugin_id`, `version`, `tier`, `bundle_hash` (64 hex), `manifest` (the canonical
  JSON, at most 64 KiB), `kind` (`curated` or `unsigned`), `publisher_key` (canonical base64url, present exactly for `curated`),
  `signature` (the signature file's canonical JSON, or null), `listing` (the canonical listing of §2.3, at most 2,000 records and
  2.5 MiB; its SHA-256 equals `bundle_hash`, checked on insert by the store and on every read). A row is inserted once and never
  changed; an update or delete trigger refuses it.
- `plugin_installations`: `plugin_id`, `project_id` (key together), `identity` (references `plugin_packages`), `state`
  (`installed` or `uninstalled`), `revision` (rises by one per commit; a trigger refuses any other change), `highest_version`
  (never lowered), `curated_key` (set once by the first curated install; refused if changed).
- `plugin_requests`: `plugin_id`, `project_id`, `permission` (the closed set); references the installation; written only by
  install, update and uninstall commits.
- `curated_list_state`: a singleton row holding the last accepted `list_version`; an update trigger refuses a lower value and a
  delete trigger refuses deletion.

The insert rules follow `plugin-grants.md` §1 (no insert over a key before any conflict clause, NUL-safe ids, `user` the only
writer of user rows). No table or store method mints a grant token or reaches the grant store's increase members (K2-g3).

### 6.2 The grant contract amendment (`not_requested`)

- `axis.plugins/1.grant` refuses a permission the project's installed installation does not request, with `not_requested`. It
  is checked in the content hook before the challenge is issued, and again under the project mutex at the spend, right before
  the grant action writes, together with the installation being `installed`.
- A request removed while a grant challenge is open (an update or uninstall) therefore refuses that grant.
- `enable` likewise needs an installed installation (`not_installed`).
- **Consent bound to the revision** (review 2 S1). The grant and enable content digests (`plugins/grant-content.ts`) gain the
  installation's revision, read under the project mutex at issue and again at the spend, in a new tuple version
  (`axis.plugin-grant/2`, `axis.plugin-enable/2`); the v16 generation stays in them. A user's approved but unspent grant or enable
  is then refused after any update, downgrade, uninstall or reinstall, even one that keeps the permission requested and changes
  no grant, and an uninstall then reinstall cannot replay it (the revision only rises). `approvals.endPlugin` does not end these
  (they are the user's challenges, not the plugin's), so the digest is what refuses them.
- `plugin-grant-contract.md` records both changes in its §2 and §3 when K2-p3 lands; they change the merged grant contract.

### 6.3 The daemon's own decrease (review 3 S3)

The v16 store writes every plugin row change as the user's (`journal.plugin.record` with `actor: user`). An integrity failure is
not a user action, so K2-p3 adds one narrow store method, `disableForIntegrity(pluginId, projectId)`: a decrease (no token, the
v16 generation trigger unchanged) that sets the plugin off and appends its `journal.plugin.record` with `actor: daemon` and
`reason: integrity`. It is the only daemon-attributed writer; increases stay token-only (K2-g3), and the writer rule's list is
unchanged (a decrease is allowed anywhere). `plugin-grants.md` §1 and the grant contract record the exception when K2-p3 lands.
The test asserts the complete persisted event sequence of an automatic integrity failure: the daemon's disable row, then
`plugin.integrity_failed`, and no user-attributed row.

## 7. Audit rows

New actions are added to the audit payload allowlist in K2-p3, with scalar payloads only (the policy summarises any array or
object, even under an allowed key). A set of permissions is one string: the closed names in the fixed order of `plugin-grants.md`
§1, joined by `,` (at most 160 characters). A set of contribution kinds uses the same encoding. Tests assert the **persisted**
row, not the append argument.

| Action | Actor | Payload |
|---|---|---|
| `plugin.inspect` | `user` | `ref` (12 hex of the staging id's hash), `mode`, `outcome` (`ok` or the closed code) |
| `plugin.install` | `user` | `pluginId`, `projectId`, `version`, `tier`, `kind`, `bundleHash`, `keyId` (curated), `revision`, `requested` |
| `plugin.update` | `user` | `pluginId`, `projectId`, `from`, `to`, `downgrade`, `revision`, `addedRequests`, `removedRequests`, `revokedGrants`, `addedKinds`, `removedKinds`, `bundleHash` |
| `plugin.uninstall` | `user` | `pluginId`, `projectId`, `version`, `revision` |
| `plugin.integrity_failed` | `daemon` | `pluginId`, `version`, `expected`, `actual` (hashes, or `unreadable`), `reason` (closed) |
| `plugin.collected` | `daemon` | `kind` (`staging`, `package`, `quarantine`), `count` |
| `curated.list` | `daemon` | `outcome` (`accepted`, `expired`, `unknown_key`, `bad_signature`, `rollback`, `malformed`), `listVersion` |

No row carries the manifest's `name` or `description`, a path, or archive text.

## 8. Slices

| Slice | What | Depends on | Size |
|---|---|---|---|
| **K2-p1** | Pure code: the JSON profile and JCS (§3.4); the manifest schema, SemVer order, the bundle hash and the identity hash; the signature message and verification; the curated list format and its check. | none | M |
| **K2-p2** | The ZIP validator, the portable names, inflation with caps, staging and modes (§4); its own independent review. | K2-p1 | M |
| **K2-p3** | The journal (§6.1), the list check at start, the audit allowlist and encodings (§7), `not_requested` and `not_installed` in the grant calls and the revision in their digests (§6.2), the revision in the run-start binding (§5.3), the stored listing (§2.4). | K2-p1 | M |
| **K2-i1** | Install and reinstall: the control messages, the staging record, the publication protocol and garbage (§5.4, §5.7), main's dialog builder in `daemon-host/src/main` (Electron-free), `verifyInstalled`. | K2-p2, K2-p3 | M |
| **K2-i2** | Update, downgrade and uninstall, with the diff and the grant intersection. | K2-i1 | M |

The own shell's picker and its wiring of main's flow are OS tickets (OS-3b's pattern); until then the flows are tested through
the supervisor.

## 9. Acceptance tests and mutants

Per slice, in `plugin-install-tests.md`.
