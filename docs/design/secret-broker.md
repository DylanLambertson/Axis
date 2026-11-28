# Main's secret broker (ticket PV-N0)

- **Status:** design (security-relevant), revision 2 after design review 1; revision 3 (2026-11-27) splits PV-N0c for ADR 0011 (§6.1). **Built:** PV-N0a (the control schemas in `daemon-host/src/control/secrets-messages.ts`; main's store and record folder in `daemon-host/src/main/secret-store.ts` and `secret-files.ts`). Not built: PV-N0c-1 (the daemon side) and PV-N0c-2 (main's adapter in the own shell).
- **Date:** 2026-11-22. **Code baseline:** `origin/main` at `9642e46`; upstream Code OSS `1.144.0` at `2c33b50` (the vendor tree).
- **Decides:** how the daemon's vault (`@axis/vault`) gets a production `SecretBackend`. ADR 0003 D1.6 sketches a privileged main port carrying `secrets.decrypt(handle, purpose)`; this note fixes the shape. It needs no ADR amendment: D1.6 stands, and section 3.4 says how the messages map to it.
- **Builds on:** ADR 0003 (D1.6; the renderer holds the upstream `encryption` channel), ADR 0009 decision 5 (vault namespaces, the production backend as a prerequisite), `docs/design/anthropic-adapter.md` §10 (the vault and the `SecretBackend` contract), `docs/design/main-answers.md` §3.1 (the audit anchor: the pattern copied here), `docs/design/product-vision-v2-tickets.md` §5.1 (PV-N0), threat model PRV-1, PRV-2, EXT-1, EXT-4, A10.
- **Evidence tags:** **[V]** verified in the code (file and symbol named); **[U]** verified in the upstream vendor tree at `2c33b50`; **[D]** decided here; **[I]** inferred, not verified.

## 1. Why

The vault keeps no secret itself: it stores through an injected `SecretBackend` [V, `packages/vault/src/types.ts` `SecretBackend`]. The daemon entry passes none, so in a built app no provider key is read and no integration can connect [V, `daemon-host/src/compose.ts` `composer.anthropic`; ADR 0009 decision 5]. `safeStorage` exists only in Electron main, so the backend must live there and the daemon must reach it.

## 2. What exists

- **The contract** the backend must meet: `info`, `put`, `get`, `meta`, `remove`, `list`; `put` must refuse a write that would land on another backend or protection than its `meta` says, and report where it landed; `get` and `meta` must report each entry's real protection from the stored data, not from metadata the vault wrote (`anthropic-adapter.md` §10.3) [V for the type; the per-entry rule is a design requirement]. Vault names match `NAME_RE` `[a-z0-9][a-z0-9._-]{0,63}` and secrets are 8 to 4,096 printable ASCII characters with no whitespace [V, `vault/src/names.ts` `NAME_RE`; `vault/src/vault.ts` `SECRET_RE`]. The vault's `list` turns the whole answer into `backend_failed` if any returned name breaks the rule [V, `vault/src/vault.ts` `list`].
- **The pattern:** main already stores one `safeStorage` record for the daemon, the audit anchor: `<base>/anchor/audit-anchor.v1`, directory `0700`, file `0600`, atomic write (temporary file `wx`, write, `fsync`, `rename`, directory `fsync`), one write at a time, a strict record form, and no answer when the backend is not secure [V, `main-answers.md` §3.1; `daemon-host/src/main/anchor-file.ts`, `anchor-store.ts`].
- **The control channel** is main's private, in-memory channel to the daemon utility process; no renderer can post on it [V, ADR 0003 D1.4; `daemon-host/src/control/messages.ts`]. Main's answers are pure modules under `daemon-host/src/main/` tested without Electron, with source pins for the Electron adapters in `axisMainPorts.ts` [V, `main-answers.md` §1].
- **Upstream's `encryption` channel.** Main registers `EncryptionMainService` on the renderer-reachable bus with `ProxyChannel.fromService` [U, `src/vs/code/electron-main/app.ts:1435-1436`]. Its `decrypt(value)` returns `safeStorage.decryptString` of **any** ciphertext, `encrypt(value)` encrypts any text, and `setUsePlainTextEncryption` switches `safeStorage` to the hardcoded key on Linux for the rest of the session [U, `src/vs/platform/encryption/electron-main/encryptionMainService.ts` `decrypt`, `encrypt`, `setUsePlainTextEncryption`]. Every renderer therefore holds an encryption and decryption oracle for the app's `safeStorage` key.

## 3. Decisions

### 3.1 Main stores the ciphertext; the daemon never does [D]

- **Location:** `<base>/secrets/`, next to `<base>/anchor/` and never inside the daemon's data directory `<base>/daemon`.
- **The folder is checked, never trusted.** Before every operation main `lstat`s `<base>/secrets`: it must be a real directory (not a symlink), owned by the user on POSIX, with mode `0700`; otherwise every request answers `failed` and nothing is read or written. Main creates it `0700` only when it does not exist. Entry files are opened without following symlinks (`O_NOFOLLOW` on POSIX) and must be regular files with mode `0600`. On Windows there is no POSIX mode: the files take the ACL inherited from the user's profile folder (`LOCALAPPDATA`), which grants the user and the system, and the note claims nothing more [I].
- **File names:** the canonical lower-case hex of the entry name's UTF-8 bytes, plus `.v1`. Names are at most **100** characters (200 hex characters, a 203-character file name, under the common 255 limit). `list` decodes each file name, re-encodes it and keeps only names whose canonical form matches exactly and that pass the name rule; every other file in the folder is ignored (a case-insensitive file system cannot make two spellings of one name).
- **Record:** strict JSON `{ "v": 1, "meta": <EntryMeta>, "ct": "<base64 ciphertext>" }`, at most 16 KiB. The ciphertext is `safeStorage.encryptString` of the **framed plaintext** `axis.secret/1\n<name>\n<secret>` (a secret has no whitespace, so the frame parses unambiguously). On read, main decrypts and requires the exact frame and the file's own name: a record copied to another entry's file, or any other form, is `corrupt`.
- **Writes** are the anchor's: temporary file `wx` `0600` in the same folder, write, `fsync`, close, `rename`, folder `fsync` on POSIX; one write at a time per entry; a remove is `unlink` plus folder `fsync`. Leftover temporary files are removed at main's start. At most 256 entries; one more is `refused`.
- **The daemon holds plaintext only in memory**, as today (PRV-2). Plaintext crosses only the in-memory control channel; main never logs it and drops its references after answering (best effort: a garbage-collected runtime cannot guarantee scrubbing). The journal, its exports and the daemon's data directory hold no credential in any form.

### 3.2 The upstream decrypt path stays open: an accepted residual (EXT-4) [D]

- **Why a refusal by prefix cannot work.** Revision 1 proposed patching `EncryptionMainService` to refuse a decrypt whose plaintext starts with the frame tag. On macOS and Linux, `safeStorage` encrypts with AES-CBC under a fixed IV and no authentication [I: Chromium `os_crypt` internals, not in this repository]. A caller can drop or replace the first ciphertext block: the output then no longer starts with the tag, while every later block, which holds the secret, still decrypts. Because the encryption is deterministic and the oracle also encrypts, a caller can likewise build a record main would accept under any name. A prefix refusal would pass its own test while the oracle stays open, so the patch is **dropped**.
- **The residual, stated exactly.** Any renderer, and anything that reaches the renderer's upstream bus (a compromised renderer, an extension-host path into it), can decrypt any `safeStorage` ciphertext of the app, Axis records included, and can mint a record of its choosing (for example its own provider key, to receive the user's prompts); it can also read and write the record files through upstream `localFilesystem`. This is accepted under EXT-1 (fully trusted extensions) and A10 (same-user code). Outside the app, a process of the same user can reach the key on some platforms (an unlocked Linux keyring, Windows DPAPI; the macOS keychain's access list prompts) [I].
- **EXT-4's control, read precisely.** The threat model's EXT-4 control ("credentials never go through `SecretStorage` or the `encryption` channel", `threat-model-phase1.md`) holds for how Axis stores and reads: main calls `safeStorage` directly and never uses the channel. It does **not** stop the channel from decrypting an Axis record; that part is this residual, recorded as RR-88 in `threat-model-phase1-residual-register.md` §1.6, with a note on the EXT-4 row of `threat-model-phase1.md`.
- **What closing it would need** (a named future option, not a claim): an authenticated envelope that the upstream oracle cannot forge, plus a refusal keyed on the ciphertext rather than the plaintext. It is a later decision, with its own review.
- **What this note does guarantee:** the broker never hands plaintext to a renderer or a log; each entry is bound to its name inside the plaintext (a moved record reads `corrupt`); a weak backend stores nothing (3.3). Gate lines 1 to 8 test exactly these.

### 3.3 Weak backends are refused (PRV-1) [D]

- **Backend report:** `safeStorage.isEncryptionAvailable()` and, on Linux, `safeStorage.getSelectedStorageBackend()`; macOS and Windows report `macos_keychain` and `windows_dpapi`, protection `os_protected`. On macOS and Windows the protection comes from the platform and this report only, never from a ciphertext prefix [I: Electron API names at the pin, as main's anchor uses them, `main-answers.md` §3.1].
- **Refused, with no consent path:** encryption not available, or a Linux `basic_text` or `unknown` backend. A store of **any** provider or integration credential answers `refused` with a fixed reason the UI shows; the connect UI explains what to do (install or unlock a keyring). The daemon's vault is created with `weakPolicy: "refuse"` [V, `vault/src/vault.ts` `VaultOptions.weakPolicy`], so the consent path the vault supports is never offered. **Decided** by the project lead on 2026-11-22 under the owner's delegation (recorded in `owner-decisions-2026-11-21.md` §6b): no consent path for a weak backend in 4a; revisited only on an explicit owner decision.
- **The ciphertext is checked, not only the report, on Linux only.** The renderer can call `setUsePlainTextEncryption` (section 2) and a keyring can stop between calls, so after `encryptString` main checks the ciphertext itself **when the platform is Linux**: a `v10` prefix (the hardcoded key) is refused and nothing is written; only `v11` (a keyring key) is stored [I: Chromium `os_crypt` internals, unverified in this repository; `anthropic-adapter.md` §10.3]. On macOS and Windows a `v10`-style prefix is the normal protected format, so the prefix rule never applies there. On Linux, on read, the same prefix decides the protection `get` and `meta` report, so a weak copy is shown as weak after a restart with nothing persisted about it.
- **A renderer can block every store for the session** by calling `setUsePlainTextEncryption`: accepted as a denial of service, not patched. Nothing is stored in plain text because of the ciphertext check; the user sees "credential storage unavailable".

### 3.4 The control messages [D]

Daemon → main requests, each with a `requestId`, strict schemas, closed types; main → daemon answers. They are the D1.6 privileged port: no renderer can send or read them.

| Request | Payload | Answer |
|---|---|---|
| `secrets.info` | none | `{ backend, protection, available }` |
| `secrets.put` | `{ name, secret, meta }` | `{ landedOn: { backend, protection } }` or an error |
| `secrets.get` | `{ name }` | `{ secret, meta }` with `meta.protection` from the ciphertext, or `not_found` |
| `secrets.meta` | `{ name }` | `{ meta }` (no decryption) or `not_found` |
| `secrets.remove` | `{ name }` | `{ removed }` |
| `secrets.list` | none | `{ entries: [{ name, meta }] }`, at most 256 |

- **Names** are validated by main against the same rule as the vault (and the 100-character cap): main serves whatever valid name the daemon asks for, and binding a purpose to an entry kind stays in the vault (ADR 0009 decision 5), so a daemon bug asking for another entry is the vault's to refuse, not main's.
- **Bounds:** one request per name at a time: a second request for the same name **queues** behind the first (main keeps at most 4 queued in all and refuses more with `failed`), so the vault's rollback `remove` after a timed-out `put` waits for it rather than failing at once. Main answers within 5 s, and within 60 s for `get` and `put` on macOS and Linux, where the keychain or keyring may prompt for an unlock [I]; on Windows DPAPI does not prompt and the 5 s budget applies. The daemon side waits **65 s** for `get` and `put` and 10 s for the rest, so main always answers or gives up first; silence is a `backend_failed` [V for the mapping, `VaultError`]. The vault's `rollbackTimeoutMs` (default 5 s) is raised to 65 s in this wiring, so a rollback of a slow `put` is not cut short. At most 8 requests are outstanding in all (running, waiting, and timed-out operations not yet settled); more answer `failed` at once. Each request's budget starts when main accepts it, so a waiting request answers at its own deadline and leaves the queue. A running operation keeps its name until it settles, so a late `put` never lands after a later request for the same name. **A `failed` answer to `put` therefore means "unknown"**: the late operation may still write the record, and the vault does not remove it (`vault.ts` reports a failed store and keeps nothing else). PV-N0c's daemon backend must treat it as unknown and reconcile with `get` or `remove`. At most 2 file operations run at once (a hung one pins a thread of the 4-thread pool main shares), at most 4 wait and 6 are outstanding; `secrets.info` reads the cipher status only and never queues. **Residual:** a hung or very slow file system under `<base>` (or a same-user process acting on it) can jam the broker: every file request then answers `failed`, the vault reports `backend_failed` for that connection, and main logs `secret_jammed` once per episode; accepted under A10.
- **Closed errors:** `not_found`, `refused` (weak or unavailable backend), `corrupt`, `failed`. Never an exception text, a path or a value. Main logs closed event names only, as for the anchor.
- **What main must guarantee (handoff to PV-N0c-2).** The daemon's backend relies on these, and its tests model them in `testing/secrets-main.ts`; the real main proves each:
  1. One operation per name: a running operation keeps its name until its work settles, even after it answered `failed` at its budget, so a late `put` always lands before a later request for that name runs (the reconciling `get` depends on it).
  2. A request answered `failed` while it was still waiting never runs afterwards.
  3. `failed` is the only `put` answer that may mean "maybe written"; `refused`, `corrupt` and `not_found` mean nothing was written.
  4. The vault's backend contract: a `put` whose `meta.backend` or `meta.protection` is not where main would write is refused, never written (`vault/src/types.ts`, SF-2 of the vault).
  5. Each budget starts when main accepts the request; at most 4 wait and 8 are outstanding (timed-out operations that have not settled included); `info` never queues; at most 2 file operations run at once.
  6. `get`, `meta` and `list` report each entry's protection from its ciphertext, not from the metadata stored beside it.
  7. No shared object reference inside an answer (the channel refuses non-plain data).
- **The daemon side** is a `SecretBackend` over the control client (`daemon-host/src/secrets-backend.ts`), validating every answer field by field (the vault treats backend data as untrusted [V, `anthropic-adapter.md` §10.2]). The ADR 0003 sketch `secrets.decrypt(handle, purpose)` maps to `secrets.get { name }`: the purpose is checked and audited by the vault in the daemon, not by main.

### 3.5 Wiring [D]

- The daemon entry passes the control-channel backend to the composition (`composer.anthropic.backend`), and the integrations binding gets the same backend (PV-N1f). Until PV-N0c-2 this is behind a composition option that production does not set (§6.1).
- **Integration names.** The vault's name rule has no `:`, so an `integration:<id>` name would fail it. PV-N1c changes the rule (the `integration:` prefix plus the existing id rule, within the 100-character cap) together with the namespaces; until then no such entry can be stored. Independently, PV-N0c makes the startup listing tolerate a bad name: the vault's `list` throws on any bad name [V, `vault/src/vault.ts` `list`], so the daemon's control-channel backend filters the answer **before** the vault sees it, dropping each name that fails the vault's rule and reporting it with a closed event; one bad file never fails the whole list. Main's own name rule (3.1, 3.4) widens with the vault's in PV-N1c, or main's `list` would ignore integration entries.
- **At start** the daemon lists the entries and reveals each **provider** entry once with `validate_connection`, so the redactor knows every stored key before any request (`anthropic-adapter.md` §10.2, `knownSecrets`); a failure leaves that connection unusable, never the daemon. Each reveal is audited, one row per provider entry per start: that volume is accepted. Integration entries are **not** revealed at start; PV-N1f registers them with the redactor when it first reads them.
- **Out of scope:** storing a key over the bridge (the "connect" flow with its tier and dialog), the consent grantor, and the UI; separate tickets.

## 4. Threats

| ID | Threat | Control |
|---|---|---|
| SB-1 | A renderer decrypts an Axis record, or mints one with its own key, through upstream's `encryption` channel | **Accepted residual** under EXT-1 and A10 (3.2); a prefix refusal cannot work on unauthenticated CBC. Closing it is a later decision (an authenticated envelope) |
| SB-2 | A credential is stored under the hardcoded Linux key | Report check and `v10` ciphertext check on every write; weak backends refused with no consent path (3.3) |
| SB-3 | A record moved between entries, truncated or swapped | Framed plaintext with the name; strict record; atomic writes. A same-user **rollback to an older record** of the same entry is accepted under A10: the user's own files are writable by the user's code |
| SB-4 | A hung keyring stalls the daemon | Bounded in-flight requests, per-request timeouts (daemon 65 s > main 60 s), failure confined to the one connection |
| SB-5 | A plaintext reaches a log or error | Closed errors and event names in main and the daemon backend; the vault's existing redaction |
| SB-6 | A keyring disabled or locked after secrets were stored | `get` answers `failed`, the connection shows "needs reconnect"; never a plaintext fallback, never a silent delete |
| SB-7 | A symlinked or loosely permitted secrets folder or entry file | `lstat` checks of the folder (real directory, owner, `0700`), no-follow opens of `0600` regular entry files; Windows inherits the profile ACL |
| SB-8 | Leftover temporary files after a crash | Removed at main's start; never read as records |
| SB-9 | Plaintext in a crash dump or diagnostic report of main or the daemon | Plaintext lives only for one request in main and per request in the daemon; crash reporting stays off for Axis processes and the threat model's crash-dump check applies [I: the dump check is the threat model's, not re-run here] |
| SB-10 | A renderer blocks every store with `setUsePlainTextEncryption` | Accepted denial of service (3.3); nothing is stored in plain |
| SB-11 | A daemon bug asks for another entry's name | Main validates names; the vault binds purposes to entry kinds (ADR 0009) |

## 5. Gate lines

1. In a built app, a key stored through the broker is read back by the providers binding, and no file under `<base>/daemon` or the journal holds it in any form; no renderer-visible state carries it.
2. Each record file is `0600` in a `0700` folder; a crash during a write leaves the old record or the new one, never a mix; leftover temporary files are gone after a restart.
3. A record copied to another entry's file name, or with a changed frame, reads `corrupt`.
4. With Linux `basic_text`, or `setUsePlainTextEncryption(true)` called from a renderer before a store, the store is refused and nothing is written; the UI shows the reason.
5. On Linux, a `v10` record placed by hand is reported with protection `none` and refused by `reveal` under the vault's rules; on macOS and Windows the prefix is never used to judge protection.
6. A hung `secrets.get` fails that request within its timeout and leaves other connections usable; a locked keyring after storing gives "needs reconnect", and the record is still there.
7. No log line or error in main or the daemon carries a canary secret.
8. Every control answer that is malformed or oversized is a `backend_failed`, never a partial value; a symlinked folder or entry file, or a folder with another mode, makes every request `failed`; a file with a non-canonical hex name is ignored by `list`, and a bad name in the startup list is skipped and reported.

## 6. Slices

| Slice | Content | Size | Proves |
|---|---|---|---|
| **PV-N0a** | Control schemas for the six requests and answers; the main-side pure module (folder checks, file names, record format, framing, atomic store, temporary-file cleanup, prefix check, bounds, closed errors) under `daemon-host/src/main/`, tested with a fake cipher and a real temporary directory | M | 2, 3, 4 (logic), 5, 7, 8 |
| **PV-N0c-1** | The daemon side, behind a composition option that is off in production (§6.1): the `secrets.*` requests on the control client (timeouts, field validation, bounds), the `SecretBackend` over it, `weakPolicy: "refuse"` and the raised rollback timeout, the provider reveal gate (§6.1), one backend for both bindings, the startup reveal with a tolerant list, and the test supervisor's answers | M | 5 (the vault's refusal), 6, 7 and 8, at daemon level |
| **PV-N0c-2** | Main's adapter in the own shell's main (ADR 0011): `safeStorage`, paths and folder modes, with source pins; main answers `secrets.*`; the one-line flip that turns the option on in the entry | S to M | 1 to 5 in a built app (4 as restated in §6.1), and main's share of 7 before the flip |

Each is a large-builder slice with an independent security review and mutation testing of the refusal paths; PV-N0c-1 follows PV-N0a, and PV-N0c-2 follows PV-N0c-1 and the own shell's main. Revision 1's PV-N0b (the upstream patch) is dropped with section 3.2.

### 6.1 The split under ADR 0011 (revision 3) [D]

**Why.** Revision 2 put the Electron adapter in the Code OSS overlay (`axisMainPorts.ts`). ADR 0011 replaces the Code OSS shell. The overlay's adapters are rewritten in the own shell's main (Decision 4), and no new overlay work is done. So the adapter moves to PV-N0c-2, and PV-N0c-1 builds everything on the daemon side that does not need it.

**PV-N0c-1 changes no production behaviour.**
- The broker path is built behind one composition option. The option is off by default, and the daemon entry does not set it. A test pins that, as `entry.ts` is pinned for the integrations seam (`net-read-slice.md` §7).
- **With the option off,** which is production until PV-N0c-2, the composition is exactly what it is today:
  - no provider backend is built, so the composer serves the mock only;
  - the integrations binding has no backend: `list` and `status` show `available`, `read` is `not_connected`, and nothing is revealed or sent;
  - no `secrets.*` request is ever sent.
- **With the option on** (tests only, until the flip):
  - the composition builds the control-channel backend once, and hands the same backend to the providers binding and the integrations binding;
  - it runs the startup reveal of §3.5.
- **What it proves, at daemon level** (with the test supervisor answering `secrets.*` from an in-memory store):
  - gate line 6: a hung `get` fails within its timeout, and other connections stay usable;
  - gate line 7: no log line or error carries a canary;
  - gate line 8: a malformed or oversized answer is `backend_failed`, and a bad name in the startup list is skipped and reported;
  - gate line 5, the vault's refusal (the provider reveal gate below);
  - the read slice's canary test, run again with the token reaching the vault through the broker path, not a test backend;
  - zero sends with the option off, shown by behaviour in the real default composition as well as by the entry pin. The test must fail if the backend's construction or the startup reveal moves outside the option's guard.

**The provider reveal gate (PV-N0c-1).**
- **A pre-existing gap, fixed here.** `weakPolicy` governs stores, not reveals. The vault checks an entry's own metadata on reveal only for integration purposes (PV-N1f). So a provider entry whose stored metadata reports protection `none`, such as a Linux `v10` record that main truthfully reports as `none` (§3.3, gate 5), is returned today to both `validate_connection` at startup and `provider_request`.
- **The change.** The broker wiring applies the same same-read check to provider reveals: the metadata of the `get` result that carries the secret, against the current backend, refused with `weak_entry`. It covers startup validation and normal provider use. The backend keeps reporting each entry's real protection, and the integrations mapping of `weak_entry` (`needs_reconnect`) is unchanged.
- **The consent path.** A weak provider entry stored with consent is no longer revealed under the broker wiring. This matches §3.3 and §7: there is no consent path in 4a.
- **Tests:**
  - a test supervisor case that answers a provider entry with protection `none`: the startup validation and a provider request are both refused, and the key is never registered or sent;
  - a mutant that removes the refusal must fail it.
- The real Linux `v10`-to-provider refusal stays PV-N0c-2's built-app evidence.

**Other N0c-1 checkpoints** (from the design review; not new decisions):
- **Timeouts and limits.** Silence is a fixed `backend_failed`. A timeout, an abort or a dispose clears its pending entry, timer and listener. A late answer is ignored, and its id is never reused. The secrets limit of 8 outstanding requests is its own, not the client's general pending limit.
- **A `put` that failed or timed out is "unknown"** (§3.4). Reconciliation, same-name ordering and failure containment are tested with delayed writes, not inferred from the timer settings.
- **The tolerant startup list** cannot reuse the strict whole-list answer schema (`secrets-messages.ts`). It filters bad names first, and still refuses oversized or malformed metadata.

**PV-N0c-2: the flip.**
- Main's adapter in the own shell answers `secrets.*`.
- The same pull request turns the option on in the entry: a one-line change, reviewed with the adapter.
- It proves gate lines 1 to 5 in a built app. Gate 4 is proven as restated below.
- **Main's share of gate 7 is a prerequisite of the flip.** A canary is run through the real main-to-daemon path, capturing main's diagnostics and errors as well as the daemon's logs. It covers a cipher failure and late or failing answers. A mutant that leaks the canary at the main adapter's boundary must fail. N0c-1's daemon-level proof and N0a's pure-module tests stay; they do not exercise this adapter.
- **Gate 4 in the own shell.** The own renderer has no upstream `encryption` channel, so the `setUsePlainTextEncryption(true)` case cannot be run as written. Instead:
  - the real Linux `basic_text` refusal is kept: the store is refused, nothing is written, and the UI shows the reason;
  - a test shows that the own renderer cannot reach the mode-switch API (no preload entry or channel exposes it);
  - the refusal after a `v10` report is exercised through a main-side test seam, or kept as N0a's logic evidence.

  No production renderer API is added for this test.
- Until it lands, no production code path reads a key through the broker, and the integrations read stays `not_connected`.

**Gate lines by slice:**

| Gate | Evidence |
|---|---|
| 1 | N0c-2: a built-app store read back by the providers binding; no daemon file, journal or renderer state holds it |
| 2 | N0a: file, atomic-write and cleanup logic. N0c-2: the real paths, modes and restart |
| 3 | N0a: frame and name binding. N0c-2: the real cipher and app path |
| 4 | N0a: weak and prefix refusal logic. N0c-2: the Linux built-app refusal and its visible reason, restated as above |
| 5 | N0a: the prefix reported truthfully. N0c-1: the vault's provider reveal gate. N0c-2: the real Linux, macOS and Windows behaviour |
| 6 | N0c-1: a bounded hung `get` with other connections usable, and a locked-after-store answer giving "needs reconnect" with the record kept, at daemon level. The test supervisor is not a real keyring |
| 7 | N0a: main's pure-module errors and events. N0c-1: the daemon's logs and errors. N0c-2: main's adapter, before the flip |
| 8 | N0a: folder, file and canonical-name logic. N0c-1: answer validation, the oversized refusal and the tolerant startup list. N0c-2: the adapter's path selection, with gates 1 and 2 |

**EXT-4.** The residual of §3.2 (any renderer can decrypt any `safeStorage` ciphertext through upstream's `encryption` channel) stands only while the Code OSS shell ships. The own shell's renderer has no such channel (ADR 0011 Decision 5 item 1), so PV-N0c-2's built-app evidence is taken in a shell without it.

**Order.** PV-N0c-1 touches the vault and the bindings, as the integrations read slice (PV-N1f) does. Its code starts after that slice's review is closed.

## 7. Decided items

- **PRV-1 consent for weak backends:** none in 4a (3.3). A `basic_text`, unavailable or unknown backend refuses to store any provider or integration credential, with a user-visible reason. Decided by the project lead on 2026-11-22; revisited only on an explicit owner decision.
- **EXT-4 for Axis records:** an accepted residual (3.2), decided by the project lead on 2026-11-22 after design review 1 found the prefix refusal unsound.
