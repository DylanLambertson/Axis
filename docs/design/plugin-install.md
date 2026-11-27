# Plugin packages: manifest, signature, extraction, install and update (ticket PV-K2, package part)

- **Status:** design only, not built. Date 2026-11-27; revised the same day after review 1 (package scope, a durable
  publication protocol, reinstall, curated downgrade, load bounds, portable names, audit) and the decisions on its open points.
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

- A **package** is identified by `(id, version, bundleHash)`; its **identity hash** is the SHA-256 of
  `id NUL version NUL bundleHash`, 64 hex digits. It is stored at `<dataDir>/plugins/packages/<identity hash>/` and never
  changes after publication. Any number of installations may reference it.
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
  the summary, and the **baseline**: the installation's revision at inspection (or "none" for a first install).
- `commit` takes the project mutex, then checks the record is present, unexpired, unused, of this supervisor generation, that
  `summaryDigest` (the SHA-256 of the canonical summary) matches, and that **the installation's revision still equals the
  baseline**. A stale baseline is `changed_since_inspect`. So two inspections of one installation cannot both commit, and a
  commit can never move a version the user did not see.
- Codes are closed: `not_a_file`, `too_large`, `bad_archive`, `bad_entry`, `bad_manifest`, `p2_refused`, `permission_refused`,
  `bad_signature`, `curated_mismatch`, `key_changed`, `not_listed`, `list_expired`, `list_refused`, `other_plugin`,
  `lower_version`, `not_installed`, `already_installed`, `changed_since_inspect`, `expired`, `busy`, `unavailable`.
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
curated key are kept, so a reinstall below the highest version needs `mode: "downgrade"`, and a curated installation stays bound
to its key.

### 5.3 Update and downgrade

- `mode: "update"` names the installed plugin. Refused: `not_installed`, `other_plugin` (a package of another id), a version not
  above the installed one (`lower_version`), `key_changed`, a curated installation receiving an unsigned package.
  `mode: "downgrade"` permits a lower version ("Install an older version?" with a fixed warning); it is otherwise an update.
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

The **commit point** is the journal transaction. Files are published before it, and anything unreferenced afterwards is garbage.
1. **Verified staging.** Inspection leaves a staging directory whose files are written, `fsync`ed, and whose directories are
   `fsync`ed.
2. **Publish.** If `packages/<identity hash>/` exists, its full content is verified against the expected listing (§5.6's bounded
   check):
   - equal: the staging copy is discarded and the existing one used;
   - different (corruption or tampering): it is moved to `plugins/quarantine/<random>/` and the staging copy takes its place.

   Otherwise the staging directory is renamed into place and the parent folder is `fsync`ed. Nothing referenced is ever written
   over.
3. **Commit** (synchronous, `withTransaction`; no await inside):
   - the installation row (created, pointed at the new identity, or reinstalled), its revision and highest version;
   - the requests, and the grant revocations of §5.3;
   - `journal.plugins.add` for a new pair only;
   - the audit row (§7).

   If it fails, nothing is installed, and step 2's directory is unreferenced garbage.
4. **After commit:** end the challenges (§5.3), tell PV-K3 (§5.6), and collect garbage.

| Crash after | What is on disk and in the journal | What the next start does |
|---|---|---|
| step 1 | a staging directory | removes every staging directory |
| step 2 | a published directory, no reference | removes unreferenced package directories |
| step 3 | committed; the old version's directory unreferenced (update) | removes it; the installation already points at the new one |
| step 4 | committed; challenges not ended | none survive a restart (they are in memory); garbage collected |

The working version is never touched before the commit, so a failed or interrupted update leaves the old version installed and
loadable. Uninstall commits first, then collects garbage (§5.5). Tests inject a crash (a thrown fault, then a fresh process on
the same data directory) after each step and assert the table's outcome.

### 5.5 Uninstall

`axis.plugins/1.uninstall { projectId, pluginId }`: tier 2, user-only, like `revoke` (a decrease needs no native dialog). One
transaction under the project mutex:
- disable;
- revoke every grant;
- clear the requests;
- state `uninstalled`, revision +1;
- the audit row.

After commit, the open challenges end, PV-K3 closes the views, and the package directory is removed once no installation
references it. Other projects' installations are untouched.

### 5.6 Loading and integrity (the handoff to PV-K3)

`verifyInstalled(projectId, pluginId)` returns the buffers to serve for the installation's current package and revision, or
nothing. It enumerates the package directory with a bounded walk:
- at most 2,000 entries, 16 deep;
- every entry `lstat`ed;
- refused on a link, a non-regular file, anything outside the root, or a file not in the expected listing.

Then it opens each expected file without following links, checks its size against the listing (at most 10 MiB, 50 MiB in total),
reads at most that size plus one byte, and hashes it. The bundle hash must match.
- The walk and the reads are bounded in time by an abort signal.
- **Any failure** (a mismatch, an extra or missing file, a link, an oversize, a growth during the read, a timeout, an I/O error)
  takes the same path: the plugin is disabled in every project that installs this package, `plugin.integrity_failed` is
  appended, and nothing is returned (4a/L14).
- PV-K3 serves only the returned buffers. Each view is bound to the installation revision it loaded, and an update or uninstall
  (a revision change) retires the project's views of that plugin, so an old view can never act under requests or grants meant
  for the replacement.

### 5.7 Garbage

At every start, and after each commit: every staging directory not held by a live staging record is removed, and every package
directory that no installation references (installed or uninstalled) is removed. Quarantine is kept for the user to inspect, at
most 4 entries (the oldest removed first). Collection is the daemon's own work and is audited as `daemon` (§7).

## 6. The journal (one schema version: the next free one when K2-p3 lands)

### 6.1 Tables (all `STRICT`)

- `plugin_packages`: `identity` (64 hex, key), `plugin_id`, `version`, `tier`, `bundle_hash` (64 hex), `manifest` (the canonical
  JSON, at most 64 KiB), `kind` (`curated` or `unsigned`), `publisher_key` (canonical base64url, present exactly for `curated`).
  A row is inserted once and never changed.
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
- `plugin-grant-contract.md` records this in its §2 when K2-p3 lands.

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
| **K2-p3** | The journal (§6.1), the list check at start, the audit allowlist and encodings (§7), `not_requested` and `not_installed` in the grant calls (§6.2), the revision in the run-start binding (§5.3). | K2-p1 | M |
| **K2-i1** | Install and reinstall: the control messages, the staging record, the publication protocol and garbage (§5.4, §5.7), main's dialog builder in `daemon-host/src/main` (Electron-free), `verifyInstalled`. | K2-p2, K2-p3 | M |
| **K2-i2** | Update, downgrade and uninstall, with the diff and the grant intersection. | K2-i1 | M |

The own shell's picker and its wiring of main's flow are OS tickets (OS-3b's pattern); until then the flows are tested through
the supervisor.

## 9. Acceptance tests and mutants, per slice

Every refusal suite includes a valid control input that passes, so a component that refuses everything fails.
- **K2-p1:**
  - every manifest rule refused in isolation;
  - SemVer order (`1.0.0-2` < `1.0.0-10` < `1.0.0`), leading zeros refused, safe-integer bounds;
  - the RFC 8785 vectors inside the profile, plus duplicate key, lone surrogate, float, depth and size refusals;
  - a signature moved to another id, version, tier, permission set or bundle fails (4a/L16);
  - an independently framed vector kills a dropped prefix or NUL;
  - one bundle hash across two archives differing in order, compression and timestamps, and a different one for a one-byte
    change;
  - lists with a lower version, an unknown key, a bad signature, a duplicate `(id, version)`, or past `notAfter` refused (4a/L4);
  - mutants: the domain prefix, a separator, the tier left out of the message, the version comparison flipped, `notAfter`
    ignored, duplicate-key detection off.
- **K2-p2:**
  - one archive per refusal of §4.2 to §4.4, colons, stream names, reserved names and file and folder prefix conflicts included
    (4a/L5, 4a/L15), each leaving nothing outside the staging directory;
  - a lying declared size stopped at the cap;
  - overlapped, prepended and data-descriptor archives refused;
  - an executable bit never applied;
  - the seeded fuzz test;
  - mutants: each check removed, caps on declared sizes, the exclusive flag dropped, the CRC check off.
- **K2-p3:**
  - the `STRICT` tables' insert and trigger rules;
  - the list version never going down across restarts;
  - `not_requested` before the dialog and under the lock (a request removed while a grant is open refuses it);
  - the binding refusing after a revision change (a start approved and waiting under the mutex during an update);
  - persisted audit rows with the scalar encodings, never manifest text;
  - mutants: the recheck at the write removed, the revision left out of `valid()`, the allowlist entry missing.
- **K2-i1:**
  - install end to end through the supervisor (installed, disabled, no grants, the files at the identity path);
  - reinstall after uninstall reusing the retained row, generation kept, and an older package refused without downgrade;
  - a commit with a stale, reused, expired, other-generation or wrong-digest `stagingId`, or a stale baseline, refused;
  - the source archive replaced after inspection never changes what is committed;
  - the crash table of §5.4, step by step;
  - an existing identity directory with corrupted content is quarantined, not reused;
  - `verifyInstalled`:
    - each failure of §5.6 (an oversize replacement, an added tree, a link or cycle, a file growing during the read, a swapped
      file) takes the disable path;
    - only the checked buffers are served;
  - abort, expiry, window close and generation change clean staging up;
  - a repository file or workspace setting that names a plugin installs and enables nothing, and shows the notice (4a/L6);
  - an expired or refused list blocks curated installs, while installed curated plugins load with the warning and unsigned local
    installs are unchanged (4a/L12);
  - mutants: the baseline check, single use, the digest check, publication after the commit, the quarantine path, each read cap.
- **K2-i2:**
  - every update shows the dialog, an empty diff included (4a/L26);
  - two projects, A and B, on v1 with grants: an update or uninstall in A leaves B's version, requests, grants and package
    directory alone;
  - a zero-permission installation installs, updates and uninstalls;
  - an update of an enabled, granted installation keeps exactly the intersection of the old grants and the new requests;
  - every unspent challenge ended, an approved-unspent one included;
  - a curated downgrade to a listed version succeeds, and to an unlisted one is refused;
  - a curated key change and a curated-to-unsigned update are blocked;
  - mutants: the empty-diff dialog skipped, removed grants retained, added requests granted, the key comparison removed, the
    revision rise skipped.
- **All slices:** the K2-g3 writer rule stays green with the package files in place, and a test shows install and update leave
  `plugin_grants` unchanged for added requests.
