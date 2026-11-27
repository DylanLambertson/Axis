# Plugin packages: manifest, signature, extraction, install and update (ticket PV-K2, package part)

- **Status:** design only, not built. Date 2026-11-27.
- **Scope:** the plugin package (manifest, files, signature), where a signature's trust comes from, how an archive is verified
  and extracted, and the install, update, uninstall and load-integrity flows. The grant calls are
  `plugin-grant-contract.md`'s; this note only says how install and update reach them.
- **Not in scope:** the plugin host and loading a bundle into a view (PV-K3); `net:<origin>` and `integration:<id>` (ADR 0009,
  refused at install until then); P2 (refused until Phase 3); any network fetch (none in v1); the own shell's install UI and the
  approval card (own-shell plan; this note fixes what they get from the daemon).
- **Sources:** ADR 0008 decisions 2, 3, 6, 7 and 8 and its amendments (threat model 4a, the main-built dialog);
  `extensibility.md` §3.4, §3.5 and §4; `threat-model-phase4a.md` PLG-4, PLG-5, PLG-6, PLG-8, PLG-9, PLG-16, OI-6, gate lines
  4a/L3 to 4a/L6, 4a/L11, 4a/L12, 4a/L14 to 4a/L16 and 4a/L26; `plugin-grants.md`; `plugin-grant-contract.md`;
  `project-registration-and-trust.md` §4 and §5 (the main-owned flow this one follows).

## 1. Decisions in this note (proposed, for review)

1. **Install, update and the downgrade are main-owned control flows**, like project registration: main picks the file with its
   own dialog, the daemon inspects it, main draws the confirmation from the daemon's answer, and only then does main send the
   commit message. They are not protocol methods, so no renderer or plugin can start one with a chosen path, and the ADR 0008
   amendment's rule (a main-built dialog) is met by main's own dialog, not by a tier-4 challenge.
2. **Install and update never grant.** They record the package and the permissions it **requests**. Every requested permission
   that is not already granted is then its own `axis.plugins/1.grant` (tier 4, its own native dialog, decision 1 of the grant
   contract), and enabling is `axis.plugins/1.enable`. No package code can reach the grant store's increase members: K2-g3's
   token and writer rule already refuse it, and these files are not on the rule's allowed list.
3. **An update that requests a new permission does not carry it over.** The new permission is a request, shown in the update
   dialog's diff, and becomes a grant only through its own grant call. A removed permission is revoked when the update is
   confirmed (a decrease, through the same path as K2-g1's revoke, which ends the plugin's open challenges).
4. **Every update is confirmed** (OI-6), an empty diff included; a lower version only through "Install an older version".
5. **The daemon does the file work**, inside its data directory; main never extracts or reads plugin files. The daemon is the
   process that already holds the journal and the grant store, and it can be tested without Electron.

## 2. The package

### 2.1 The archive

A plugin is one ZIP file (`.axisplugin`), at most 50 MiB on disk. Only the subset below is read; anything else is refused before
any entry is extracted (§4):
- stored (method 0) or deflate (method 8) entries only; no encryption, no ZIP64, no multi-disk, no archive comment over 0 bytes;
- the central directory is the only index, and each entry's local header must repeat its name, method and sizes exactly;
- entries may not overlap, and the archive may not hold bytes outside the entries, the central directory and its end record
  (no prepended data, no gaps): a polyglot or an overlapped-entry archive is refused.

The root holds:
- `axis-plugin.json`, the manifest (§2.2);
- `axis-plugin.sig`, the optional signature (§3);
- the bundle's files, under `bundle/`. Only files under `bundle/` are part of the bundle hash and are ever served (PV-K3).

### 2.2 The manifest

`axis-plugin.json`, at most 64 KiB, UTF-8 without a byte order mark, parsed by a strict schema (every object strict; an unknown
key, a duplicate key or a float is refused). Fields:

| Field | Rule |
|---|---|
| `manifestVersion` | the integer `1` |
| `id` | `pluginIdSchema`, at most 64 characters (ADR 0008 decision 3) |
| `version` | strict SemVer 2.0 `MAJOR.MINOR.PATCH`, an optional prerelease, no build metadata; each number at most `2^53 - 1` |
| `tier` | `"P0"` or `"P1"`; `"P2"` is refused (4a/L11) |
| `name`, `description` | display text, at most 64 and 512 characters, escaped wherever shown; **never** in a native dialog line, an audit row or a log (they are the plugin's words) |
| `permissions` | a set (no duplicates) from the closed list of `plugin-grants.md` §1; `net:` and `integration:` refused until ADR 0009 (4a/L11) |
| `origins`, `integrations` | empty arrays until ADR 0009; anything else is refused |
| `contributes` | the closed set of `extensibility.md` §3.4, each kind with its own strict schema and count cap (for example at most 8 `page` entries); a P0 package may not contribute a P1 view |
| `entry` | P1 only: a path under `bundle/` to an `.html` file of the bundle; P0 has none |

The **canonical manifest** is the RFC 8785 (JCS) serialisation of the parsed value. It is what the signature covers, what the
journal records, and what an update's diff compares. The raw bytes are never used again after parsing.

### 2.3 The bundle hash

The SHA-256 of a canonical listing of `bundle/`: one record per file, sorted by the NFC-normalised path in UTF-8 byte order,
each record `path NUL size NUL sha256-hex LF`. Directories carry no record. The hash never depends on archive bytes, so
compression, entry order, timestamps or attributes cannot give two hashes for one bundle or one hash for two (ADR 0008
decision 7).

## 3. Signatures and their trust root

### 3.1 The signature file

`axis-plugin.sig` is strict JSON `{ "alg": "ed25519", "keyId": <16 hex>, "signature": <base64url of 64 bytes> }`. The signed
message is the bytes of `axis.plugin.sig/1`, a NUL, the canonical manifest, a NUL, and the 32-byte bundle hash. So a signature
names one id, version, tier, permission set and bundle, and moving it to another fails (4a/L16). `keyId` is the first 16 hex
digits of the SHA-256 of the raw 32-byte public key: a lookup hint only, never trusted; the key itself must verify.

### 3.2 Where keys come from

- **The curated list is the only source of publisher keys.** It ships inside the app release, signed by a root key embedded in
  the app (ADR 0008 decision 7), as `curated-list.json` with `curated-list.sig`. The list holds a monotonic `version`, a
  `notAfter` date, and one entry per plugin: `id`, `version`, `tier`, `publisherKey` (the raw key), `bundleHash` and a display
  `publisher` name that the list signer vouches for.
- **Root keys.** The app embeds a set of root public keys. A rotation is a new root key whose record is signed by an existing
  one, shipped in an app update; a revoked root key is removed from the embedded set by an app update. No key is ever learned
  from a package, a repository or the network, and there is no trust on first use.
- **At every start** the daemon verifies the list: a known root key's signature, a version not lower than the last accepted one
  (kept in the journal, §6), and `notAfter` against the system clock. A list that fails is **absent** (no new curated installs or
  updates; installed curated plugins keep running with a warning); an expired one says "update Axis" (4a/L4, 4a/L12). The last
  accepted version is raised only after a list verifies.

### 3.3 The three kinds of package

| Kind | When | What install requires |
|---|---|---|
| **Curated** | the list verifies and has an entry for this `id` and `version` | the signature verifies with the entry's `publisherKey`; the entry's `tier` and `bundleHash` equal the package's; the dialog names the list's `publisher` |
| **Unsigned local** | no signature, or one by a key that is not a curated entry's key for this id (ADR 0008: treated as unsigned) | P0 or P1 only, with the warning "This plugin is not from the Axis list. Its publisher is not verified."; the bundle hash is pinned at install |
| **Refused** | a signature that is malformed; a curated entry whose key, tier or hash differ; a curated id whose installed copy was curated and whose new copy is not (an update may not drop to unsigned silently) | nothing is written |

An update of a curated plugin needs the same `publisherKey` as the installed one; a key change blocks it (ADR 0008 decision 7).

## 4. Verification and extraction

### 4.1 Order

1. Main's picker returns a path. Main sends it in `plugins.inspect` (§5.1). Nothing from a renderer names a path.
2. The daemon opens the file once (no following of a symlink at the final component, a regular file only, at most 50 MiB) and
   reads it into memory. Every later step works on those bytes, so a file changed on disk after the open is never mixed in.
3. **The whole central directory is checked before any entry is read** (PLG-9; ADR 0008 decision 8). Refused:
   - an entry name with NUL, backslash, a drive letter, a leading `/`, a `..` or `.` component, an empty component, a Windows
     reserved name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, with or without an extension) or a trailing dot
     or space;
   - a name that is not valid UTF-8 (the UTF-8 flag must be set, or the name must be ASCII);
   - two names equal, or equal after NFC normalisation and full case folding (an NFC and an NFD spelling collide);
   - a component over 255 UTF-8 bytes, a path over 1,024 bytes, or deeper than 16 folders;
   - a symlink, a hard link, a device or any entry whose Unix mode (in the external attributes) is not a regular file or a
     directory; a directory entry with data;
   - more than 2,000 entries; a declared size over 10 MiB per file or 50 MiB in total;
   - a file outside `axis-plugin.json`, `axis-plugin.sig` and `bundle/`.
4. The manifest and the signature are inflated and parsed (§2.2, §3.1), then the signature is checked (§3).
5. Each bundle file is inflated **as a stream with the caps counted on decompressed bytes** (a declared size that lies is caught
   at the first byte past it), hashed, and written into a fresh staging directory (§4.2). The bundle hash is computed from what
   was written, never from the archive's claims.

### 4.2 Where files go

- Staging: `<dataDir>/plugins/staging/<random 128 bits>/`, created with `mkdtemp` (mode 0o700). Files are created with the
  exclusive flag (`wx`, mode 0o600) under directories the daemon created itself, so no existing file or link is ever followed.
- **No executable bit** and no attribute from the archive is ever applied: every file is 0o600, every directory 0o700, whatever
  the archive says.
- A confirmed install renames the staging directory to `<dataDir>/plugins/packages/<id>/<version>-<first 16 hex of the bundle
  hash>/` (same file system, so the rename is atomic). An existing target is never written over: a reinstall of the same version
  and hash reuses the existing directory, and a different hash under the same version is refused.
- A staging directory is removed when its inspection expires (60 s, the native queue's bound), on a refusal, and at every start
  (any leftover from an earlier process).

### 4.3 What inspection returns

`plugins.inspected { requestId, ok: true, stagingId, summary } | { ok: false, code }`, where `code` is closed
(`not_a_file`, `too_large`, `bad_archive`, `bad_entry`, `bad_manifest`, `p2_refused`, `permission_refused`, `bad_signature`,
`curated_mismatch`, `key_changed`, `list_expired`, `list_refused`, `lower_version`, `same_version_other_hash`, `busy`,
`unavailable`). The `summary` holds daemon-derived values only:
- `id`, `version`, `tier`, `kind` (curated or unsigned), the curated `publisher` (from the signed list) or none;
- the requested permissions, in the fixed wording of `grant-line.ts` (`GRANT_WORDING`), and the dangerous-combination lines;
- the contribution point kinds and their counts;
- for an update: the installed version and the diff (§5.3).

Never the manifest's `name` or `description`, a path, or any archive text.

## 5. The flows

### 5.1 Control messages (supervisor to host; strict schemas; `control/messages.ts`)

| Message | Fields | Reply |
|---|---|---|
| `plugins.inspect` | `requestId, path` (absolute, normalised), `projectId`, `mode: "install" \| "update" \| "downgrade"` | `plugins.inspected` (§4.3) |
| `plugins.commit` | `requestId, stagingId, summaryDigest` | `plugins.result { ok: true, pluginId, version } \| { ok: false, code }` |
| `plugins.discard` | `requestId, stagingId` | none |

`summaryDigest` is the SHA-256 of the canonical summary the daemon returned. `commit` checks that the staging entry exists, is not
expired, belongs to this supervisor generation and matches the digest, so main can only commit exactly what it showed. A
`stagingId` is single-use. One inspection per project at a time; at most 6 inspections per minute per window (main's rate limit,
as for project actions).

### 5.2 Install

1. Main's picker; `plugins.inspect` with `mode: "install"`.
2. Main's dialog (the native queue of `main-answers.md` §3.2: Cancel first and default, 60 s, modal, one at a time). Message
   "Install this plugin?"; detail: the id, version, tier, the curated publisher or the unsigned warning, the trust statement
   ("P0 and P1 plugins can act only through the permissions shown"), the requested permissions and the dangerous-combination
   lines. Buttons: Cancel · Install.
3. On Install, `plugins.commit`. The daemon, in one journal transaction: records the package (§6), adds the plugin's row for the
   project (`journal.plugins.add`, disabled, no grants), and appends `plugin.install`. Then the rename of §4.2. If the rename
   fails the transaction is rolled back and nothing is installed.
4. The plugin is now installed, **disabled and without grants**. The UI offers each requested permission as its own
   `axis.plugins/1.grant` (tier 4) and then `enable` (tier 4). A user who grants nothing has an installed, inert plugin.

### 5.3 Update and downgrade

- The same flow with `mode: "update"`. Refused: a different id, a lower version (unless `mode: "downgrade"`), a curated plugin's
  key change, a curated plugin becoming unsigned.
- **The diff** compares the canonical manifests over tier, permissions, origins, contribution points and integrations, and lists
  each addition and removal. It is shown **even when empty** (OI-6, 4a/L26): message "Update this plugin?", detail the old and new
  version, the publisher, and the diff.
- **On confirm,** in one transaction: the package record points at the new version, a removed permission is revoked (the K2-g1
  revoke path, which ends the plugin's open challenges in that project), and `plugin.update` is appended. The plugin's open
  challenges are ended in every case, because the code they were asked for changed (they were bound to the old version's
  behaviour). An **added** permission is only recorded as requested; it needs its own grant call. A tier raise (P0 to P1) or a new
  contribution point needs nothing more than the confirmed dialog, because neither reaches the grant store; the dialog lists it as
  an increase.
- Live runs a plugin started keep running across an update (decision 2 of the grant contract: a run is the user's from its
  approval on).
- **Downgrade:** `mode: "downgrade"` permits a lower version, with the dialog title "Install an older version?" and a fixed
  warning. It is otherwise an update.

### 5.4 Uninstall

`axis.plugins/1.uninstall { projectId, pluginId }`, a tier-2 user-only protocol method like `revoke` (a decrease needs no native
dialog; `plugin-grant-contract.md` decision 2). In order: disable (ends open challenges), revoke every grant, mark the package
uninstalled, append `plugin.uninstall`, then remove the package directory when no other project still has the plugin installed.
The enablement row is kept (the generation never starts over, `plugin-grants.md` §1). PV-K3 closes the plugin's views when it
sees the disable.

### 5.5 Integrity at load (for PV-K3)

`verifyInstalled(pluginId, version)` re-reads the package directory into memory once, recomputes the bundle hash and compares it
with the recorded one; a mismatch disables the plugin in every project, appends `plugin.integrity_failed` and returns nothing to
serve (4a/L14). PV-K3 serves only the buffers this call returns, never a file read later. Extra or missing files are a mismatch.

### 5.6 How the grant path stays closed

- The package files (`plugins/package/*.ts`, the inspect and commit handlers) are not in the writer rule's allowed files, so any
  call of the store's `grant`, `setEnabled(…, true)` or `takeGrantMint` from them fails the import test (K2-g3).
- Revoke and disable (decreases) are allowed anywhere, and these flows use them only through the same functions as K2-g1's
  handlers, so the open challenges end the same way.
- A test pins it: an install and an update of a package requesting every permission leave `plugin_grants` empty and the plugin
  disabled.

## 6. What the journal records (one schema version)

- `plugin_packages`: `plugin_id`, `version`, `tier`, `kind` (`curated` or `unsigned`), `publisher_key` (curated only),
  `bundle_hash`, `manifest` (the canonical JSON), `installed_at`, `state` (`installed` or `uninstalled`). One installed version per
  plugin id; an update replaces it in place. The insert and update rules follow `plugin-grants.md` §1 (no insert over a key, the
  NUL-safe id checks, `user` the only writer).
- `plugin_requests`: per plugin, project and permission, the permissions the installed version requests, so the UI can offer
  each grant; a grant of an unrequested permission is refused by the grant handler (`not_requested`), which closes a gap the
  grant contract left open: today any closed-set permission can be granted.
- `curated_list_state`: one row, the last accepted list version.

## 7. Audit rows

Every row is the user's (`actor: user`; main's flows are the user's gesture) and carries ids, versions, hashes and closed codes
only, never manifest text:

| Action | Payload |
|---|---|
| `plugin.inspect` | `ref` (the first 12 hex of the staging id's hash), `mode`, `outcome` (ok or the closed code) |
| `plugin.install` | `pluginId`, `projectId`, `version`, `tier`, `kind`, `bundleHash`, `keyId` (curated), `requested` (the permission names) |
| `plugin.update` | `pluginId`, `projectId`, `from`, `to`, `downgrade`, `added` and `removed` (permission names and contribution kinds), `bundleHash` |
| `plugin.uninstall` | `pluginId`, `projectId`, `version` |
| `plugin.integrity_failed` | `pluginId`, `version`, `expected` and `actual` bundle hashes |
| `curated.list` | `outcome` (`accepted`, `expired`, `unknown_key`, `bad_signature`, `rollback`), `version` |

## 8. Slices

| Slice | What | Depends on | Size |
|---|---|---|---|
| **K2-p1** | Pure package code: the manifest schema, JCS canonicalisation, the bundle hash, the signature message and Ed25519 verification (`node:crypto`), the curated list format and its verification with embedded root keys. No file system, no journal. | none | M |
| **K2-p2** | The archive reader and extraction: the ZIP subset, the central-directory checks, streaming inflate with decompressed caps, the staging directory, the modes. | K2-p1 | M |
| **K2-p3** | The journal: `plugin_packages`, `plugin_requests`, `curated_list_state` (one schema version); the list check at start; the grant handler's `not_requested`. | K2-p1 | S |
| **K2-i1** | Install: the control messages, the inspect and commit handlers, main's dialog builder in `daemon-host/src/main` (Electron-free, like `project-actions.ts`), `verifyInstalled`. | K2-p2, K2-p3 | M |
| **K2-i2** | Update, downgrade and uninstall, with the diff. | K2-i1 | M |

The own shell's picker and its wiring of main's flow are OS tickets (OS-3b's pattern); until then the flows are tested through
the supervisor.

## 9. Acceptance tests and mutants, per slice

- **K2-p1:**
  - every manifest rule, each refused in isolation;
  - a signature moved to another id, version, tier, permission set or bundle fails (4a/L16);
  - JCS test vectors from RFC 8785;
  - a bundle hash equal across two archives of one bundle with different order, compression and timestamps, and different for a
    one-byte change;
  - a list with a lower version, an unknown key, a bad signature, or past `notAfter` is refused (4a/L4);
  - mutants: the domain prefix dropped, the NUL separators dropped, the tier left out of the message, the version comparison
    flipped, `notAfter` ignored.
- **K2-p2:**
  - one archive per refusal of §4.1 step 3 (4a/L5, 4a/L15), each leaving nothing outside the fresh staging directory;
  - a deflate entry whose declared size lies, stopped at the cap;
  - an overlapped-entry archive and a prepended-data archive, refused;
  - an archive whose entries carry the executable bit and a symlink mode, refused or written 0o600;
  - mutants: each check removed, the caps counted on declared instead of decompressed sizes, case folding without NFC, the
    exclusive flag dropped.
- **K2-p3:**
  - the schema's insert rules;
  - a list version that never goes down across restarts;
  - the grant of an unrequested permission refused.
- **K2-i1:**
  - install through the supervisor end to end: disabled, no grants, files at the final path, audit rows with no manifest text;
  - a commit with a stale, reused, expired or other-generation `stagingId`, or a digest that differs from the shown summary,
    refused;
  - the dialog builder shows no manifest `name` or `description` and escapes every value;
  - `verifyInstalled` disables on a changed, added or removed file (4a/L14);
  - mutants: the digest check, the single use, the expiry, the transaction rollback on a failed rename.
- **K2-i2:**
  - every update shows the dialog, an empty diff included (4a/L26);
  - an added permission is not granted;
  - a removed one is revoked and ends open challenges;
  - a lower version is refused except through downgrade;
  - a curated key change and a curated-to-unsigned update are blocked;
  - uninstall leaves no grant and keeps the generation;
  - mutants: the empty-diff dialog skipped, the added permission copied into the grants, the key comparison removed.
- **All slices:** the K2-g3 writer rule stays green with the new files in place (§5.6).

## 10. Open points for review

1. **Main-owned flows or tier-4 methods** for install and update (decision 1). Main-owned keeps the path out of every renderer
   and matches project registration; the cost is two more control messages and a dialog builder in `main/`.
2. **`plugin_requests` and `not_requested`** (§6) narrow the grant calls to what the installed version asked for. That is a
   change to the grant contract's §2, recorded there when K2-p3 lands.
3. **Ending open challenges on every update** (§5.3), even one that only lowers permissions. Proposed, because an approval was
   given for the old code.
4. **Archive format:** a ZIP subset (decided here) against a simpler custom container. ZIP keeps packaging with standard tools; the
   subset and the overlap check carry the risk.
